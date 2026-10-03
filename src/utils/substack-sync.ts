// READ-37: bring the user's Substack saves into LazyReader from inside their
// own signed-in browser. No Substack cookie is read, stored or sent anywhere:
// fetch() with credentials 'include' lets the browser attach its own.
//
// ASSUMED SHAPES (from reading-wiki/scripts/substack_saved_list.py, not yet
// probed in a signed-in browser; see the live-probe list in the plan Run log):
//   GET https://substack.com/api/v1/reader/saved?limit=20&cursor=<c>
//     -> { items: [{ entity_key: "p-<id>", post: { canonical_url, title,
//          publication: { name } } }], nextCursor }
//   GET <canonical origin>/api/v1/posts/<slug> -> { body_html }
import {
	MAX_ATTEMPTS, countWords, htmlToText, jitter, loadState, looksLikeLoginPage, saveState,
	type SyncDeps, type SyncPost, type SyncState,
} from './sync-core';

export const SUBSTACK_LIST_URL = 'https://substack.com/api/v1/reader/saved';
export const PAGE_SIZE = 20;
export const FIRST_RUN_POSTS = 100;
export const MAX_PAGES_NEW = 5;
export const ALARM_RUN_POSTS = 20;
export const MANUAL_RUN_POSTS = 100;
export const MIN_WORDS = 150;
export const MAX_CONSECUTIVE_FAILURES = 5;

export type SubstackRunKind = 'alarm' | 'manual' | 'older';

export interface SubstackRunResult {
	sent: number;
	failed: number;
	stopped: 'signed-out' | 'rate-limited' | 'token' | 'failures' | 'error' | null;
}

interface ListPage {
	posts: SyncPost[];
	nextCursor: string | null;
}

class StopRun extends Error {
	constructor(public reason: NonNullable<SubstackRunResult['stopped']>, message: string) {
		super(message);
	}
}

function checkStatus(status: number): void {
	if (status === 401 || status === 403) throw new StopRun('signed-out', 'Sign in to Substack in this browser');
	if (status === 429) throw new StopRun('rate-limited', 'Substack asked us to slow down. Next run retries.');
}

/** Pure: one saved-list response body to posts. Items without a URL are dropped. */
export function parseSavedPage(json: any): ListPage {
	const items = Array.isArray(json?.items) ? json.items : [];
	const posts: SyncPost[] = [];
	for (const it of items) {
		const post = it?.post;
		const url = post?.canonical_url;
		const id = typeof it?.entity_key === 'string' ? it.entity_key : '';
		if (!id || typeof url !== 'string' || !/^https:\/\//.test(url)) continue;
		posts.push({
			id,
			url,
			title: String(post.title ?? ''),
			siteName: String(post.publication?.name ?? ''),
		});
	}
	const next = json?.nextCursor;
	return { posts, nextCursor: typeof next === 'string' && next ? next : null };
}

async function fetchListPage(deps: SyncDeps, cursor: string | null): Promise<ListPage> {
	const url = `${SUBSTACK_LIST_URL}?limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
	const res = await deps.fetchFn(url, { credentials: 'include', headers: { Accept: 'application/json' } });
	checkStatus(res.status);
	if (!res.ok) throw new StopRun('error', `Substack answered ${res.status}`);
	let json: any;
	try {
		json = await res.json();
	} catch {
		// HTML instead of JSON: a sign-in page.
		throw new StopRun('signed-out', 'Sign in to Substack in this browser');
	}
	return parseSavedPage(json);
}

/** Post API URL on the post's own origin (custom domains included), or null. */
export function postApiUrl(canonicalUrl: string): string | null {
	try {
		const u = new URL(canonicalUrl);
		const m = u.pathname.match(/^\/p\/([^/?#]+)/);
		return m ? `${u.origin}/api/v1/posts/${m[1]}` : null;
	} catch {
		return null;
	}
}

/**
 * Fetch one post's text with the user's session. Returns text, or null for a
 * failure that counts toward the retry limit (short text, login page).
 */
export async function fetchPostText(deps: SyncDeps, post: SyncPost): Promise<string | null> {
	const api = postApiUrl(post.url);
	if (!api) return null;
	const res = await deps.fetchFn(api, { credentials: 'include', headers: { Accept: 'application/json' } });
	checkStatus(res.status);
	if (!res.ok) return null;
	let body: any;
	try {
		body = await res.json();
	} catch {
		return null;
	}
	const html = typeof body?.body_html === 'string' ? body.body_html : '';
	const text = htmlToText(html);
	if (countWords(text) < MIN_WORDS || looksLikeLoginPage(text)) return null;
	return isPreview(body, text) ? text + PREVIEW_NOTE : text;
}

export const PREVIEW_NOTE =
	'\n\n[LazyReader: this is the free preview of a paid post. The rest is for paying subscribers.]';

/**
 * A paid post the user does not pay for comes back cut short (seen 2026-10-03:
 * 1,300 of 2,080 and 876 of 1,914 words, with truncated_body_text set).
 */
export function isPreview(body: any, text: string): boolean {
	if (!body || body.audience === 'everyone' || body.audience === undefined) return false;
	if (body.truncated_body_text) return true;
	const full = Number(body.wordcount);
	return Number.isFinite(full) && full > 0 && countWords(text) < full * 0.8;
}

function remember(state: SyncState, id: string): void {
	if (!state.knownIds.includes(id)) state.knownIds.push(id);
	state.pending = state.pending.filter((p) => p.id !== id);
}

/** Add posts the library does not know yet to the pending queue. */
async function discover(deps: SyncDeps, state: SyncState, kind: SubstackRunKind): Promise<void> {
	const known = new Set([...state.knownIds, ...state.pending.map((p) => p.id), ...Object.keys(state.failed).filter((k) => state.failed[k] >= MAX_ATTEMPTS)]);
	const firstRun = state.lastSuccess === null && state.knownIds.length === 0 && state.olderCursor === null && !state.olderExhausted;

	if (kind === 'older') {
		if (state.olderExhausted) return;
		let cursor = state.olderCursor;
		let added = 0;
		for (let page = 0; page < MAX_PAGES_NEW && added < FIRST_RUN_POSTS; page++) {
			if (page > 0) await deps.sleep(jitter(deps, 2000, 4000));
			const { posts, nextCursor } = await fetchListPage(deps, cursor);
			for (const p of posts) if (!known.has(p.id)) { state.pending.push(p); known.add(p.id); added++; }
			cursor = nextCursor;
			state.olderCursor = cursor;
			if (!cursor) { state.olderExhausted = true; break; }
		}
		return;
	}

	let cursor: string | null = null;
	const maxPages = firstRun ? FIRST_RUN_POSTS / PAGE_SIZE : MAX_PAGES_NEW;
	let sawKnown = false;
	for (let page = 0; page < maxPages && !sawKnown; page++) {
		if (page > 0) await deps.sleep(jitter(deps, 2000, 4000));
		const { posts, nextCursor } = await fetchListPage(deps, cursor);
		for (const p of posts) {
			if (known.has(p.id)) sawKnown = true;
			else { state.pending.push(p); known.add(p.id); }
		}
		cursor = nextCursor;
		if (!cursor) { if (firstRun) state.olderExhausted = true; break; }
		// After the first run, "Load older" continues from where the first run stopped.
		if (firstRun && page === maxPages - 1) state.olderCursor = cursor;
	}
}

/** One sync run. Never throws; the outcome goes to state and the result. */
export async function runSubstackSync(deps: SyncDeps, kind: SubstackRunKind): Promise<SubstackRunResult> {
	const result: SubstackRunResult = { sent: 0, failed: 0, stopped: null };
	const state = await loadState(deps.store, 'substack');
	if (!state.enabled) return result;
	// A run killed with the service worker leaves running set; it counts as stale after 15 minutes.
	if (state.running && deps.now() - (state.lastAttemptAt ?? 0) < 15 * 60 * 1000) return result;
	state.running = true;
	state.lastAttemptAt = deps.now();
	await saveState(deps.store, 'substack', state);

	const limit = kind === 'alarm' ? ALARM_RUN_POSTS : MANUAL_RUN_POSTS;
	let consecutive = 0;
	try {
		await discover(deps, state, kind);
		await saveState(deps.store, 'substack', state);

		const batch = state.pending.filter((p) => (state.failed[p.id] ?? 0) < MAX_ATTEMPTS).slice(0, limit);
		let first = true;
		for (const post of batch) {
			if (!first) await deps.sleep(jitter(deps, 2000, 4000));
			first = false;
			const text = await fetchPostText(deps, post);
			if (text === null) {
				state.failed[post.id] = (state.failed[post.id] ?? 0) + 1;
				result.failed++;
				consecutive++;
				if (consecutive >= MAX_CONSECUTIVE_FAILURES) throw new StopRun('failures', 'Five posts in a row could not be read. Next run retries.');
				await saveState(deps.store, 'substack', state);
				continue;
			}
			const sent = await deps.send(post, text);
			if (sent.status === 401) throw new StopRun('token', 'LazyReader did not accept the token. Copy it again from LazyReader, Settings.');
			if (sent.status === 429 || (sent.status ?? 0) >= 500 || (!sent.ok && sent.status === undefined)) {
				throw new StopRun('error', sent.error || 'LazyReader could not be reached. Next run retries.');
			}
			if (!sent.ok) {
				state.failed[post.id] = (state.failed[post.id] ?? 0) + 1;
				result.failed++;
				consecutive++;
			} else {
				consecutive = 0;
				result.sent++;
				remember(state, post.id);
				delete state.failed[post.id];
			}
			await saveState(deps.store, 'substack', state);
		}
		state.lastSuccess = deps.now();
		state.lastError = null;
		state.signedOut = false;
	} catch (e) {
		const stop = e instanceof StopRun ? e : new StopRun('error', e instanceof Error ? e.message : String(e));
		result.stopped = stop.reason;
		if (stop.reason === 'signed-out') {
			state.signedOut = true;
			state.lastError = null;
		} else {
			state.lastError = stop.message;
		}
	}
	state.running = false;
	state.lastRunAt = deps.now();
	state.lastResult = `${result.sent} saved, ${result.failed} could not be read`;
	await saveState(deps.store, 'substack', state);
	return result;
}
