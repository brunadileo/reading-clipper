// READ-36: browser wiring for the Medium sync. Background worker only. The
// rules live in medium-sync.ts; this file supplies what needs the browser:
// the page fetch and Defuddle extraction shared with the waiting-article
// finisher, and the minimized window that scrolls a list page.
import browser from './browser-polyfill';
import { isSafeFetchUrl, checkFullText } from './full-text-check';
import { ensureOffscreen, releaseOffscreen } from './offscreen-doc';
import { collectListPage } from './medium-collect';
import type { MediumCollected, MediumDeps } from './medium-sync';
import type { SyncDeps } from './sync-core';
import { fetchPage, waitForComplete, withTimeout } from './waiting-runner';

const OFFSCREEN_HOLDER = 'medium';
const EXTRACT_CAP_MS = 20_000;
// The whole scroll of one list page, window open to window closed.
const COLLECT_CAP_MS = 150_000;
const OPEN_WINDOW_KEY = 'medium:openWindowId';
const c = () => chrome as any;
const session = () => c().storage?.session;

async function extractHtml(html: string, url: string): Promise<string> {
	await ensureOffscreen(OFFSCREEN_HOLDER);
	const res: any = await withTimeout(c().runtime.sendMessage({ target: 'offscreen', action: 'extractHtml', html, url }), EXTRACT_CAP_MS, 'Offscreen extraction');
	if (!res?.ok) throw new Error(res?.error || 'Offscreen extraction failed');
	return String(res.text || '');
}

async function closeWindow(windowId: number): Promise<void> {
	await browser.windows.remove(windowId).catch(() => {});
	try { await session()?.remove(OPEN_WINDOW_KEY); } catch { /* best effort */ }
}

/** A list window left open by a worker that stopped mid-run. */
export async function closeLeftoverMediumWindow(): Promise<void> {
	try {
		const r = await session()?.get(OPEN_WINDOW_KEY);
		const id = r?.[OPEN_WINDOW_KEY];
		if (typeof id === 'number') await closeWindow(id);
	} catch { /* nothing to close */ }
}

const isMediumUrl = (raw: string): boolean => {
	if (!isSafeFetchUrl(raw)) return false;
	const h = new URL(raw).hostname;
	return h === 'medium.com' || h.endsWith('.medium.com');
};

/**
 * Open one list page in a minimized window, scroll it so Medium's own JS pages
 * the list, read post links from the page, close the window. The clipper sends
 * no request of its own here; the page does what it does on any visit.
 */
export async function openListAndCollect(url: string, wantNew: number, knownPostIds: string[]): Promise<MediumCollected> {
	if (!isMediumUrl(url)) return { posts: [], total: 0, ended: true, blocked: true };
	let windowId: number | undefined;
	const work = (async (): Promise<MediumCollected> => {
		const win = await browser.windows.create({ url, focused: false, state: 'normal' });
		windowId = win.id;
		if (windowId === undefined) throw new Error('Could not open the list page');
		try { await session()?.set({ [OPEN_WINDOW_KEY]: windowId }); } catch { /* best effort */ }
		// Straight away, so it spends as little time on screen as possible.
		await browser.windows.update(windowId, { state: 'minimized' });
		const tabId = win.tabs?.[0]?.id;
		if (tabId === undefined) throw new Error('Could not open the list page');
		await waitForComplete(tabId);
		const tab = await browser.tabs.get(tabId);
		// Redirected away (sign-in, another site): never read it.
		if (!isMediumUrl(tab.url || '') || /\/(m\/)?signin/.test(new URL(tab.url!).pathname)) return { posts: [], total: 0, ended: true, blocked: true };
		await new Promise((r) => setTimeout(r, 1500));
		const [out] = await browser.scripting.executeScript({ target: { tabId }, func: collectListPage, args: [wantNew, knownPostIds] });
		return (out?.result as MediumCollected) ?? { posts: [], total: 0, ended: true, blocked: true };
	})();
	try {
		return await withTimeout(work, COLLECT_CAP_MS, 'Reading the list page');
	} finally {
		if (windowId !== undefined) await closeWindow(windowId);
	}
}

/** Medium's deps: the shared sync deps plus the browser pieces. */
export function makeMediumDeps(base: SyncDeps): MediumDeps {
	return {
		...base,
		fetchPage,
		extractHtml,
		checkFullText,
		openListAndCollect,
	};
}

/** Called when a run ends: lets go of the offscreen document if nobody else holds it. */
export const releaseMediumOffscreen = () => releaseOffscreen(OFFSCREEN_HOLDER);
