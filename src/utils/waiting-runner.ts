// READ-181: browser wiring for the waiting-article finisher. Runs in the
// background worker only. Rules are in waiting-finisher.ts.
import browser from './browser-polyfill';
import { loadReadingSettings } from './storage-utils';
import { createWaitingApi } from './waiting-api';
import { isSafeFetchUrl } from './full-text-check';
import {
	loadFinishState, runFinisher, saveFinishState, MAX_HTML_BYTES,
	type FinisherDeps, type FinishTrigger,
} from './waiting-finisher';

const TAB_LOAD_CAP_MS = 15_000;
// Hard cap on reading the opened page; the window is closed either way.
const EXTRACT_CAP_MS = 20_000;
// The fallback window id, kept in session storage so a worker that died
// mid-run closes the window on its next start.
const OPEN_WINDOW_KEY = 'finish:openWindowId';

/** Chrome builds only: the Firefox and Safari manifests have no offscreen permission. */
export function finishSupported(): boolean {
	try {
		return !!browser.runtime.getManifest().permissions?.includes('offscreen') && !!c().offscreen;
	} catch {
		return false;
	}
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([
		p,
		new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
	]).finally(() => clearTimeout(timer));
}

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
// Created on first use in a run, closed when the run ends. Checked every time
// (not cached), so a document Chrome closed is made again.
let creating: Promise<void> | null = null;
async function hasOffscreen(): Promise<boolean> {
	const existing = await c().runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
	return !!existing && existing.length > 0;
}
async function ensureOffscreen(): Promise<void> {
	if (await hasOffscreen()) return;
	if (!creating) {
		creating = (async () => {
			try {
				await c().offscreen.createDocument({
					url: 'offscreen.html',
					reasons: ['DOM_PARSER'],
					justification: 'Extract article text from fetched HTML for waiting LazyReader items.',
				});
			} catch (e) {
				if (!/single offscreen/i.test(String(e))) throw e;
			} finally {
				creating = null;
			}
		})();
	}
	await creating;
}
async function closeOffscreen(): Promise<void> {
	try {
		if (await hasOffscreen()) await c().offscreen.closeDocument();
	} catch { /* already gone */ }
}

async function askOffscreen(message: Record<string, unknown>): Promise<string> {
	await ensureOffscreen();
	const res: any = await withTimeout(c().runtime.sendMessage({ target: 'offscreen', ...message }), EXTRACT_CAP_MS, 'Offscreen extraction');
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

const session = () => c().storage?.session;

async function closeWindow(windowId: number): Promise<void> {
	await browser.windows.remove(windowId).catch(() => {});
	try { await session()?.remove(OPEN_WINDOW_KEY); } catch { /* best effort */ }
}

/** A fallback window left open by a worker that stopped mid-run. */
async function closeLeftoverWindow(): Promise<void> {
	try {
		const r = await session()?.get(OPEN_WINDOW_KEY);
		const id = r?.[OPEN_WINDOW_KEY];
		if (typeof id === 'number') await closeWindow(id);
	} catch { /* nothing to close */ }
}

async function openForExtraction(url: string): Promise<string | null> {
	let windowId: number | undefined;
	try {
		const win = await browser.windows.create({ url, focused: false, state: 'normal' });
		windowId = win.id;
		if (windowId === undefined) return null;
		try { await session()?.set({ [OPEN_WINDOW_KEY]: windowId }); } catch { /* best effort */ }
		// Straight away, so it spends as little time on screen as possible.
		await browser.windows.update(windowId, { state: 'minimized' });
		const tabId = win.tabs?.[0]?.id;
		if (tabId === undefined) return null;
		await waitForComplete(tabId);
		// The page may have redirected somewhere we must not read.
		const tab = await browser.tabs.get(tabId);
		if (!isSafeFetchUrl(tab.url || '')) return null;
		await new Promise((r) => setTimeout(r, 1000));
		const page = await withTimeout(extractFromTab(tabId), EXTRACT_CAP_MS, 'Page extraction');
		if (!page || !page.content) return null;
		return await askOffscreen({ action: 'contentToMarkdown', html: page.content, url: tab.url || url });
	} finally {
		if (windowId !== undefined) await closeWindow(windowId);
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

// One run at a time in this worker: the stored running flag alone lets two
// triggers that arrive together both start (each reads it before either saves).
let inFlight: ReturnType<typeof runFinisher> | null = null;
export async function runFinish(trigger: FinishTrigger) {
	if (inFlight) return { skipped: 'busy' as const, finished: 0, membersOnly: 0, unreadable: 0, retryLater: 0, stopped: null };
	inFlight = (async () => {
		try {
			return await runFinisher(await makeDeps(), trigger);
		} finally {
			await closeOffscreen();
		}
	})();
	try {
		return await inFlight;
	} finally {
		inFlight = null;
	}
}

// Only the clipper's own pages and its lazyreader.app relay may ask for a run.
export function trustedSender(sender: any): boolean {
	if (!sender || sender.id !== browser.runtime.id) return false;
	if (!sender.tab) return true;
	try {
		return new URL(sender.url || sender.tab.url || '').origin === 'https://lazyreader.app';
	} catch {
		return false;
	}
}

// The triggers (alarm, startup, idle, Finish now) moved to sync-runner.ts with
// choice 26: one schedule for the whole clipper. Only the on/off switch stays here.
export function initWaitingRunner(): void {
	if (!finishSupported()) return;
	void closeLeftoverWindow();
	browser.runtime.onMessage.addListener((request: unknown, sender: unknown, sendResponse: (r?: any) => void): true | undefined => {
		const req = request as { action?: string; enabled?: boolean };
		if (!req || typeof req !== 'object' || req.action !== 'finishSetEnabled') return undefined;
		if (!trustedSender(sender) || (sender as any)?.tab) return undefined;
		void (async () => {
			const state = await loadFinishState(store);
			state.enabled = !!req.enabled;
			await saveFinishState(store, state);
			sendResponse({ ok: true });
		})();
		return true;
	});
}
