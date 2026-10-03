// READ-181: browser wiring for the waiting-article finisher. Runs in the
// background worker only. Rules are in waiting-finisher.ts.
import browser from './browser-polyfill';
import { loadReadingSettings } from './storage-utils';
import { createWaitingApi } from './waiting-api';
import {
	loadFinishState, runFinisher, saveFinishState, MAX_HTML_BYTES,
	type FinisherDeps, type FinishTrigger,
} from './waiting-finisher';

export const FINISH_ALARM = 'finish-waiting';
export const FINISH_PERIOD_MINUTES = 30;
export const IDLE_INTERVAL_SECONDS = 15 * 60;
const TAB_LOAD_CAP_MS = 15_000;

const store = {
	async get(key: string) {
		const r = await browser.storage.local.get(key);
		return r[key];
	},
	async set(key: string, value: any) {
		await browser.storage.local.set({ [key]: value });
	},
};

const c = () => chrome as any;

// --- offscreen document (Defuddle needs a DOM) ---------------------------
let offscreenReady: Promise<void> | null = null;
async function ensureOffscreen(): Promise<void> {
	if (!offscreenReady) {
		offscreenReady = (async () => {
			try {
				const existing = await c().runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
				if (existing && existing.length > 0) return;
				await c().offscreen.createDocument({
					url: 'offscreen.html',
					reasons: ['DOM_PARSER'],
					justification: 'Extract article text from fetched HTML for waiting LazyReader items.',
				});
			} catch (e) {
				if (!/single offscreen/i.test(String(e))) { offscreenReady = null; throw e; }
			}
		})();
	}
	return offscreenReady;
}

async function askOffscreen(message: Record<string, unknown>): Promise<string> {
	await ensureOffscreen();
	const res: any = await c().runtime.sendMessage({ target: 'offscreen', ...message });
	if (!res?.ok) throw new Error(res?.error || 'Offscreen extraction failed');
	return String(res.text || '');
}

// --- primary method: worker fetch with the browser's own cookies ----------
async function fetchPage(url: string) {
	const res = await fetch(url, { credentials: 'include', redirect: 'follow', headers: { Accept: 'text/html,application/xhtml+xml' } });
	const type = res.headers.get('content-type') || '';
	let html = '';
	if (res.ok && /html|xml/i.test(type)) {
		html = await res.text();
		if (html.length > MAX_HTML_BYTES) html = '';
	}
	return { status: res.status, html, finalUrl: res.url || url };
}

// --- fallback B: minimized window, graveyard order (plan choice 13) -------
async function waitForComplete(tabId: number): Promise<void> {
	const tab = await browser.tabs.get(tabId);
	if (tab.status === 'complete') return;
	await new Promise<void>((resolve) => {
		const done = () => { browser.tabs.onUpdated.removeListener(onUpdated); clearTimeout(timer); resolve(); };
		const onUpdated = (id: number, info: { status?: string }) => { if (id === tabId && info.status === 'complete') done(); };
		const timer = setTimeout(done, TAB_LOAD_CAP_MS);
		browser.tabs.onUpdated.addListener(onUpdated);
	});
}

// The worker cannot message itself, so this is extractPageContent's job done
// directly: make sure the content script is in the tab, then ask it.
async function extractFromTab(tabId: number): Promise<any> {
	try {
		await browser.tabs.sendMessage(tabId, { action: 'ping' });
	} catch {
		await browser.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
		for (let i = 0; i < 8; i++) {
			try { await browser.tabs.sendMessage(tabId, { action: 'ping' }); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
		}
	}
	return browser.tabs.sendMessage(tabId, { action: 'getPageContent', scrollToLoad: true });
}

async function openForExtraction(url: string): Promise<string | null> {
	let windowId: number | undefined;
	try {
		const win = await browser.windows.create({ url, focused: false, state: 'normal' });
		windowId = win.id;
		if (windowId === undefined) return null;
		// Straight away, so it spends as little time on screen as possible.
		await browser.windows.update(windowId, { state: 'minimized' });
		const tabId = win.tabs?.[0]?.id;
		if (tabId === undefined) return null;
		await waitForComplete(tabId);
		await new Promise((r) => setTimeout(r, 1000));
		const page = await extractFromTab(tabId);
		if (!page || !page.content) return null;
		return await askOffscreen({ action: 'contentToMarkdown', html: page.content, url });
	} finally {
		if (windowId !== undefined) await browser.windows.remove(windowId).catch(() => {});
	}
}

async function makeDeps(): Promise<FinisherDeps> {
	const settings = await loadReadingSettings();
	return {
		store,
		api: createWaitingApi(settings.captureUrl, settings.token),
		hasToken: async () => !!(await loadReadingSettings()).token,
		fetchPage,
		extractHtml: (html, url) => askOffscreen({ action: 'extractHtml', html, url }),
		openForExtraction,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		now: () => Date.now(),
	};
}

export async function runFinish(trigger: FinishTrigger) {
	return runFinisher(await makeDeps(), trigger);
}

export function initWaitingRunner(): void {
	const api = c();
	const ensureAlarm = async () => {
		if (!api.alarms) return;
		if (!(await api.alarms.get(FINISH_ALARM))) api.alarms.create(FINISH_ALARM, { periodInMinutes: FINISH_PERIOD_MINUTES });
	};
	api.alarms?.onAlarm.addListener((alarm: { name: string }) => {
		if (alarm.name === FINISH_ALARM) void runFinish('alarm');
	});
	api.idle?.setDetectionInterval?.(IDLE_INTERVAL_SECONDS);
	api.idle?.onStateChanged?.addListener((state: string) => {
		if (state === 'active') void runFinish('idle');
	});
	browser.runtime.onStartup?.addListener(() => {
		void ensureAlarm().then(() => runFinish('startup'));
	});
	browser.runtime.onInstalled.addListener(() => { void ensureAlarm(); });

	browser.runtime.onMessage.addListener((request: unknown, _sender: unknown, sendResponse: (r?: any) => void): true | undefined => {
		const req = request as { action?: string; enabled?: boolean };
		if (!req || typeof req !== 'object') return undefined;
		if (req.action === 'finishNow') {
			runFinish('now').then((result) => sendResponse({ ok: true, result })).catch((e) => sendResponse({ ok: false, error: String(e) }));
			return true;
		}
		if (req.action === 'finishSetEnabled') {
			void (async () => {
				const state = await loadFinishState(store);
				state.enabled = !!req.enabled;
				await saveFinishState(store, state);
				sendResponse({ ok: true });
			})();
			return true;
		}
		return undefined;
	});
}
