// The capture token heals itself. When the clipper has no token, or the server
// rejects the one it has (regenerated in Settings, extension reloaded under a
// new id), the background worker reads the user's LazyReader session from a
// lazyreader.app tab, asks getMyProfile for the current token and stores it.
// No copy and paste. Never logs the token or the session.
import browser from './browser-polyfill';
import { loadReadingSettings, saveReadingSettings } from './storage-utils';

export const LAZYREADER_ORIGIN = 'https://lazyreader.app';
const PROFILE_URL = `${LAZYREADER_ORIGIN}/api/getMyProfile`;
const TAB_LOAD_TIMEOUT_MS = 15000;
// supabase-js refreshes an expired session shortly after the page loads.
const SESSION_SETTLE_MS = 1500;

/** Runs inside the lazyreader.app page: the signed-in user's access token, or null. */
function readSessionInPage(): string | null {
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i) || '';
		if (!/^sb-.+-auth-token$/.test(key)) continue;
		try {
			const raw = JSON.parse(localStorage.getItem(key) || 'null');
			const session = raw?.currentSession ?? raw;
			if (typeof session?.access_token === 'string') return session.access_token;
		} catch {
			// Not JSON; try the next key.
		}
	}
	return null;
}

async function sessionFromTab(tabId: number): Promise<string | null> {
	try {
		const [res] = await browser.scripting.executeScript({ target: { tabId }, func: readSessionInPage });
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

/** Finds a session in an open lazyreader.app tab, else opens one in the background for a moment. */
async function findSession(preferTabId?: number): Promise<string | null> {
	if (preferTabId !== undefined) {
		const s = await sessionFromTab(preferTabId);
		if (s) return s;
	}
	const tabs = await browser.tabs.query({ url: `${LAZYREADER_ORIGIN}/*` });
	for (const tab of tabs) {
		if (tab.id === undefined || tab.id === preferTabId) continue;
		const s = await sessionFromTab(tab.id);
		if (s) return s;
	}
	if (preferTabId !== undefined) return null;

	const tab = await browser.tabs.create({ url: `${LAZYREADER_ORIGIN}/`, active: false });
	if (tab.id === undefined) return null;
	try {
		await waitForTabLoad(tab.id);
		await sleep(SESSION_SETTLE_MS);
		return await sessionFromTab(tab.id);
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
		const session = await findSession(preferTabId);
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
