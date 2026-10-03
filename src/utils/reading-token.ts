// The capture token heals itself. When the clipper has no token, or the server
// rejects the one it has (regenerated in Settings, extension reloaded under a
// new id), the background worker reads the user's LazyReader session from a
// lazyreader.app tab (else a hidden frame in the offscreen document, else a
// background tab), asks getMyProfile for the current token and stores it.
// No copy and paste. Never logs the token or the session.
import browser from './browser-polyfill';
import { loadReadingSettings, saveReadingSettings } from './storage-utils';
import { ensureOffscreen, offscreenSupported, releaseOffscreen } from './offscreen-doc';
import { readLazyReaderSession, SESSION_FRAME_HASH } from './lazyreader-session';

export const LAZYREADER_ORIGIN = 'https://lazyreader.app';
const PROFILE_URL = `${LAZYREADER_ORIGIN}/api/getMyProfile`;
const TAB_LOAD_TIMEOUT_MS = 15000;
// supabase-js refreshes an expired session shortly after the page loads.
const SESSION_SETTLE_MS = 1500;
// Hard cap on the hidden-frame lookup before falling back to a background tab.
export const FRAME_TIMEOUT_MS = 8000;
const OFFSCREEN_HOLDER = 'token';

async function sessionFromTab(tabId: number): Promise<string | null> {
	try {
		const [res] = await browser.scripting.executeScript({ target: { tabId }, func: readLazyReaderSession });
		return (res?.result as string | null) ?? null;
	} catch {
		return null;
	}
}

function waitForTabLoad(tabId: number): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			browser.tabs.onUpdated.removeListener(onUpdated);
			resolve();
		};
		const onUpdated = (id: number, info: { status?: string }) => {
			if (id === tabId && info.status === 'complete') done();
		};
		const timer = setTimeout(done, TAB_LOAD_TIMEOUT_MS);
		browser.tabs.onUpdated.addListener(onUpdated);
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- hidden frame in the offscreen document ------------------------------
// scripting.executeScript cannot reach an offscreen document's frames, so the
// lazyreader.app relay running inside the frame reports the session itself
// (acceptFrameSession). Chrome may partition the frame's storage away from the
// user's lazyreader.app session; then it reports null and the background tab
// below takes over.
let pendingFrame: ((session: string | null) => void) | null = null;

/**
 * Called by the background worker for every lazyreaderFrameSession message.
 * Takes the session only while a frame lookup is waiting, and only from a
 * lazyreader.app frame that is not in a tab (the offscreen document).
 */
export function acceptFrameSession(sender: { tab?: unknown; url?: string }, accessToken: unknown): boolean {
	if (!pendingFrame || sender.tab) return false;
	let origin = '';
	try {
		origin = new URL(sender.url || '').origin;
	} catch {
		return false;
	}
	if (origin !== LAZYREADER_ORIGIN) return false;
	pendingFrame(typeof accessToken === 'string' && accessToken ? accessToken : null);
	return true;
}

async function sessionFromOffscreenFrame(): Promise<string | null> {
	if (!offscreenSupported()) return null;
	const chromeApi = (globalThis as any).chrome;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const reported = new Promise<string | null>((resolve) => {
		pendingFrame = resolve;
		timer = setTimeout(() => resolve(null), FRAME_TIMEOUT_MS);
	});
	try {
		// The timeout covers setting the frame up too, not only the wait.
		const open = (async () => {
			await ensureOffscreen(OFFSCREEN_HOLDER);
			await chromeApi.runtime.sendMessage({ target: 'offscreen', action: 'openLazyReaderFrame', url: `${LAZYREADER_ORIGIN}/${SESSION_FRAME_HASH}` });
			return reported;
		})();
		return await Promise.race([open, reported]);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		pendingFrame = null;
		await chromeApi.runtime.sendMessage({ target: 'offscreen', action: 'closeLazyReaderFrame' }).catch(() => {});
		await releaseOffscreen(OFFSCREEN_HOLDER).catch(() => {});
	}
}

type SessionSource = 'open tab' | 'offscreen frame' | 'background tab' | 'none';

/**
 * Finds a session in an open lazyreader.app tab, else in a hidden frame in the
 * offscreen document, else opens a background tab for a moment.
 */
async function findSession(preferTabId?: number): Promise<{ session: string | null; source: SessionSource }> {
	if (preferTabId !== undefined) {
		const s = await sessionFromTab(preferTabId);
		if (s) return { session: s, source: 'open tab' };
	}
	const tabs = await browser.tabs.query({ url: `${LAZYREADER_ORIGIN}/*` });
	for (const tab of tabs) {
		if (tab.id === undefined || tab.id === preferTabId) continue;
		const s = await sessionFromTab(tab.id);
		if (s) return { session: s, source: 'open tab' };
	}
	if (preferTabId !== undefined) return { session: null, source: 'none' };

	const framed = await sessionFromOffscreenFrame();
	if (framed) return { session: framed, source: 'offscreen frame' };

	const tab = await browser.tabs.create({ url: `${LAZYREADER_ORIGIN}/`, active: false });
	if (tab.id === undefined) return { session: null, source: 'none' };
	try {
		await waitForTabLoad(tab.id);
		await sleep(SESSION_SETTLE_MS);
		const s = await sessionFromTab(tab.id);
		return { session: s, source: s ? 'background tab' : 'none' };
	} finally {
		browser.tabs.remove(tab.id).catch(() => {});
	}
}

async function tokenForSession(accessToken: string, fetchFn: typeof fetch): Promise<string | null> {
	try {
		const res = await fetchFn(PROFILE_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
			body: '{}',
		});
		if (!res.ok) return null;
		const data = await res.json().catch(() => null);
		const token = data?.capture_token;
		return typeof token === 'string' && token ? token : null;
	} catch {
		return null;
	}
}

let inFlight: Promise<string | null> | null = null;

/**
 * Fetches the current capture token through the user's LazyReader session and
 * stores it when it changed. Returns the token, or null when the user is not
 * signed in to lazyreader.app in this browser. Pass the tab id when the call
 * comes from the lazyreader.app relay, so no extra tab is opened.
 */
export function refreshReadingToken(preferTabId?: number, fetchFn: typeof fetch = fetch): Promise<string | null> {
	if (inFlight) return inFlight;
	inFlight = (async () => {
		const { session, source } = await findSession(preferTabId);
		// Which path ran; never the session or the token.
		console.debug(`[LazyReader token] session source: ${source}`);
		if (!session) return null;
		const token = await tokenForSession(session, fetchFn);
		if (!token) return null;
		const current = await loadReadingSettings();
		if (current.token !== token) await saveReadingSettings({ token });
		return token;
	})().finally(() => {
		inFlight = null;
	});
	return inFlight;
}
