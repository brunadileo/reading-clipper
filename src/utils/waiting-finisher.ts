// READ-181: finish "Waiting for full text" items from inside the user's own
// signed-in Chrome. Pure rules with injected dependencies (like sync-core.ts);
// the browser wiring is in waiting-runner.ts. The clipper only fetches links
// that listWaiting returned for this user's token (plan choice 17), and never
// reads, stores or sends a cookie.
import { checkFullText, isSafeFetchUrl, pickBestText } from './full-text-check';
import { fitReadingText } from './reading-sender';
import type { ProvideResult, WaitingApi, WaitingItem } from './waiting-api';
import { countWords, type SyncStore } from './sync-core';

export const FINISH_KEY = 'finish:waiting';
export const AUTO_MIN_GAP_MS = 10 * 60 * 1000;
export const STALE_LOCK_MS = 15 * 60 * 1000;
export const AUTO_LIMIT = 10;
export const NOW_LIMIT = 20;
export const MAX_ITEM_ATTEMPTS = 3;
// Automatic runs try an item at most once an hour; Sync now and web Finish now try everything.
export const ITEM_RETRY_MS = 60 * 60 * 1000;
export const MAX_HTML_BYTES = 5_000_000;

// READ-48: the store build asks for these sites at run time (optional host
// permissions), once, with one click in Settings. Without the grant the
// finisher skips quietly.
export const FINISH_ORIGINS = ['https://*/*', 'http://*/*'];

// 'push' = a wake from the server; 'wake-rerun' = the one rerun at the end of a
// sequence that a wake found busy (no gap, the hourly per-item rule still applies).
export type FinishTrigger = 'startup' | 'idle' | 'alarm' | 'now' | 'push' | 'wake-rerun';

export interface FinishState {
	// null = default: on once a token is set.
	enabled: boolean | null;
	running: boolean;
	lastAttemptAt: number | null;
	lastRunAt: number | null;
	lastResult: string | null;
	lastError: string | null;
	// itemId -> failed attempts, pruned to the ids the last listWaiting returned.
	attempts: Record<string, number>;
	// itemId -> when an automatic run last tried it, pruned like attempts.
	triedAt: Record<string, number>;
	waitingCount: number | null;
}

export const emptyFinishState = (): FinishState => ({
	enabled: null,
	running: false,
	lastAttemptAt: null,
	lastRunAt: null,
	lastResult: null,
	lastError: null,
	attempts: {},
	triedAt: {},
	waitingCount: null,
});

export async function loadFinishState(store: SyncStore): Promise<FinishState> {
	const saved = await store.get(FINISH_KEY);
	return { ...emptyFinishState(), ...(saved && typeof saved === 'object' ? saved : {}) };
}

export const saveFinishState = (store: SyncStore, s: FinishState) => store.set(FINISH_KEY, s);

export interface FetchedPage {
	status: number;
	html: string;
	finalUrl: string;
}

export interface FinisherDeps {
	store: SyncStore;
	api: WaitingApi;
	// True when a LazyReader token is saved.
	hasToken: () => Promise<boolean>;
	// True when the all-sites grant is held (always true in the default build). Omitted means yes.
	hasAccess?: () => Promise<boolean>;
	// Service-worker fetch with credentials 'include'. Throws on network failure.
	fetchPage: (url: string) => Promise<FetchedPage>;
	// HTML to article text (Defuddle in the offscreen document).
	extractHtml: (html: string, url: string) => Promise<string>;
	// Fallback B (minimized window). Returns text, or null when it could not open the page.
	openForExtraction?: (url: string) => Promise<string | null>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	random?: () => number;
}

export interface FinishResult {
	skipped: 'disabled' | 'no-token' | 'no-access' | 'busy' | 'throttled' | null;
	finished: number;
	membersOnly: number;
	unreadable: number;
	retryLater: number;
	stopped: 'token' | 'rate-limited' | 'error' | null;
}

class StopRun extends Error {
	constructor(public reason: NonNullable<FinishResult['stopped']>, message: string) {
		super(message);
	}
}

const jitter = (deps: FinisherDeps, min: number, max: number) =>
	min + Math.floor((deps.random ? deps.random() : Math.random()) * (max - min + 1));

export function isEnabled(state: FinishState, hasToken: boolean): boolean {
	return state.enabled ?? hasToken;
}

/** Pure: should a run start now? */
export function shouldRun(trigger: FinishTrigger, state: FinishState, hasToken: boolean, now: number, hasAccess = true): FinishResult['skipped'] {
	if (!hasToken) return 'no-token';
	if (!hasAccess) return 'no-access';
	if (trigger !== 'now' && !isEnabled(state, hasToken)) return 'disabled';
	if (state.running && state.lastAttemptAt !== null && now - state.lastAttemptAt < STALE_LOCK_MS) return 'busy';
	// A push wake or its rerun has no gap: the 20 s collect pause and the hourly per-item rule hold it back.
	if (trigger !== 'now' && trigger !== 'wake-rerun' && trigger !== 'push') {
		if (state.lastAttemptAt !== null && now - state.lastAttemptAt < AUTO_MIN_GAP_MS) return 'throttled';
	}
	return null;
}

/** Pure: which attempts survive a fresh listWaiting. */
export function pruneAttempts<T>(attempts: Record<string, T>, items: WaitingItem[]): Record<string, T> {
	const ids = new Set(items.map((i) => i.id));
	const out: Record<string, T> = {};
	for (const [id, n] of Object.entries(attempts)) if (ids.has(id)) out[id] = n;
	return out;
}

/** Check a LazyReader answer; stop the run on 401, 429, 5xx or no answer. */
function guard(r: { ok: boolean; status?: number; error?: string }): void {
	if (r.status === 401) throw new StopRun('token', 'Lazy Reader did not accept the token. Copy it again from Lazy Reader, Settings.');
	if (r.status === 429) throw new StopRun('rate-limited', 'Lazy Reader asked us to slow down. Next run retries.');
	if ((r.status ?? 0) >= 500 || (!r.ok && r.status === undefined)) throw new StopRun('error', r.error || 'Lazy Reader could not be reached. Next run retries.');
}

/** Text for one item: worker fetch first, minimized window only when that fails the check. */
async function gatherText(deps: FinisherDeps, url: string): Promise<string> {
	let fetched = '';
	let stop = false;
	try {
		const page = await deps.fetchPage(url);
		// Gone, or redirected to a link we must not read: no window either,
		// since the window would follow the same redirect.
		if (page.status === 404 || page.status === 410 || !isSafeFetchUrl(page.finalUrl || url)) stop = true;
		else if (page.status >= 200 && page.status < 300 && page.html && page.html.length <= MAX_HTML_BYTES) {
			fetched = (await deps.extractHtml(page.html, page.finalUrl || url)).trim();
		}
	} catch {
		fetched = '';
	}
	if (stop) return '';
	if (checkFullText(fetched).ok || !deps.openForExtraction) return fetched;
	let opened: string | null = null;
	try {
		opened = await deps.openForExtraction(url);
	} catch {
		opened = null;
	}
	return pickBestText(fetched, (opened ?? '').trim());
}

/** One finish run. Never throws; the outcome goes to state and the result. */
export async function runFinisher(deps: FinisherDeps, trigger: FinishTrigger): Promise<FinishResult> {
	const result: FinishResult = { skipped: null, finished: 0, membersOnly: 0, unreadable: 0, retryLater: 0, stopped: null };
	const state = await loadFinishState(deps.store);
	const hasToken = await deps.hasToken();
	const hasAccess = deps.hasAccess ? await deps.hasAccess() : true;
	result.skipped = shouldRun(trigger, state, hasToken, deps.now(), hasAccess);
	if (result.skipped) return result;

	state.running = true;
	state.lastAttemptAt = deps.now();
	await saveFinishState(deps.store, state);

	const limit = trigger === 'now' ? NOW_LIMIT : AUTO_LIMIT;
	try {
		const listed = await deps.api.list();
		guard(listed);
		if (!listed.ok) throw new StopRun('error', listed.error || 'Could not read the waiting list');
		state.attempts = pruneAttempts(state.attempts, listed.items);
		state.triedAt = pruneAttempts(state.triedAt ?? {}, listed.items);
		state.waitingCount = listed.items.length;
		await saveFinishState(deps.store, state);

		const settle = async (id: string, r: ProvideResult): Promise<void> => {
			guard(r);
			if (!r.ok) { // 400/404/409 and the like: this item cannot be finished right now
				state.attempts[id] = (state.attempts[id] ?? 0) + 1;
				result.retryLater++;
				return;
			}
			delete state.attempts[id];
			if (r.outcome === 'members_only') result.membersOnly++;
			else result.finished++;
		};

		let first = true;
		// Automatic runs leave an item alone for an hour after the last try.
		const auto = trigger !== 'now';
		const eligible = auto
			? listed.items.filter((i) => { const t = state.triedAt[i.id]; return t === undefined || deps.now() - t >= ITEM_RETRY_MS; })
			: listed.items;
		for (const item of eligible.slice(0, limit)) {
			if (!first) await deps.sleep(jitter(deps, 2000, 4000));
			first = false;
			// Heartbeat: a long run keeps its lock fresh (stale after 15 min).
			state.lastAttemptAt = deps.now();

			state.triedAt[item.id] = deps.now();

			// A link we must not open is given up on without a fetch.
			if (!isSafeFetchUrl(item.url) || (state.attempts[item.id] ?? 0) >= MAX_ITEM_ATTEMPTS) {
				const r = await deps.api.markUnreadable(item.id);
				guard(r);
				if (r.ok) { delete state.attempts[item.id]; result.unreadable++; } else result.retryLater++;
				await saveFinishState(deps.store, state);
				continue;
			}

			const text = await gatherText(deps, item.url);
			if (!text || countWords(text) === 0) {
				state.attempts[item.id] = (state.attempts[item.id] ?? 0) + 1;
				if (state.attempts[item.id] >= MAX_ITEM_ATTEMPTS) {
					const r = await deps.api.markUnreadable(item.id);
					guard(r);
					if (r.ok) { delete state.attempts[item.id]; result.unreadable++; } else result.retryLater++;
				} else {
					result.retryLater++;
				}
				await saveFinishState(deps.store, state);
				continue;
			}
			// The server judges teaser or whole; a teaser comes back as members_only.
			await settle(item.id, await deps.api.provideText(item.id, fitReadingText(text)));
			await saveFinishState(deps.store, state);
		}
		state.lastError = null;
	} catch (e) {
		const stop = e instanceof StopRun ? e : new StopRun('error', e instanceof Error ? e.message : String(e));
		result.stopped = stop.reason;
		state.lastError = stop.message;
	}
	state.running = false;
	state.lastRunAt = deps.now();
	state.lastResult = `${result.finished} finished, ${result.membersOnly} members only, ${result.unreadable} could not be opened`;
	await saveFinishState(deps.store, state);
	return result;
}

/** Pure: the finisher is meant to run (on by default or switched on) but the all-sites grant is missing. */
export function finishNeedsAccess(s: FinishState, hasToken: boolean, hasAccess: boolean): boolean {
	return hasToken && isEnabled(s, hasToken) && !hasAccess;
}

/** Pure: the status line for the settings page. */
export function describeFinishStatus(s: FinishState, hasToken: boolean, now: number, hasAccess = true): string {
	const line = finishStatusLine(s, hasToken, now, hasAccess);
	return line.charAt(0).toUpperCase() + line.slice(1);
}

function finishStatusLine(s: FinishState, hasToken: boolean, now: number, hasAccess: boolean): string {
	if (!hasToken) return 'Connect to Lazy Reader first (see Connection).';
	if (!hasAccess) return 'Off until you allow access to the sites you save from.';
	if (!isEnabled(s, hasToken)) return 'Off';
	if (s.running && s.lastAttemptAt !== null && now - s.lastAttemptAt < STALE_LOCK_MS) return 'Finishing...';
	const waiting = s.waitingCount === null ? '' : `${s.waitingCount} waiting, `;
	if (s.lastError) return `${waiting}last run failed: ${s.lastError}`;
	if (s.lastRunAt === null) return `${waiting}no run yet`;
	const mins = Math.max(0, Math.round((now - s.lastRunAt) / 60000));
	const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
	return `${waiting}last run ${ago}${s.lastResult ? ` (${s.lastResult})` : ''}`;
}
