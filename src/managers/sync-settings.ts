// Settings section "Sync (experimental)": one schedule setting with one Sync now
// button and one status line, then a switch per service with its own Sync button
// and Load older. Turning a switch on asks Chrome for site access to that service
// only (optional_host_permissions), then shows any cost question; turning it off
// keeps the permission but stops the sync. Text is plain English, not i18n keys.
import browser from '../utils/browser-polyfill';
import { setText } from '../utils/set-text';
import { loadState, type SyncService, type SyncState } from '../utils/sync-core';
import { creditWarning, IG_FIRST_RUN_POSTS } from '../utils/instagram-sync';
import { costWarning, extractPlaylistId, FIRST_RUN_VIDEOS, hasSource, watchLaterNeverRan } from '../utils/youtube-sync';
import { MEDIUM_RUN_POSTS } from '../utils/medium-sync';
import { offscreenSupported } from '../utils/offscreen-doc';
import { IS_STORE_BUILD } from '../utils/store-build';
import { describeScheduleStatus, isFrequency, isRunning, loadSchedule } from '../utils/sync-schedule';

const ORIGINS: Record<SyncService, string[]> = {
	substack: ['https://substack.com/*', 'https://*.substack.com/*'],
	instagram: ['https://www.instagram.com/*', 'https://i.instagram.com/*'],
	youtube: ['https://www.youtube.com/*'],
	medium: ['https://medium.com/*', 'https://*.medium.com/*'],
};
// YouTube also needs the optional `cookies` permission (for the SAPISIDHASH header
// of the paging call). It is asked in the same prompt as the site access.
// Shown before the first run and before Load older (READ-36 choice 12).
const MEDIUM_COST_WARNING = `Up to ${MEDIUM_RUN_POSTS} articles will each get a summary from your OpenRouter key.`;
const PERMISSIONS: Partial<Record<SyncService, string[]>> = { youtube: ['cookies'] };
const NAMES: Record<SyncService, string> = { substack: 'Substack', instagram: 'Instagram', youtube: 'YouTube', medium: 'Medium' };

const store = {
	async get(key: string) {
		const r = await browser.storage.local.get(key);
		return r[key];
	},
	async set(key: string, value: any) {
		await browser.storage.local.set({ [key]: value });
	},
};

/** Pure: the status line for a service's saved state. */
export function describeSyncStatus(service: SyncService, s: SyncState, now: number): string {
	const name = NAMES[service];
	if (!s.enabled) return 'Off';
	if (service === 'youtube' && !hasSource(s)) return 'Turned on. Choose Watch later or a playlist below.';
	if (s.running && s.lastAttemptAt !== null && now - s.lastAttemptAt < 15 * 60 * 1000) return 'Syncing...';
	if (s.signedOut) return `Sign in to ${name} in this browser, then press Sync.`;
	if (s.lastError) return `Last sync failed: ${s.lastError}`;
	if (s.lastSuccess === null) {
		return service === 'medium'
			? 'Turned on. It only runs when you press Sync here or Sync now above.'
			: 'Turned on. Runs with the next sync, or press Sync.';
	}
	const mins = Math.max(0, Math.round((now - s.lastSuccess) / 60000));
	const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
	return `Last synced ${ago}${s.lastResult ? ` (${s.lastResult})` : ''}`;
}

/**
 * Pure: the cost question shown after Chrome grants site access, or null when
 * the service needs none. Medium: up to 100 summaries on the user's own key
 * (READ-36 choice 12). The first Instagram run is the costly one. YouTube asks
 * only while it has never run.
 */
export function switchOnQuestion(service: SyncService, youtubeNeverRan: boolean): string | null {
	if (service === 'medium') return `${MEDIUM_COST_WARNING}\n\nTurn Medium on?`;
	if (service === 'instagram') {
		const warning = creditWarning(IG_FIRST_RUN_POSTS);
		return warning ? `${warning}\n\nUp to ${IG_FIRST_RUN_POSTS} posts on the first sync. Turn Instagram on?` : null;
	}
	if (service === 'youtube' && youtubeNeverRan) return `${costWarning(FIRST_RUN_VIDEOS)}\n\nTurn YouTube on?`;
	return null;
}

// Read inside the click that turns YouTube on, where nothing can be awaited first.
let youtubeNeverRan = true;
let youtubeSavedPlaylist: string | null = null;
let youtubeWlNeverRan = true;

const YT_PLAYLIST_LINK = 'https://www.youtube.com/playlist?list=';

function refreshYoutubeExtras(state: SyncState): void {
	youtubeNeverRan = state.lastSuccess === null;
	youtubeSavedPlaylist = state.youtube?.playlistId ?? null;
	youtubeWlNeverRan = watchLaterNeverRan(state);
	const extras = document.getElementById('sync-youtube-extras');
	if (extras) extras.hidden = !state.enabled;
	const cfg = state.youtube;
	const wl = document.getElementById('sync-youtube-wl') as HTMLInputElement | null;
	const shorts = document.getElementById('sync-youtube-shorts') as HTMLInputElement | null;
	const input = document.getElementById('sync-youtube-playlist') as HTMLInputElement | null;
	const note = document.getElementById('sync-youtube-playlist-note');
	for (const [box, on] of [[wl, !!cfg?.watchLater], [shorts, !!cfg?.includeShorts]] as const) {
		if (!box) continue;
		box.checked = on;
		box.closest('.checkbox-container')?.classList.toggle('is-enabled', on);
	}
	if (input && document.activeElement !== input) input.value = cfg?.playlistId ? `${YT_PLAYLIST_LINK}${cfg.playlistId}` : '';
	if (note && cfg?.playlistId && cfg.playlistTitle) note.textContent = `Reading the playlist "${cfg.playlistTitle}".`;
}

async function refresh(service: SyncService): Promise<void> {
	const state = await loadState(store, service);
	if (service === 'youtube') refreshYoutubeExtras(state);
	const toggle = document.getElementById(`sync-${service}-toggle`) as HTMLInputElement | null;
	const status = document.getElementById(`sync-${service}-status`);
	const older = document.getElementById(`sync-${service}-older`) as HTMLButtonElement | null;
	if (toggle) {
		toggle.checked = state.enabled;
		toggle.closest('.checkbox-container')?.classList.toggle('is-enabled', state.enabled);
	}
	setText(status, describeSyncStatus(service, state, Date.now()));
	if (older) {
		if (service === 'youtube') {
			// Exhausted only when every chosen list has been read to its end.
			const c = state.youtube?.cursors;
			const lists = [state.youtube?.watchLater ? c?.wl : null, state.youtube?.playlistId ? c?.pl : null].filter(Boolean) as Array<{ exhausted: boolean; started: boolean }>;
			older.disabled = !state.enabled || state.running || lists.length === 0 || lists.every((l) => l.exhausted || !l.started);
		} else {
			older.disabled = !state.enabled || state.running || state.olderExhausted;
		}
		older.hidden = !state.enabled;
	}
	const run = document.getElementById(`sync-${service}-run`) as HTMLButtonElement | null;
	if (run) {
		run.disabled = state.running;
		run.hidden = !state.enabled;
	}
}

function setupService(service: SyncService): void {
	const toggle = document.getElementById(`sync-${service}-toggle`) as HTMLInputElement | null;
	const older = document.getElementById(`sync-${service}-older`) as HTMLButtonElement | null;
	const status = document.getElementById(`sync-${service}-status`);
	if (!toggle || !older) return;

	toggle.addEventListener('change', () => {
		const wantOn = toggle.checked;
		// permissions.request has to run inside the click, before any await or confirm:
		// Chrome's user activation lasts about 5 s (READ-250 choice 3). The cost
		// question comes after the grant.
		const permissions = PERMISSIONS[service];
		const granted: Promise<boolean> = wantOn
			? browser.permissions.request({ origins: ORIGINS[service], ...(permissions ? { permissions } : {}) } as any).catch(() => false)
			: Promise.resolve(true);
		void granted.then(async (ok) => {
			if (!ok) {
				toggle.checked = false;
				if (status) {
					status.textContent = service === 'youtube'
						? "YouTube sync needs access to YouTube's site and to your YouTube sign-in cookie in this browser. It stays off."
						: `${NAMES[service]} sync needs access to ${NAMES[service]}'s site. It stays off.`;
				}
				return;
			}
			if (wantOn) {
				const question = switchOnQuestion(service, youtubeNeverRan);
				// Declined: back off without enabling (the granted permission stays, harmlessly).
				if (question && !window.confirm(question)) {
					toggle.checked = false;
					return;
				}
			}
			await browser.runtime.sendMessage({ action: 'syncSetEnabled', service, enabled: wantOn });
			await refresh(service);
		});
	});

	older.addEventListener('click', async () => {
		if (service === 'medium' && !window.confirm(`${MEDIUM_COST_WARNING}\n\nLoad older saves?`)) return;
		if (service === 'instagram') {
			const warning = creditWarning(IG_FIRST_RUN_POSTS);
			if (warning && !window.confirm(`${warning}\n\nUp to ${IG_FIRST_RUN_POSTS} posts. Continue?`)) return;
		}
		older.disabled = true;
		if (status) status.textContent = 'Syncing...';
		try {
			const res: any = await browser.runtime.sendMessage({ action: 'syncRun', service, kind: 'older' });
			if (res?.result?.skipped === 'busy') {
				await refresh(service);
				if (status) status.textContent = 'A sync is already running. Try again when it ends.';
				return;
			}
			await refresh(service);
			const line = res?.result?.ran?.[0]?.message;
			if (line && status) status.textContent = line;
		} catch (e) {
			if (status) status.textContent = `Sync failed: ${e instanceof Error ? e.message : String(e)}`;
		}
	});

	if (service === 'youtube') setupYoutubeExtras(status);
	// Each row's own Sync button: that service alone, then the finish job.
	const run = document.getElementById(`sync-${service}-run`) as HTMLButtonElement | null;
	run?.addEventListener('click', async () => {
		if (service === 'medium' && !window.confirm(`${MEDIUM_COST_WARNING}\n\nSync Medium now?`)) return;
		run.disabled = true;
		if (status) status.textContent = 'Syncing...';
		try {
			const res: any = await browser.runtime.sendMessage({ action: 'syncRun', service, kind: 'now' });
			if (res?.result?.skipped === 'busy') {
				await refresh(service);
				if (status) status.textContent = 'A sync is already running. Try again when it ends.';
				return;
			}
			await refresh(service);
			const line = res?.result?.ran?.[0]?.message;
			if (line && status) status.textContent = line;
		} catch (e) {
			if (status) status.textContent = `Sync failed: ${e instanceof Error ? e.message : String(e)}`;
		}
	});

	void refresh(service);
}

function setupYoutubeExtras(status: HTMLElement | null): void {
	const wl = document.getElementById('sync-youtube-wl') as HTMLInputElement | null;
	const shorts = document.getElementById('sync-youtube-shorts') as HTMLInputElement | null;
	const input = document.getElementById('sync-youtube-playlist') as HTMLInputElement | null;
	const check = document.getElementById('sync-youtube-check') as HTMLButtonElement | null;
	const note = document.getElementById('sync-youtube-playlist-note');
	const say = (msg: string) => { if (status) status.textContent = msg; };
	const send = async (change: Record<string, unknown>) => {
		const res: any = await browser.runtime.sendMessage({ action: 'youtubeSetConfig', change });
		if (!res?.ok) throw new Error(String(res?.error ?? 'Could not save').replace(/^Error:\s*/, ''));
	};
	for (const [box, key] of [[wl, 'watchLater'], [shorts, 'includeShorts']] as const) {
		box?.addEventListener('change', async () => {
			// Ticking Watch later when it has never run starts a costly first read; confirm before any await.
			if (key === 'watchLater' && box.checked && youtubeWlNeverRan && !window.confirm(`${costWarning(FIRST_RUN_VIDEOS)}\n\nRead Watch later?`)) {
				box.checked = false;
				return;
			}
			try {
				await send({ [key]: box.checked });
			} catch (e) {
				box.checked = !box.checked;
				say(e instanceof Error ? e.message : String(e));
			}
			await refresh('youtube');
		});
	}
	check?.addEventListener('click', async () => {
		if (!input) return;
		// A new playlist is read on the next run, so the cost warning belongs here too.
		const newId = input.value.trim() ? extractPlaylistId(input.value) : null;
		if (newId && newId !== youtubeSavedPlaylist && !window.confirm(`${costWarning(FIRST_RUN_VIDEOS)}\n\nCheck and save this playlist?`)) return;
		check.disabled = true;
		try {
			// An empty field clears the playlist.
			if (!input.value.trim()) {
				await send({ playlist: null });
				if (note) note.textContent = 'No playlist chosen.';
			} else {
				if (note) note.textContent = 'Checking...';
				const res: any = await browser.runtime.sendMessage({ action: 'youtubeCheckPlaylist', input: input.value });
				const r = res?.result;
				if (!res?.ok || !r?.ok) {
					if (note) note.textContent = r?.message ?? 'Could not check the playlist.';
				} else {
					await send({ playlist: { id: r.id, title: r.title } });
					if (note) note.textContent = `Reading the playlist "${r.title}".`;
				}
			}
		} catch (e) {
			if (note) note.textContent = e instanceof Error ? e.message : String(e);
		} finally {
			check.disabled = false;
			await refresh('youtube');
		}
	});
}

async function refreshSchedule(): Promise<void> {
	const state = await loadSchedule(store);
	const select = document.getElementById('sync-frequency') as HTMLSelectElement | null;
	const status = document.getElementById('sync-schedule-status');
	const now = document.getElementById('sync-all-now') as HTMLButtonElement | null;
	const pip = document.getElementById('sync-pip');
	const freqHint = document.getElementById('sync-frequency-hint');
	const running = isRunning(state, Date.now());
	if (select && document.activeElement !== select) select.value = state.frequency;
	setText(status, describeScheduleStatus(state, Date.now()));
	if (now) now.disabled = running;
	if (pip) {
		// Grey before the first sync, pulsing amber while running, red when the last
		// summary reports a failure or stop, green otherwise.
		const failed = !!state.lastSummary && /failed|error|stopped \((?!too-soon)/i.test(state.lastSummary);
		pip.classList.toggle('lr-dot-amber', running);
		pip.classList.toggle('lr-dot-pulse', running);
		pip.classList.toggle('lr-dot-fail', !running && state.lastFinishedAt !== null && failed);
		pip.classList.toggle('lr-dot-ok', !running && state.lastFinishedAt !== null && !failed);
	}
	setText(freqHint, state.frequency === 'manual'
		? 'Runs only when you press Sync now.'
		: 'Runs while Chrome is open. If Chrome was closed when a sync was due, it runs once when you come back. A waiting article is tried at most once an hour.');
}

function setupSchedule(): void {
	const select = document.getElementById('sync-frequency') as HTMLSelectElement | null;
	const now = document.getElementById('sync-all-now') as HTMLButtonElement | null;
	const status = document.getElementById('sync-schedule-status');
	if (!select || !now) return;
	select.addEventListener('change', async () => {
		if (!isFrequency(select.value)) return;
		await browser.runtime.sendMessage({ action: 'syncSetFrequency', frequency: select.value });
		await refreshSchedule();
	});
	now.addEventListener('click', async () => {
		now.disabled = true;
		if (status) status.textContent = 'Starting...';
		try {
			const res: any = await browser.runtime.sendMessage({ action: 'syncNow' });
			if (res?.result?.skipped === 'busy' && status) status.textContent = 'A sync is already running.';
			else if (res?.result?.skipped === 'nothing-to-run' && status) status.textContent = 'Nothing is switched on to sync.';
			else if (!res?.ok && status) status.textContent = 'Sync did not start. Reopen this page and try again.';
			else await refreshSchedule();
		} catch (e) {
			if (status) status.textContent = `Sync failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			// A skipped run writes nothing, so no storage event would re-enable the button.
			const state = await loadSchedule(store).catch(() => null);
			now.disabled = !!state && isRunning(state, Date.now());
		}
	});
	void refreshSchedule();
}

// Instagram sync is not in the first store listing (READ-48 choice 5): its row
// is hidden and the finisher row takes the second number.
// Medium (READ-36) is hidden there too, and on builds without the offscreen
// document it needs to read articles (Firefox, Safari).
const SERVICES: SyncService[] = IS_STORE_BUILD ? ['substack'] : ['substack', 'instagram', ...(offscreenSupported() ? (['medium'] as const) : []), 'youtube'];

export function initializeSyncSettings(): void {
	setupSchedule();
	if (IS_STORE_BUILD) {
		for (const hidden of ['instagram', 'youtube']) {
			(document.querySelector(`.sync-service[data-service="${hidden}"]`) as HTMLElement | null)?.style.setProperty('display', 'none');
		}
		const num = document.getElementById('finish-num');
		if (num) num.textContent = '2';
	}
	if (!SERVICES.includes('medium')) {
		(document.querySelector('.sync-service[data-service="medium"]') as HTMLElement | null)?.style.setProperty('display', 'none');
		const num = document.getElementById('finish-num');
		if (num && !IS_STORE_BUILD) num.textContent = '3';
		const ytNum = document.getElementById('youtube-num');
		if (ytNum && !IS_STORE_BUILD) ytNum.textContent = '4';
	}
	SERVICES.forEach(setupService);
	// Background runs change the saved state while this page is open.
	browser.storage.onChanged.addListener((_changes, area) => {
		if (area !== 'local') return;
		void refreshSchedule();
		SERVICES.forEach((s) => void refresh(s));
	});
}
