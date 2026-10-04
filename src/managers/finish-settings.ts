// READ-181: "Finish waiting articles on this computer" switch in the Sync section.
// The Finish now button is gone: Sync now runs it (choice 26).
import browser from '../utils/browser-polyfill';
import { describeFinishStatus, isEnabled, loadFinishState } from '../utils/waiting-finisher';
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

async function refresh(): Promise<void> {
	const state = await loadFinishState(store);
	const hasToken = !!(await loadReadingSettings()).token;
	const toggle = document.getElementById('finish-toggle') as HTMLInputElement | null;
	const status = document.getElementById('finish-status');
	const on = isEnabled(state, hasToken);
	if (toggle) {
		toggle.checked = on;
		toggle.closest('.checkbox-container')?.classList.toggle('is-enabled', on);
	}
	if (status) status.textContent = describeFinishStatus(state, hasToken, Date.now());
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
	toggle.addEventListener('change', async () => {
		await browser.runtime.sendMessage({ action: 'finishSetEnabled', enabled: toggle.checked });
		await refresh();
	});
	browser.storage.onChanged.addListener((_c, area) => { if (area === 'local') void refresh(); });
	void refresh();
}
