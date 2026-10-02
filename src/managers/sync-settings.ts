// Settings section "Sync (experimental)": a switch per service, a status line,
// Sync now and Load older. Turning a switch on asks Chrome for site access to
// that service only (optional_host_permissions); turning it off keeps the
// permission but stops the sync. Text is plain English, not i18n keys.
import browser from '../utils/browser-polyfill';
import { loadState, type SyncService, type SyncState } from '../utils/sync-core';
import { creditWarning, IG_FIRST_RUN_POSTS } from '../utils/instagram-sync';

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
	if (s.lastSuccess === null) return 'Turned on. Waiting for the first sync.';
	const mins = Math.max(0, Math.round((now - s.lastSuccess) / 60000));
	const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
	return `Last synced ${ago}${s.lastResult ? ` (${s.lastResult})` : ''}`;
}

async function refresh(service: SyncService): Promise<void> {
	const state = await loadState(store, service);
	const toggle = document.getElementById(`sync-${service}-toggle`) as HTMLInputElement | null;
	const status = document.getElementById(`sync-${service}-status`);
	const now = document.getElementById(`sync-${service}-now`) as HTMLButtonElement | null;
	const older = document.getElementById(`sync-${service}-older`) as HTMLButtonElement | null;
	if (toggle) {
		toggle.checked = state.enabled;
		toggle.closest('.checkbox-container')?.classList.toggle('is-enabled', state.enabled);
	}
	if (status) status.textContent = describeSyncStatus(service, state, Date.now());
	if (now) now.disabled = !state.enabled || state.running;
	if (older) older.disabled = !state.enabled || state.running || state.olderExhausted;
}

function setupService(service: SyncService): void {
	const toggle = document.getElementById(`sync-${service}-toggle`) as HTMLInputElement | null;
	const now = document.getElementById(`sync-${service}-now`) as HTMLButtonElement | null;
	const older = document.getElementById(`sync-${service}-older`) as HTMLButtonElement | null;
	const status = document.getElementById(`sync-${service}-status`);
	if (!toggle || !now || !older) return;

	toggle.addEventListener('change', () => {
		const wantOn = toggle.checked;
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

	const run = async (kind: 'manual' | 'older') => {
		if (service === 'instagram') {
			const count = IG_FIRST_RUN_POSTS;
			const warning = creditWarning(count);
			if (warning && !window.confirm(`${warning}\n\nUp to ${count} posts. Continue?`)) return;
		}
		now.disabled = true;
		older.disabled = true;
		if (status) status.textContent = 'Syncing...';
		try {
			const res: any = await browser.runtime.sendMessage({ action: 'syncRun', service, kind });
			const msg = res?.result?.message;
			await refresh(service);
			if (msg && status) status.textContent = msg;
		} catch (e) {
			if (status) status.textContent = `Sync failed: ${e instanceof Error ? e.message : String(e)}`;
		}
	};
	now.addEventListener('click', () => void run('manual'));
	older.addEventListener('click', () => void run('older'));

	void refresh(service);
}

export function initializeSyncSettings(): void {
	(['substack', 'instagram'] as SyncService[]).forEach(setupService);
	// Background runs change the saved state while this page is open.
	browser.storage.onChanged.addListener((_changes, area) => {
		if (area === 'local') (['substack', 'instagram'] as SyncService[]).forEach((s) => void refresh(s));
	});
}
