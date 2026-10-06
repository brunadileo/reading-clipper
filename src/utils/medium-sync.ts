// READ-36: bring the user's Medium saves (Reading list plus their own lists)
// into LazyReader from inside their own signed-in browser. Button-only: the
// runner never runs this from the timer. No Medium cookie is read, stored or
// sent: fetch() with credentials 'include' lets the browser attach its own.
// Nothing is ever written to Medium and the clipper never sends its own
// GraphQL request (a hand-made one hit a Cloudflare challenge in the probe).
//
// SHAPES (observed in the 2026-10-06 probe, see the plan Facts):
//   GET https://medium.com/me/lists  -> HTML with `window.__APOLLO_STATE__ = {...}`
//     ROOT_QUERY.viewer -> User:<id> (username), Membership (tier), Catalog:<id>
//     (id, type, predefined, creator, postItemsCount).
//   GET https://medium.com/@<username>/list/<catalogId | reading-list>
//     -> its own state: one Catalog, itemsConnection (20 newest items first),
//     CatalogItemV2 (catalogItemId = Mongo ObjectId, first 8 hex = added-at
//     seconds) -> Post (id, title, mediumUrl, isLocked).
//   Beyond 20 items the list page is opened in a minimized window and scrolled
//   so Medium's own JS pages it (openListAndCollect, injected).
import {
	MAX_ATTEMPTS, countWords, isTransientSend, jitter, loadState, saveState, sendWithRetry,
	type SyncDeps, type SyncPost, type SyncState,
} from './sync-core';
import { MIN_WORDS } from './substack-sync';
import { isSafeFetchUrl, type FullTextCheck } from './full-text-check';

export const MEDIUM_ORIGIN = 'https://medium.com';
export const MEDIUM_LIBRARY_URL = `${MEDIUM_ORIGIN}/me/lists`;
export const MEDIUM_RUN_POSTS = 100;
export const MEDIUM_STOP_AFTER_KNOWN = 3;
export const MEDIUM_MAX_CONSECUTIVE_FAILURES = 5;
export const MEDIUM_PAGE_SIZE = 20;
export const MEDIUM_MAX_STALLS = 2;
export const MEDIUM_SIGNED_OUT = 'Sign in to Medium in this browser';
export const MEDIUM_RATE_LIMITED = 'Medium asked us to slow down. Try again later.';

export type MediumRunKind = 'manual' | 'older';

export interface MediumRunResult {
	sent: number;
	// Sent as a link alone, to be finished by the waiting-article job.
	linkOnly: number;
	failed: number;
	username: string | null;
	tier: string | null;
	stopped: 'signed-out' | 'rate-limited' | 'token' | 'failures' | 'error' | null;
	message: string | null;
}

export interface MediumList {
	catalogId: string;
	postItemsCount: number;
	predefined: boolean;
}

export interface MediumLibrary {
	viewerId: string;
	username: string;
	tier: string | null;
	lists: MediumList[];
}

export interface MediumListItem {
	postId: string;
	catalogItemId: string;
	addedAt: number;
	title: string;
	url: string;
	locked: boolean;
}

export interface MediumListPage {
	items: MediumListItem[];
	count: number;
}

/** What the list-page scroller found: posts not already known, all links seen, and whether the list ran out. */
export interface MediumCollected {
	posts: Array<{ postId: string; title: string; url: string }>;
	total: number;
	ended: boolean;
	// A Cloudflare challenge or sign-in page instead of the list.
	blocked?: boolean;
}

export interface MediumDeps extends SyncDeps {
	fetchPage: (url: string) => Promise<{ status: number; html: string; finalUrl: string }>;
	extractHtml: (html: string, url: string) => Promise<string>;
	checkFullText: (text: string) => FullTextCheck;
	openListAndCollect: (url: string, wantNew: number, knownPostIds: string[], listCount: number) => Promise<MediumCollected>;
}

// --- pure parsers ----------------------------------------------------------

const MARKER = 'window.__APOLLO_STATE__ = ';

/** The Apollo state object from a Medium page, or null (absent, bad JSON, Cloudflare challenge). */
export function extractApolloState(html: string): Record<string, any> | null {
	if (typeof html !== 'string' || !html) return null;
	if (/<title>\s*just a moment/i.test(html)) return null;
	const at = html.indexOf(MARKER);
	if (at < 0) return null;
	const start = at + MARKER.length;
	const end = html.indexOf('</script>', start);
	let raw = (end < 0 ? html.slice(start) : html.slice(start, end)).trim();
	if (raw.endsWith(';')) raw = raw.slice(0, -1).trim();
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}

const refKey = (r: any): string | null => (r && typeof r === 'object' && typeof r.__ref === 'string' ? r.__ref : null);

/** Viewer, membership tier and the user's own lists. null when nobody is signed in. */
export function parseLibrary(state: Record<string, any> | null): MediumLibrary | null {
	if (!state) return null;
	const viewerKey = refKey(state.ROOT_QUERY?.viewer);
	const user = viewerKey ? state[viewerKey] : null;
	if (!viewerKey || !user || typeof user !== 'object') return null;
	const viewerId = String(user.id ?? viewerKey.replace(/^User:/, ''));
	const username = typeof user.username === 'string' ? user.username : '';
	if (!viewerId || !username) return null;

	let tier: string | null = null;
	for (const key of Object.keys(state)) {
		if (/^Membership/.test(key) && typeof state[key]?.tier === 'string') { tier = state[key].tier; break; }
	}

	const lists: MediumList[] = [];
	for (const key of Object.keys(state)) {
		if (!key.startsWith('Catalog:')) continue;
		const c = state[key];
		if (!c || typeof c.id !== 'string') continue;
		const predefined = c.type === 'PREDEFINED_LIST' || !!c.predefined;
		const creator = refKey(c.creator);
		const own = creator ? creator === viewerKey : c.id.startsWith(`predefined:${viewerId}:`);
		if (!own) continue;
		// Of the predefined lists only the Reading list is a save list.
		if (predefined && !/READING_LIST/.test(`${c.id} ${typeof c.predefined === 'string' ? c.predefined : ''}`)) continue;
		const count = Number(c.postItemsCount);
		lists.push({ catalogId: c.id, postItemsCount: Number.isFinite(count) ? count : 0, predefined });
	}
	return { viewerId, username, tier, lists };
}

/** A member: any non-empty tier except a free/none value (MEMBER, FRIEND_OF_MEDIUM and any paid tier), case-insensitive. */
export function isMemberTier(tier: string | null): boolean {
	if (typeof tier !== 'string') return false;
	const t = tier.trim().toUpperCase();
	return t !== '' && !/^(NONE|FREE|NON[_ -]?MEMBER|NOT[_ -]?MEMBER)$/.test(t);
}

/** Added-at time in ms from a 24-hex catalogItemId (the first 8 hex are seconds), or null. */
export function addedAtFromCatalogItemId(id: string): number | null {
	if (typeof id !== 'string' || !/^[0-9a-f]{24}$/i.test(id)) return null;
	return parseInt(id.slice(0, 8), 16) * 1000;
}

/** A post link without its query string and fragment. */
export function stripQuery(url: string): string {
	try {
		const u = new URL(url);
		return `${u.origin}${u.pathname}`;
	} catch {
		return url.split(/[?#]/)[0];
	}
}

/** One list page's items (title and link from the Post) and the list's total count. */
export function parseListPage(state: Record<string, any> | null): MediumListPage {
	const empty: MediumListPage = { items: [], count: 0 };
	if (!state) return empty;
	const catKey = Object.keys(state).find((k) => k.startsWith('Catalog:'));
	const catalog = catKey ? state[catKey] : null;
	if (!catalog || typeof catalog !== 'object') return empty;
	let best: any = null;
	for (const k of Object.keys(catalog)) {
		if (!/^itemsConnection/.test(k)) continue;
		const conn = catalog[k];
		if (conn && Array.isArray(conn.items) && (!best || conn.items.length > best.items.length)) best = conn;
	}
	if (!best) return { items: [], count: Number(catalog.postItemsCount) || 0 };
	const items: MediumListItem[] = [];
	for (const ref of best.items) {
		const item = state[refKey(ref) ?? ''];
		const post = state[refKey(item?.entity) ?? ''];
		if (!item || !post) continue;
		const postId = String(post.id ?? '');
		const url = typeof post.mediumUrl === 'string' ? stripQuery(post.mediumUrl) : '';
		if (!/^[0-9a-f]{12}$/i.test(postId) || !/^https:\/\//.test(url)) continue;
		const catalogItemId = String(item.catalogItemId ?? '');
		items.push({
			postId,
			catalogItemId,
			addedAt: addedAtFromCatalogItemId(catalogItemId) ?? 0,
			title: String(post.title ?? ''),
			url,
			locked: post.isLocked === true || post.visibility === 'LOCKED',
		});
	}
	const count = Number(best.paging?.count);
	return { items, count: Number.isFinite(count) && count > 0 ? count : Number(catalog.postItemsCount) || items.length };
}

/** The list page address for an own list. The Reading list lives at /list/reading-list. */
export function listUrl(username: string, list: MediumList): string {
	return `${MEDIUM_ORIGIN}/@${username}/list/${list.predefined ? 'reading-list' : list.catalogId}`;
}

const toPost = (postId: string, url: string, title: string): SyncPost => ({
	id: `md:${postId}`,
	url,
	title: title || 'Medium story',
	siteName: 'Medium',
});

// --- run -------------------------------------------------------------------

class SkipText extends Error {}

const isMediumPostUrl = (raw: string): boolean => {
	if (!isSafeFetchUrl(raw)) return false;
	const h = new URL(raw).hostname.toLowerCase();
	return h === 'medium.com' || h.endsWith('.medium.com');
};

class StopRun extends Error {
	constructor(public reason: NonNullable<MediumRunResult['stopped']>, message: string) {
		super(message);
	}
}

function checkStatus(status: number): void {
	if (status === 401 || status === 403) throw new StopRun('signed-out', MEDIUM_SIGNED_OUT);
	if (status === 429) throw new StopRun('rate-limited', MEDIUM_RATE_LIMITED);
}

async function getState(deps: SyncDeps, url: string): Promise<{ state: Record<string, any> | null; status: number }> {
	const res = await deps.fetchFn(url, { credentials: 'include', headers: { Accept: 'text/html' } });
	checkStatus(res.status);
	if (res.status === 404) return { state: null, status: 404 };
	if (!res.ok) throw new StopRun('error', `Medium answered ${res.status}`);
	return { state: extractApolloState(await res.text()), status: res.status };
}

function remember(state: SyncState, id: string): void {
	if (!state.knownIds.includes(id)) state.knownIds.push(id);
	state.pending = state.pending.filter((p) => p.id !== id);
}

interface Cand { post: SyncPost; addedAt: number; listId: string }

/** One sync run. Never throws; the outcome goes to state and the result. */
export async function runMediumSync(deps: MediumDeps, kind: MediumRunKind): Promise<MediumRunResult> {
	const result: MediumRunResult = { sent: 0, linkOnly: 0, failed: 0, username: null, tier: null, stopped: null, message: null };
	const state = await loadState(deps.store, 'medium');
	if (!state.enabled) return result;
	// A run killed with the service worker leaves running set; it counts as stale after 15 minutes.
	if (state.running && deps.now() - (state.lastAttemptAt ?? 0) < 15 * 60 * 1000) return result;
	const isOlder = kind === 'older';
	if (isOlder && state.olderExhausted) {
		result.message = 'No older saves left.';
		return result;
	}
	state.running = true;
	state.lastAttemptAt = deps.now();
	await saveState(deps.store, 'medium', state);

	let consecutive = 0;
	try {
		// 1. Who is signed in, which lists are theirs.
		const lib = parseLibrary((await getState(deps, MEDIUM_LIBRARY_URL)).state);
		if (!lib) throw new StopRun('signed-out', MEDIUM_SIGNED_OUT);
		result.username = lib.username;
		result.tier = lib.tier;

		const known = new Set(state.knownIds);
		const firstRun = state.lastSuccess === null && state.knownIds.length === 0 && !state.lists;
		const cursors = { ...(state.lists ?? {}) };
		const failedOut = (id: string) => (state.failed[id] ?? 0) >= MAX_ATTEMPTS;

		// 2. First page (20 newest) of each own list by plain GET.
		const cands = new Map<string, Cand>();
		const firstPageCount: Record<string, number> = {};
		// Whether the scan of a list's first page reached its end (a break at 3 known leaves items unseen).
		const scanComplete: Record<string, boolean> = {};
		const unlockedIds = new Set<string>();
		let listIndex = 0;
		for (const list of lib.lists) {
			if (list.postItemsCount <= 0) { cursors[list.catalogId] = { seen: 0, exhausted: true }; continue; }
			if (listIndex++ > 0) await deps.sleep(jitter(deps, 2000, 4000));
			const { state: apollo, status } = await getState(deps, listUrl(lib.username, list));
			if (status === 404) continue;
			if (!apollo) throw new StopRun('signed-out', MEDIUM_SIGNED_OUT);
			const page = parseListPage(apollo);
			firstPageCount[list.catalogId] = page.items.length;
			let knownRun = 0;
			scanComplete[list.catalogId] = true;
			for (const it of page.items) {
				const id = `md:${it.postId}`;
				if (!it.locked) unlockedIds.add(id);
				if (known.has(id) || failedOut(id)) {
					knownRun++;
					// Later syncs stop scanning a list after 3 known in a row (newest first).
					if (!isOlder && !firstRun && knownRun >= MEDIUM_STOP_AFTER_KNOWN) { scanComplete[list.catalogId] = false; break; }
					continue;
				}
				knownRun = 0;
				const prev = cands.get(id);
				if (!prev || it.addedAt > prev.addedAt) cands.set(id, { post: toPost(it.postId, it.url, it.title), addedAt: it.addedAt, listId: list.catalogId });
			}
		}

		// 3. The batch: items left in pending by a stopped run first, then the newest.
		const batch: SyncPost[] = state.pending.filter((p) => !known.has(p.id) && !failedOut(p.id));
		const inBatch = new Set(batch.map((p) => p.id));
		const sorted = [...cands.entries()].filter(([id]) => !inBatch.has(id)).sort((a, b) => b[1].addedAt - a[1].addedAt);
		const leftoverLists = new Set<string>();
		for (const [id, c] of sorted) {
			if (batch.length < MEDIUM_RUN_POSTS) { batch.push(c.post); inBatch.add(id); } else leftoverLists.add(c.listId);
		}

		// 4. Load older: past the first page, let Medium's own JS page the list in a minimized window.
		const deepUpdates: Record<string, { seen: number; exhausted: boolean; stalls: number }> = {};
		if (isOlder) {
			let remaining = MEDIUM_RUN_POSTS - batch.length;
			for (const list of lib.lists) {
				if (remaining <= 0) break;
				const cur = cursors[list.catalogId] ?? { seen: 0, exhausted: false };
				const first = firstPageCount[list.catalogId];
				if (first === undefined || cur.exhausted || list.postItemsCount <= Math.max(cur.seen, first)) continue;
				await deps.sleep(jitter(deps, 2000, 4000));
				let got: MediumCollected;
				try {
					got = await deps.openListAndCollect(listUrl(lib.username, list), remaining, [...known, ...inBatch].map((id) => id.replace(/^md:/, '')), list.postItemsCount);
				} catch (e) {
					// One list that cannot be read must not lose the batch: skip it, keep the cursor.
					result.message = `Could not read a list page: ${e instanceof Error ? e.message : String(e)}. Press Load older to try again.`;
					continue;
				}
				if (got.blocked) throw new StopRun('signed-out', MEDIUM_SIGNED_OUT);
				let added = 0;
				for (const p of got.posts) {
					const id = `md:${p.postId}`;
					if (known.has(id) || inBatch.has(id) || failedOut(id)) continue;
					batch.push(toPost(p.postId, stripQuery(p.url), p.title));
					inBatch.add(id);
					added++;
				}
				remaining -= added;
				// A stalled scroll (a minimized window throttles the page) is not the end of the list.
				const finished = got.ended && got.total >= list.postItemsCount;
				if (got.ended && !finished) result.message = 'Medium stopped loading a list before the end. Press Load older again to continue.';
				// Two passes in a row with nothing new: the count includes posts the page never shows.
				const stalls = added > 0 || finished ? 0 : (cur.stalls ?? 0) + 1;
				deepUpdates[list.catalogId] = { seen: Math.max(cur.seen, got.total), exhausted: finished || stalls >= MEDIUM_MAX_STALLS, stalls };
			}
		}

		state.pending = [...batch];
		await saveState(deps.store, 'medium', state);

		// 5. Text in this browser, then send. A wall, a preview or any error sends the link alone.
		let firstSend = true;
		for (const post of [...batch]) {
			if (!firstSend) await deps.sleep(jitter(deps, 2000, 4000));
			firstSend = false;
			let text: string | undefined;
			try {
				// Only Medium's own pages are read; without a member tier only posts seen as unlocked on a list page are read.
				if (!isMediumPostUrl(post.url) || (!isMemberTier(lib.tier) && !unlockedIds.has(post.id))) throw new SkipText();
				const page = await deps.fetchPage(post.url);
				if (page.status === 429) throw new StopRun('rate-limited', MEDIUM_RATE_LIMITED);
				if (page.status === 401 || page.status === 403 || /<title>\s*just a moment/i.test(page.html)) throw new StopRun('signed-out', MEDIUM_SIGNED_OUT);
				if (page.status >= 200 && page.status < 300 && page.html) {
					const body = await deps.extractHtml(page.html, page.finalUrl || post.url);
					if (countWords(body) >= MIN_WORDS && deps.checkFullText(body).ok) text = body;
				}
			} catch (e) {
				if (e instanceof StopRun) throw e;
				text = undefined; // SkipText or any read error: the link alone
			}
			const sent = await sendWithRetry(deps, post, text);
			if (sent.status === 401) throw new StopRun('token', 'Lazy Reader did not accept the token. Copy it again from Lazy Reader, Settings.');
			// Still no good answer after the retries: stop. Pending and state are saved, so the next Sync continues here.
			if (isTransientSend(sent)) throw new StopRun('error', `Lazy Reader did not answer (status ${sent.status ?? 'none'}). Press Sync to continue.`);
			if (sent.status === 429) throw new StopRun('error', sent.error || 'Lazy Reader could not be reached. Try again later.');
			if (!sent.ok) {
				state.failed[post.id] = (state.failed[post.id] ?? 0) + 1;
				result.failed++;
				consecutive++;
				if (consecutive >= MEDIUM_MAX_CONSECUTIVE_FAILURES) throw new StopRun('failures', 'Five posts in a row could not be sent. Try again later.');
			} else {
				consecutive = 0;
				result.sent++;
				if (text === undefined) result.linkOnly++;
				remember(state, post.id);
				delete state.failed[post.id];
			}
			await saveState(deps.store, 'medium', state);
		}

		// 6. Cursors move only after a run that got to the end.
		for (const list of lib.lists) {
			const prev = cursors[list.catalogId] ?? { seen: 0, exhausted: false };
			const first = firstPageCount[list.catalogId];
			if (first === undefined) { cursors[list.catalogId] = prev; continue; }
			const firstPageOnly = list.postItemsCount <= first;
			const covered = firstPageOnly && scanComplete[list.catalogId] !== false && !leftoverLists.has(list.catalogId);
			const deep = deepUpdates[list.catalogId];
			// A list the first page covers is judged fresh every run; a deeper list keeps what Load older proved.
			cursors[list.catalogId] = deep
				? { seen: Math.max(deep.seen, first), exhausted: deep.exhausted || prev.exhausted, stalls: deep.stalls }
				: { seen: Math.max(prev.seen, first), exhausted: firstPageOnly ? covered : prev.exhausted };
		}
		state.lists = cursors;
		state.olderExhausted = lib.lists.length > 0 && lib.lists.every((l) => cursors[l.catalogId]?.exhausted);
		state.lastSuccess = deps.now();
		state.lastError = null;
		state.signedOut = false;
	} catch (e) {
		const stop = e instanceof StopRun ? e : new StopRun('error', e instanceof Error ? e.message : String(e));
		result.stopped = stop.reason;
		result.message = stop.message;
		if (stop.reason === 'signed-out') {
			state.signedOut = true;
			state.lastError = null;
		} else {
			state.lastError = stop.message;
		}
	}
	state.running = false;
	state.lastRunAt = deps.now();
	state.lastResult = `${result.sent} saved${result.linkOnly ? `, ${result.linkOnly} as links to finish` : ''}${result.failed ? `, ${result.failed} failed` : ''}`;
	await saveState(deps.store, 'medium', state);
	return result;
}
