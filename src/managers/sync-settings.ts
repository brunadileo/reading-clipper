// Settings section "Sync (experimental)": one schedule setting with one Sync now
// button and one status line, then a switch per service with Load older. Turning a switch on asks Chrome for site access to
// that service only (optional_host_permissions); turning it off keeps the
// permission but stops the sync. Text is plain English, not i18n keys.
import browser from '../utils/browser-polyfill';
import { loadState, type SyncService, type SyncState } from '../utils/sync-core';
import { creditWarning, IG_FIRST_RUN_POSTS } from '../utils/instagram-sync';
import { describeScheduleStatus, isFrequency, isRunning, loadSchedule } from '../utils/sync-schedule';

const ORIGINS: Record<SyncService, string[]> = {
	substack: ['https://substack.com/*', 'https://*.substack.com/*'],
	instagram: ['https://www.instagram.com/*', 'https://i.instagram.com/*'],
};
const NAMES: Record<SyncService, string> = { substack: 'Substack', instagram: 'Instagram' };

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
	if (s.running && s.lastAttemptAt !== null && now - s.lastAttemptAt < 15 * 60 * 1000) return 'Syncing...';
	if (s.signedOut) return `Sign in to ${name} in this browser, then press Sync now.`;
	if (s.lastError) return `Last sync failed: ${s.lastError}`;
	if (s.lastSuccess === null) return 'Turned on. Runs with the next sync, or press Sync now.';
	const mins = Math.max(0, Math.round((now - s.lastSuccess) / 60000));
	const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
	return `Last synced ${ago}${s.lastResult ? ` (${s.lastResult})` : ''}`;
}

async function refresh(service: SyncService): Promise<void> {
	const state = await loadState(store, service);
	const toggle = document.getElementById(`sync-${service}-toggle`) as HTMLInputElement | null;
	const status = document.getElementById(`sync-${service}-status`);
	const older = document.getElementById(`sync-${service}-older`) as HTMLButtonElement | null;
	if (toggle) {
		toggle.checked = state.enabled;
		toggle.closest('.checkbox-container')?.classList.toggle('is-enabled', state.enabled);
	}
	if (status) status.textContent = describeSyncStatus(service, state, Date.now());
	if (older) older.disabled = !state.enabled || state.running || state.olderExhausted;
}

function setupService(service: SyncService): void {
	const toggle = document.getElementById(`sync-${service}-toggle`) as HTMLInputElement | null;
	const older = document.getElementById(`sync-${service}-older`) as HTMLButtonElement | null;
	const status = document.getElementById(`sync-${service}-status`);
	if (!toggle || !older) return;

	toggle.addEventListener('change', () => {
		const wantOn = toggle.checked;
		// The first Instagram run is the costly one, and it now happens on the schedule.
		if (wantOn && service === 'instagram') {
			const warning = creditWarning(IG_FIRST_RUN_POSTS);
			if (warning && !window.confirm(`${warning}\n\nUp to ${IG_FIRST_RUN_POSTS} posts on the first sync. Turn Instagram on?`)) {
				toggle.checked = false;
				return;
			}
		}
		// permissions.request has to run inside the click, before any await.
		const granted: Promise<boolean> = wantOn
			? browser.permissions.request({ origins: ORIGINS[service] }).catch(() => false)
			: Promise.resolve(true);
		void granted.then(async (ok) => {
			if (!ok) {
				toggle.checked = false;
				if (status) status.textContent = `${NAMES[service]} sync needs access to ${NAMES[service]}'s site. It stays off.`;
				return;
			}
			await browser.runtime.sendMessage({ action: 'syncSetEnabled', service, enabled: wantOn });
			await refresh(service);
		});
	});

	older.addEventListener('click', async () => {
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

	void refresh(service);
}

async function refreshSchedule(): Promise<void> {
	const state = await loadSchedule(store);
	const select = document.getElementById('sync-frequency') as HTMLSelectElement | null;
	const status = document.getElementById('sync-schedule-status');
	const now = document.getElementById('sync-all-now') as HTMLButtonElement | null;
	if (select && document.activeElement !== select) select.value = state.frequency;
	if (status) status.textContent = describeScheduleStatus(state, Date.now());
	if (now) now.disabled = isRunning(state, Date.now());
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

export function initializeSyncSettings(): void {
	setupSchedule();
	(['substack', 'instagram'] as SyncService[]).forEach(setupService);
	// Background runs change the saved state while this page is open.
	browser.storage.onChanged.addListener((_changes, area) => {
		if (area !== 'local') return;
		void refreshSchedule();
		(['substack', 'instagram'] as SyncService[]).forEach((s) => void refresh(s));
	});
}
