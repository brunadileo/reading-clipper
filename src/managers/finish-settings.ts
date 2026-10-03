// READ-181: "Finish waiting articles on this computer" in the Sync section.
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
	const now = document.getElementById('finish-now') as HTMLButtonElement | null;
	const on = isEnabled(state, hasToken);
	if (toggle) {
		toggle.checked = on;
		toggle.closest('.checkbox-container')?.classList.toggle('is-enabled', on);
	}
	if (status) status.textContent = describeFinishStatus(state, hasToken, Date.now());
	if (now) now.disabled = !hasToken || state.running;
}

export function initializeFinishSettings(): void {
	const toggle = document.getElementById('finish-toggle') as HTMLInputElement | null;
	const now = document.getElementById('finish-now') as HTMLButtonElement | null;
	const status = document.getElementById('finish-status');
	if (!toggle || !now) return;
	// Chrome only (offscreen document); the Firefox and Safari builds hide it.
	if (!browser.runtime.getManifest().permissions?.includes('offscreen')) {
		(toggle.closest('[data-service="finish"]') as HTMLElement | null)?.style.setProperty('display', 'none');
		return;
	}
	toggle.addEventListener('change', async () => {
		await browser.runtime.sendMessage({ action: 'finishSetEnabled', enabled: toggle.checked });
		await refresh();
	});
	now.addEventListener('click', async () => {
		now.disabled = true;
		if (status) status.textContent = 'Finishing...';
		try {
			await browser.runtime.sendMessage({ action: 'finishNow' });
		} catch (e) {
			if (status) status.textContent = `Failed: ${e instanceof Error ? e.message : String(e)}`;
		}
		await refresh();
	});
	browser.storage.onChanged.addListener((_c, area) => { if (area === 'local') void refresh(); });
	void refresh();
}
