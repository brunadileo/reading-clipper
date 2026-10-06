// READ-181: "Finish waiting articles on this computer" switch in the Sync section.
// The Finish now button is gone: Sync now runs it (choice 26).
import browser from '../utils/browser-polyfill';
import { describeFinishStatus, FINISH_ORIGINS, finishNeedsAccess, isEnabled, loadFinishState } from '../utils/waiting-finisher';
import { setText } from '../utils/set-text';
import { describePushStatus, loadPushState } from '../utils/clipper-push';
import { loadReadingSettings } from '../utils/storage-utils';

const store = {
	async get(key: string) {
		const r = await browser.storage.local.get(key);
		return r[key];
	},
	async set(key: string, value: any) {
		await browser.storage.local.set({ [key]: value });
	},
};

async function hasAccess(): Promise<boolean> {
	try { return await browser.permissions.contains({ origins: FINISH_ORIGINS }); } catch { return false; }
}

async function refresh(): Promise<void> {
	const state = await loadFinishState(store);
	const hasToken = !!(await loadReadingSettings()).token;
	const access = await hasAccess();
	const toggle = document.getElementById('finish-toggle') as HTMLInputElement | null;
	const status = document.getElementById('finish-status');
	const allow = document.getElementById('finish-allow') as HTMLButtonElement | null;
	// Without the all-sites grant the finisher does not run, so the switch shows off.
	const on = isEnabled(state, hasToken) && access;
	if (allow) allow.hidden = !finishNeedsAccess(state, hasToken, access);
	if (toggle) {
		toggle.checked = on;
		toggle.closest('.checkbox-container')?.classList.toggle('is-enabled', on);
	}
	setText(status, describeFinishStatus(state, hasToken, Date.now(), access));
	setText(document.getElementById('finish-instant'), describePushStatus(await loadPushState(store)));
	const list = document.getElementById('finish-open-list');
	if (list) list.hidden = !on;
}

export function initializeFinishSettings(): void {
	const toggle = document.getElementById('finish-toggle') as HTMLInputElement | null;
	if (!toggle) return;
	// Chrome only (offscreen document); the Firefox and Safari builds hide it.
	if (!browser.runtime.getManifest().permissions?.includes('offscreen')) {
		(toggle.closest('[data-service="finish"]') as HTMLElement | null)?.style.setProperty('display', 'none');
		return;
	}
	const status = document.getElementById('finish-status');
	const allow = document.getElementById('finish-allow') as HTMLButtonElement | null;
	// permissions.request has to run inside the click, before any await.
	const askAccess = (): Promise<boolean> => browser.permissions.request({ origins: FINISH_ORIGINS }).catch(() => false);
	const denied = () => { if (status) status.textContent = 'Not allowed, so this stays off. Press Allow access to try again.'; };
	toggle.addEventListener('change', () => {
		const wantOn = toggle.checked;
		const granted: Promise<boolean> = wantOn ? askAccess() : Promise.resolve(true);
		void granted.then(async (ok) => {
			if (!ok) {
				toggle.checked = false;
				await refresh();
				denied();
				return;
			}
			await browser.runtime.sendMessage({ action: 'finishSetEnabled', enabled: wantOn });
			await refresh();
		});
	});
	allow?.addEventListener('click', () => {
		void askAccess().then(async (ok) => {
			if (ok) await browser.runtime.sendMessage({ action: 'finishSetEnabled', enabled: true });
			await refresh();
			if (!ok) denied();
		});
	});
	browser.storage.onChanged.addListener((_c, area) => { if (area === 'local') void refresh(); });
	// The grant can also change from chrome://extensions.
	browser.permissions.onAdded?.addListener(() => void refresh());
	browser.permissions.onRemoved?.addListener(() => void refresh());
	void refresh();
}
