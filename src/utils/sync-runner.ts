// Browser wiring for the one clipper sync schedule (READ-181 choice 26, over
// READ-37 Substack, READ-39 Instagram and the waiting-article finisher).
// Runs in the background worker only. The rules live in sync-schedule.ts,
// substack-sync.ts, instagram-sync.ts and waiting-finisher.ts; this file
// connects them to chrome.storage.local, ONE chrome.alarm and the idle event.
import browser from './browser-polyfill';
import { buildReadingCaptureBody, postCapture } from './reading-sender';
import { DEFAULT_READING_LANE, loadReadingSettings } from './storage-utils';
import { loadState, saveState, type SyncDeps, type SyncService } from './sync-core';
import { runSubstackSync } from './substack-sync';
import { runInstagramSync } from './instagram-sync';
import { applyYoutubeConfig, checkPlaylist, extractPlaylistId, hasSource, runYoutubeSync, type YoutubeConfigChange, type YoutubeDeps } from './youtube-sync';
import { readYouTubeTranscript } from './youtube-transcript';
import { buildAuthorization } from './sapisid-hash';
import { runMediumSync, type MediumRunResult } from './medium-sync';
import { closeLeftoverMediumWindow, makeMediumDeps, releaseMediumOffscreen } from './medium-runner';
import { finishSupported, ownPageSender, runFinish, trustedSender } from './waiting-runner';
import { isEnabled, loadFinishState } from './waiting-finisher';
import {
	JOB_ORDER, intervalMinutes, isFrequency, loadSchedule, manualOnly, nextDueAt, runSequence, saveSchedule,
	type SequenceTrigger, type SyncJob,
} from './sync-schedule';

export const SYNC_ALARM = 'clipper-sync';
// Alarms from before choice 26, cleared on start so nothing runs on its own.
const OLD_ALARMS = ['substack-sync', 'finish-waiting'];
export const IDLE_INTERVAL_SECONDS = 15 * 60;

const store = {
	async get(key: string) {
		const r = await browser.storage.local.get(key);
		return r[key];
	},
	async set(key: string, value: any) {
		await browser.storage.local.set({ [key]: value });
	},
};

function makeDeps(service: SyncService): SyncDeps {
	return {
		store,
		fetchFn: (input, init) => fetch(input, init),
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		now: () => Date.now(),
		send: async (post, text) => {
			const settings = await loadReadingSettings();
			const body = buildReadingCaptureBody({
				url: post.url,
				lane: DEFAULT_READING_LANE,
				title: post.title,
				siteName: post.siteName,
				text: text ?? '',
				// source stays for a server that predates `via`. YouTube has no `via`
				// value yet: the server shows it as a token save (plan choice 5).
				source: service,
				via: service === 'youtube' ? undefined : `${service}-saved`,
			});
			return postCapture(body, settings.captureUrl, settings.token);
		},
	};
}

/**
 * YouTube also reads transcripts in the browser (credentials omit) and, for the
 * paging call only, builds the SAPISIDHASH header from the SAPISID cookie. The
 * cookie is read here, in the worker, and only the header leaves it, only to
 * youtube.com. Without the optional `cookies` permission chrome.cookies is
 * absent and the paging call goes without the header.
 */
function makeYoutubeDeps(): YoutubeDeps {
	const base = makeDeps('youtube');
	return {
		...base,
		readTranscript: (videoId) => readYouTubeTranscript(base.fetchFn, videoId),
		authHeader: () => buildAuthorization(typeof chrome !== 'undefined' ? (chrome as any).cookies : undefined, Date.now()),
	};
}

const SYNC_SERVICES: SyncService[] = ['substack', 'instagram', 'youtube', 'medium'];

const alarms = () => (typeof chrome !== 'undefined' ? (chrome as any).alarms : undefined);

const sequenceDeps = {
	store,
	now: () => Date.now(),
	sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

const isOn = async (service: SyncService) => (await loadState(store, service)).enabled;

const finishLine = (r: Awaited<ReturnType<typeof runFinish>>) =>
	r.skipped
		? `skipped (${r.skipped})`
		: `${r.finished} finished, ${r.membersOnly} members only, ${r.unreadable} could not be opened${r.transcriptsBlocked ? ', YouTube slowed transcripts down' : ''}${r.stopped ? `, stopped (${r.stopped})` : ''}`;

async function runMedium(kind: 'manual' | 'older'): Promise<MediumRunResult> {
	try {
		return await runMediumSync(makeMediumDeps(makeDeps('medium')), kind);
	} finally {
		await releaseMediumOffscreen();
	}
}

const mediumLine = (r: MediumRunResult) =>
	r.stopped
		? (r.message ?? `stopped (${r.stopped})`)
		: `${r.sent} saved${r.linkOnly ? `, ${r.linkOnly} as links to finish` : ''}${r.message ? `. ${r.message}` : ''}`;

/**
 * The jobs in their fixed order (JOB_ORDER): Substack, Instagram, medium, finish
 * waiting, then YouTube (READ-38 choice 4). Medium (READ-36) runs only from a
 * button, never from the alarm, idle or startup. New jobs go after the existing ones. Finish stays ahead of YouTube, so a video the server parked as
 * "Waiting for transcript" is filled on the next run.
 */
function buildJobs(manual: boolean): SyncJob[] {
	const jobs: SyncJob[] = [
		{
			id: 'substack',
			name: 'Substack',
			enabled: () => isOn('substack'),
			run: async () => {
				const r = await runSubstackSync(makeDeps('substack'), manual ? 'manual' : 'alarm');
				const st = await loadState(store, 'substack');
				if (st.signedOut) return 'sign in to Substack in this browser';
				if (r.stopped) return st.lastError ?? `stopped (${r.stopped})`;
				return `${r.sent} saved, ${r.failed} could not be read`;
			},
		},
		{
			id: 'instagram',
			name: 'Instagram',
			enabled: () => isOn('instagram'),
			run: async () => {
				// Scheduled runs lean on the shared one-hour floor when the previous
				// Instagram attempt was scheduled too (see instagram-sync.ts).
				const r = await runInstagramSync(makeDeps('instagram'), manual ? 'sync' : 'scheduled');
				if (r.stopped) return r.message ?? `stopped (${r.stopped})`;
				return `${r.sent} saved`;
			},
		},
		{
			id: 'medium',
			name: 'Medium',
			// Button-only (READ-36 choice 4): Sync now and the row's own Sync, never the timer.
			enabled: manualOnly(manual, () => isOn('medium')),
			run: async () => mediumLine(await runMedium('manual')),
		},
		{
			id: 'finish',
			name: 'Finish waiting articles',
			enabled: async () => finishSupported() && !!(await loadReadingSettings()).token && isEnabled(await loadFinishState(store), true),
			run: async () => finishLine(await runFinish(manual ? 'now' : 'alarm')),
		},
		{
			id: 'youtube',
			name: 'YouTube',
			enabled: () => isOn('youtube'),
			run: async () => {
				const r = await runYoutubeSync(makeYoutubeDeps(), manual ? 'manual' : 'alarm');
				const st = await loadState(store, 'youtube');
				if (r.stopped === 'no-source') return 'choose Watch later or a playlist in Settings';
				if (st.signedOut) return 'sign in to YouTube in this browser';
				if (r.stopped) return st.lastError ?? `stopped (${r.stopped})`;
				return st.lastResult ?? `${r.sent} saved`;
			},
		},
	];
	return jobs.sort((a, b) => JOB_ORDER.indexOf(a.id as (typeof JOB_ORDER)[number]) - JOB_ORDER.indexOf(b.id as (typeof JOB_ORDER)[number]));
}

/** The finish job alone, rerun once at the end of a sequence a push wake found busy. */
function wakeJob(): SyncJob {
	return {
		id: 'finish',
		name: 'Finish waiting articles',
		enabled: async () => true,
		run: async () => finishLine(await runFinish('wake-rerun')),
	};
}

/**
 * One alarm, set to the next due time. Manual frequency means no alarm at all.
 * fullInterval pushes it a whole interval out (used when nothing was switched
 * on, so an overdue clock does not re-fire the alarm every 30 seconds).
 */
export async function scheduleAlarm(force: boolean, fullInterval = false): Promise<void> {
	const api = alarms();
	if (!api) return;
	if (!force && (await api.get(SYNC_ALARM))) return;
	await api.clear(SYNC_ALARM);
	const state = await loadSchedule(store);
	const now = Date.now();
	let due = nextDueAt(state.frequency, state.lastRunAt, now);
	if (due === null) return;
	if (fullInterval) due = Math.max(due, now + (intervalMinutes(state.frequency) ?? 0) * 60_000);
	api.create(SYNC_ALARM, { when: Math.max(due, now + 1000) });
}

/** The whole sequence (scheduled, catch-up or Sync now), then the next alarm. */
export async function runAll(trigger: SequenceTrigger) {
	const result = await runSequence(buildJobs(trigger === 'now'), sequenceDeps, trigger, { wakeJob: wakeJob() });
	if (result.skipped !== 'busy') await scheduleAlarm(true, result.skipped === 'nothing-to-run');
	return result;
}

/** Load older (one service) or the web's Finish now (the finish job only), under the same lock. */
export function runOne(id: 'finish' | 'substack' | 'instagram' | 'medium' | 'youtube', trigger: 'older' | 'finish-now' | 'finish-push' | 'now') {
	const job = buildJobs(false).find((j) => j.id === id)!;
	if (trigger === 'finish-now') {
		// Works even with the finisher's own switch off, as Finish now always did.
		job.enabled = async () => finishSupported();
		job.run = async () => finishLine(await runFinish('now'));
	} else if (trigger === 'finish-push') {
		// A wake from the server: finish only, no gap; keeps the finisher's switch.
		job.run = async () => finishLine(await runFinish('push'));
	} else if (id === 'substack') {
		job.run = async () => {
			const r = await runSubstackSync(makeDeps('substack'), 'older');
			return `${r.sent} saved, ${r.failed} could not be read${r.stopped ? `, stopped (${r.stopped})` : ''}`;
		};
	} else if (id === 'medium') {
		// Load older, and the Medium row's own Sync: Medium alone, under the shared lock.
		job.enabled = () => isOn('medium');
		job.run = async () => mediumLine(await runMedium(trigger === 'older' ? 'older' : 'manual'));
	} else if (id === 'instagram') {
		job.run = async () => {
			const r = await runInstagramSync(makeDeps('instagram'), 'older');
			return r.stopped ? (r.message ?? `stopped (${r.stopped})`) : `${r.sent} saved${r.message ? `. ${r.message}` : ''}`;
		};
	} else if (id === 'youtube') {
		job.run = async () => {
			const r = await runYoutubeSync(makeYoutubeDeps(), 'older');
			const st = await loadState(store, 'youtube');
			if (r.stopped === 'signed-out') return 'sign in to YouTube in this browser';
			if (r.stopped) return st.lastError ?? `stopped (${r.stopped})`;
			return st.lastResult ?? `${r.sent} saved`;
		};
	}
	return runSequence([job], sequenceDeps, trigger, { recordRun: false, wakeJob: wakeJob() });
}

export function initSyncRunner(): void {
	const api = alarms();
	for (const name of OLD_ALARMS) void api?.clear(name);
	void closeLeftoverMediumWindow();
	void scheduleAlarm(false);
	api?.onAlarm.addListener((alarm: { name: string }) => {
		if (alarm.name === SYNC_ALARM) void runAll('alarm');
	});
	// Catch-up: Chrome was closed when a run came due. runSequence ignores the
	// trigger unless a full interval has passed since the last run started.
	const idle = typeof chrome !== 'undefined' ? (chrome as any).idle : undefined;
	idle?.setDetectionInterval?.(IDLE_INTERVAL_SECONDS);
	idle?.onStateChanged?.addListener((state: string) => {
		if (state === 'active') void runAll('idle');
	});
	browser.runtime.onStartup?.addListener(() => {
		void scheduleAlarm(false).then(() => runAll('startup'));
	});
	browser.runtime.onInstalled.addListener(() => {
		// force: loadSchedule may just have moved Twice a day to Every hour (READ-247), so the old 12 h alarm must go.
		void scheduleAlarm(true);
	});

	browser.runtime.onMessage.addListener((request: unknown, sender: unknown, sendResponse: (r?: any) => void): true | undefined => {
		const req = request as { action?: string; service?: SyncService; enabled?: boolean; kind?: string; frequency?: unknown; input?: unknown; change?: unknown };
		if (!req || typeof req !== 'object') return undefined;
		// Settings opens in a tab, so the page URL (not sender.tab) marks our own pages.
		const fromSettings = ownPageSender(sender);
		const reply = (p: Promise<unknown>) => {
			p.then((result) => sendResponse({ ok: true, result })).catch((e) => sendResponse({ ok: false, error: String(e) }));
			return true as const;
		};

		if (req.action === 'syncNow') {
			return fromSettings ? reply(runAll('now')) : undefined;
		}
		// The lazyreader.app relay is allowed here and runs the finish job only.
		if (req.action === 'finishNow') {
			return trustedSender(sender) ? reply(runOne('finish', 'finish-now')) : undefined;
		}
		if (req.action === 'syncSetFrequency') {
			if (!fromSettings || !isFrequency(req.frequency)) return undefined;
			const frequency = req.frequency;
			return reply((async () => {
				const state = await loadSchedule(store);
				state.frequency = frequency;
				await saveSchedule(store, state);
				await scheduleAlarm(true);
			})());
		}
		if (req.action === 'syncSetEnabled' && SYNC_SERVICES.includes(req.service as SyncService)) {
			if (!fromSettings) return undefined;
			const service = req.service as SyncService;
			return reply((async () => {
				const state = await loadState(store, service);
				state.enabled = !!req.enabled;
				await saveState(store, service, state);
			})());
		}
		if (req.action === 'syncRun' && req.kind === 'older' && SYNC_SERVICES.includes(req.service as SyncService)) {
			return fromSettings ? reply(runOne(req.service as SyncService, 'older')) : undefined;
		}
		// The Medium row's own Sync button: Medium alone, never from the timer.
		if (req.action === 'syncRun' && req.kind === 'now' && req.service === 'medium') {
			return fromSettings ? reply(runOne('medium', 'now')) : undefined;
		}
		// YouTube settings: check a pasted playlist (title or the reason it fails).
		if (req.action === 'youtubeCheckPlaylist' && typeof req.input === 'string') {
			if (!fromSettings) return undefined;
			const input = req.input;
			return reply(checkPlaylist(makeDeps('youtube'), input));
		}
		// YouTube settings: Watch later, the checked playlist, Include Shorts. Not while a run holds the state.
		if (req.action === 'youtubeSetConfig' && req.change && typeof req.change === 'object') {
			if (!fromSettings) return undefined;
			const change = req.change as YoutubeConfigChange & { playlistInput?: string };
			return reply((async () => {
				const state = await loadState(store, 'youtube');
				if (state.running && Date.now() - (state.lastAttemptAt ?? 0) < 15 * 60 * 1000) throw new Error('A YouTube sync is running. Try again when it ends.');
				const next: YoutubeConfigChange = { watchLater: change.watchLater, includeShorts: change.includeShorts };
				// A playlist is accepted only as a checked id plus its title; clearing sends null.
				if (change.playlist === null) next.playlist = null;
				else if (change.playlist && extractPlaylistId(change.playlist.id) && typeof change.playlist.title === 'string') next.playlist = { id: change.playlist.id, title: change.playlist.title };
				applyYoutubeConfig(state, next);
				await saveState(store, 'youtube', state);
				return { hasSource: hasSource(state) };
			})());
		}
		return undefined;
	});
}
