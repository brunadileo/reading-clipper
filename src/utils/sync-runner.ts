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
import { finishSupported, ownPageSender, runFinish, trustedSender } from './waiting-runner';
import { isEnabled, loadFinishState } from './waiting-finisher';
import {
	intervalMinutes, isFrequency, loadSchedule, nextDueAt, runSequence, saveSchedule,
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
				source: service,
			});
			return postCapture(body, settings.captureUrl, settings.token);
		},
	};
}

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
		: `${r.finished} finished, ${r.membersOnly} members only, ${r.unreadable} could not be opened${r.stopped ? `, stopped (${r.stopped})` : ''}`;

/** The jobs in their fixed order. Medium goes after Instagram later. */
function buildJobs(manual: boolean): SyncJob[] {
	return [
		{
			id: 'finish',
			name: 'Finish waiting articles',
			enabled: async () => finishSupported() && !!(await loadReadingSettings()).token && isEnabled(await loadFinishState(store), true),
			run: async () => finishLine(await runFinish(manual ? 'now' : 'alarm')),
		},
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
	];
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
	const result = await runSequence(buildJobs(trigger === 'now'), sequenceDeps, trigger);
	if (result.skipped !== 'busy') await scheduleAlarm(true, result.skipped === 'nothing-to-run');
	return result;
}

/** Load older (one service) or the web's Finish now (job 1 only), under the same lock. */
export function runOne(id: 'finish' | 'substack' | 'instagram', trigger: 'older' | 'finish-now') {
	const job = buildJobs(false).find((j) => j.id === id)!;
	if (trigger === 'finish-now') {
		// Works even with the finisher's own switch off, as Finish now always did.
		job.enabled = async () => finishSupported();
		job.run = async () => finishLine(await runFinish('now'));
	} else if (id === 'substack') {
		job.run = async () => {
			const r = await runSubstackSync(makeDeps('substack'), 'older');
			return `${r.sent} saved, ${r.failed} could not be read${r.stopped ? `, stopped (${r.stopped})` : ''}`;
		};
	} else if (id === 'instagram') {
		job.run = async () => {
			const r = await runInstagramSync(makeDeps('instagram'), 'older');
			return r.stopped ? (r.message ?? `stopped (${r.stopped})`) : `${r.sent} saved${r.message ? `. ${r.message}` : ''}`;
		};
	}
	return runSequence([job], sequenceDeps, trigger, { recordRun: false });
}

export function initSyncRunner(): void {
	const api = alarms();
	for (const name of OLD_ALARMS) void api?.clear(name);
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
		void scheduleAlarm(false);
	});

	browser.runtime.onMessage.addListener((request: unknown, sender: unknown, sendResponse: (r?: any) => void): true | undefined => {
		const req = request as { action?: string; service?: SyncService; enabled?: boolean; kind?: string; frequency?: unknown };
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
		// The lazyreader.app relay is allowed here and runs job 1 only.
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
		if (req.action === 'syncSetEnabled' && (req.service === 'substack' || req.service === 'instagram')) {
			if (!fromSettings) return undefined;
			const service = req.service;
			return reply((async () => {
				const state = await loadState(store, service);
				state.enabled = !!req.enabled;
				await saveState(store, service, state);
			})());
		}
		if (req.action === 'syncRun' && req.kind === 'older' && (req.service === 'substack' || req.service === 'instagram')) {
			return fromSettings ? reply(runOne(req.service, 'older')) : undefined;
		}
		return undefined;
	});
}
