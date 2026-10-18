// READ-442: add a selection or a link to one of the owner's lists from the
// right-click menu. The two server doors (clipperAddToList, clipperUndoAdd) take
// the clipper's token; the lists for the submenu come from shareTypes.
// Everything here runs in the background worker (the endpoints send no CORS headers).
//   POST {base}/shareTypes        x-reader-token, {}                      -> { types: [{ slug, label, color }] }
//   POST {base}/clipperAddToList  x-reader-token, { list, text } | { list, url, title? }
//        -> { id, created, status, list_label } | { already_exists, message } | { filed, from }
//   POST {base}/clipperUndoAdd    x-reader-token, { id }                  -> { ok: true } | 404
import browser from 'webextension-polyfill';
import { endpointUrl } from './waiting-api';

export const MAX_LIST_TEXT_CHARS = 2000;
export const MAX_LIST_TITLE_CHARS = 300;
export const LISTS_MAX_AGE_MS = 60 * 60 * 1000;

export interface ListInfo {
	slug: string;
	label: string;
}

export interface Connection {
	token: string;
	captureUrl: string;
	fetchFn?: typeof fetch;
}

/** What a menu click asks for: a selection as typed, or a link with its title. */
export interface AddRequest {
	list: string;
	// Shown in the note; the server's own label wins when it sends one.
	label: string;
	text?: string;
	url?: string;
	title?: string;
}

export type AddErrorCode = 'not-connected' | 'offline' | 'too-long' | 'bad-input' | 'failed';

export type AddOutcome =
	| { kind: 'added'; id: string; label: string; canUndo: boolean; descriptionFailed: boolean }
	| { kind: 'already'; label: string }
	| { kind: 'moved'; label: string }
	| { kind: 'error'; code: AddErrorCode; message?: string };

export type UndoOutcome =
	| { kind: 'removed' }
	| { kind: 'error'; code: 'not-connected' | 'offline' | 'kept' | 'failed' };

export interface StoredLists {
	lists: ListInfo[];
	at: number;
}

const LISTS_KEY = 'readingLists';
const LAST_USED_KEY = 'readingListLastUsed';

/** Collapse whitespace, trim and cut to `max` whole characters (never half an emoji). */
export function collapseTitle(raw: unknown, max: number = MAX_LIST_TITLE_CHARS): string {
	if (typeof raw !== 'string') return '';
	const flat = raw.replace(/\s+/g, ' ').trim();
	const chars = Array.from(flat);
	return chars.length > max ? chars.slice(0, max).join('').trim() : flat;
}

/** Pure: a shareTypes body to lists. Entries without a slug are dropped; duplicates keep the first. */
export function parseLists(json: any): ListInfo[] {
	const types = Array.isArray(json?.types) ? json.types : [];
	const seen = new Set<string>();
	const out: ListInfo[] = [];
	for (const t of types) {
		if (!t || typeof t.slug !== 'string' || !t.slug || seen.has(t.slug)) continue;
		seen.add(t.slug);
		out.push({ slug: t.slug, label: typeof t.label === 'string' && t.label.trim() ? t.label : t.slug });
	}
	return out;
}

/** Pure: the last used list first, the rest in the owner's order. An unknown lastUsed changes nothing. */
export function orderLists(lists: ListInfo[], lastUsed: string | null | undefined): ListInfo[] {
	if (!Array.isArray(lists)) return [];
	const first = lastUsed ? lists.find(l => l.slug === lastUsed) : undefined;
	return first ? [first, ...lists.filter(l => l !== first)] : [...lists];
}

/**
 * Pure: Chrome may cut selectionText short. When the page's own selection starts
 * with the same text and is longer, the page's wins; otherwise Chrome's text.
 */
export function pickSelection(infoText: unknown, pageText: unknown): string {
	const a = typeof infoText === 'string' ? infoText.trim() : '';
	// No selection under the click (a link outside the selection): the page's selection is not this click's.
	if (!a) return '';
	const b = typeof pageText === 'string' ? pageText.trim() : '';
	if (b.length > a.length && b.replace(/\s+/g, ' ').startsWith(a.replace(/\s+/g, ' '))) return b;
	return a;
}

/** Pure: a request that came back in a message, rebuilt field by field; null when it is not one. */
export function sanitizeRequest(raw: any): AddRequest | null {
	if (!raw || typeof raw !== 'object' || typeof raw.list !== 'string' || !raw.list) return null;
	const label = typeof raw.label === 'string' && raw.label ? raw.label : raw.list;
	if (typeof raw.url === 'string' && raw.url) {
		if (raw.url.length > 2048 || !/^https?:\/\//i.test(raw.url)) return null;
		const title = collapseTitle(raw.title);
		return { list: raw.list, label, url: raw.url, ...(title ? { title } : {}) };
	}
	if (typeof raw.text === 'string' && raw.text.trim() && raw.text.length <= MAX_LIST_TEXT_CHARS) {
		return { list: raw.list, label, text: raw.text.trim() };
	}
	return null;
}

/** The lazyreader.app origin behind the capture URL; the default when it does not parse. */
export function appOrigin(captureUrl: string): string {
	try {
		const u = new URL(captureUrl);
		if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
	} catch { /* fall through */ }
	return 'https://lazyreader.app';
}

export function listUrl(captureUrl: string, slug?: string): string {
	return slug ? `${appOrigin(captureUrl)}/lists/${encodeURIComponent(slug)}` : `${appOrigin(captureUrl)}/lists`;
}

/**
 * Pure: the request for a click. A link wins over a selection; selected text inside
 * the link becomes its title, else the link text. Returns an error code instead of a
 * request when there is nothing to send or the selection is too long.
 */
export function buildAddRequest(
	list: ListInfo,
	input: { linkUrl?: string; selectionText?: string; linkText?: string }
): { request: AddRequest } | { error: AddErrorCode } {
	const linkUrl = typeof input.linkUrl === 'string' ? input.linkUrl.trim() : '';
	if (linkUrl) {
		const title = collapseTitle(input.selectionText) || collapseTitle(input.linkText);
		return { request: { list: list.slug, label: list.label, url: linkUrl, ...(title ? { title } : {}) } };
	}
	const text = typeof input.selectionText === 'string' ? input.selectionText.trim() : '';
	if (!text) return { error: 'bad-input' };
	if (text.length > MAX_LIST_TEXT_CHARS) return { error: 'too-long' };
	return { request: { list: list.slug, label: list.label, text } };
}

export const POST_TIMEOUT_MS = 30_000;

type Raw = { ok: boolean; status?: number; json?: any; networkError?: boolean };

async function post(conn: Connection, name: 'shareTypes' | 'clipperAddToList' | 'clipperUndoAdd', body: unknown): Promise<Raw & { missing?: boolean }> {
	const url = endpointUrl(conn.captureUrl, name);
	if (!conn.token || !url) return { ok: false, status: 401, missing: true };
	const fetchFn = conn.fetchFn ?? fetch;
	try {
		const res = await fetchFn(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-reader-token': conn.token },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(POST_TIMEOUT_MS),
		});
		let json: any;
		try { json = await res.json(); } catch { /* empty or non-JSON body */ }
		return { ok: res.ok, status: res.status, json };
	} catch (e) {
		// A timeout is not "offline": the server may have the item, so it reads as a plain failure.
		if ((e as { name?: string } | null)?.name === 'TimeoutError') return { ok: false };
		return { ok: false, networkError: true };
	}
}

/** Pure: the server said the list or type is gone (renamed or deleted elsewhere), so the cached menu is stale. */
export function isUnknownListError(outcome: AddOutcome): boolean {
	return outcome.kind === 'error' && outcome.code === 'bad-input'
		&& typeof outcome.message === 'string' && /^No (list|type) called/i.test(outcome.message);
}

/** Pure: an answer of clipperAddToList to an outcome. */
export function mapAddResponse(raw: Raw, fallbackLabel: string): AddOutcome {
	if (raw.networkError) return { kind: 'error', code: 'offline' };
	if (raw.status === 401) return { kind: 'error', code: 'not-connected' };
	if (raw.status === 413) return { kind: 'error', code: 'too-long' };
	if (raw.status === 400) {
		const message = typeof raw.json?.error === 'string' ? raw.json.error : undefined;
		return { kind: 'error', code: 'bad-input', message };
	}
	if (!raw.ok) return { kind: 'error', code: 'failed' };
	const j = raw.json;
	if (j && typeof j === 'object') {
		const label = typeof j.list_label === 'string' && j.list_label ? j.list_label : fallbackLabel;
		if (j.already_exists) return { kind: 'already', label };
		if (j.filed) {
			// A link that sat in the feed moves; an unfiled find is filed. Neither can be undone.
			return String(j.from ?? '').toLowerCase().includes('feed')
				? { kind: 'moved', label }
				: { kind: 'added', id: typeof j.id === 'string' ? j.id : '', label, canUndo: false, descriptionFailed: false };
		}
		if (typeof j.id === 'string' && j.id) {
			return { kind: 'added', id: j.id, label, canUndo: j.created === true, descriptionFailed: j.status === 'failed' };
		}
	}
	return { kind: 'error', code: 'failed' };
}

export async function addToList(conn: Connection, req: AddRequest): Promise<AddOutcome> {
	const body = req.url
		? { list: req.list, url: req.url, ...(req.title ? { title: req.title } : {}) }
		: { list: req.list, text: req.text ?? '' };
	return mapAddResponse(await post(conn, 'clipperAddToList', body), req.label);
}

export async function undoAdd(conn: Connection, id: string): Promise<UndoOutcome> {
	if (typeof id !== 'string' || !id) return { kind: 'error', code: 'failed' };
	const raw = await post(conn, 'clipperUndoAdd', { id });
	if (raw.networkError) return { kind: 'error', code: 'offline' };
	if (raw.status === 401) return { kind: 'error', code: 'not-connected' };
	if (raw.status === 404) return { kind: 'error', code: 'kept' };
	return raw.ok ? { kind: 'removed' } : { kind: 'error', code: 'failed' };
}

/** The cached lists (null when never fetched) and the last used slug. Storage failures read as empty. */
export async function loadLists(): Promise<{ stored: StoredLists | null; lastUsed: string | null }> {
	try {
		const r = await browser.storage.local.get([LISTS_KEY, LAST_USED_KEY]);
		const s = r[LISTS_KEY] as StoredLists | undefined;
		const stored = s && Array.isArray(s.lists) && typeof s.at === 'number' ? { lists: parseLists({ types: s.lists }), at: s.at } : null;
		return { stored, lastUsed: typeof r[LAST_USED_KEY] === 'string' ? (r[LAST_USED_KEY] as string) : null };
	} catch {
		return { stored: null, lastUsed: null };
	}
}

export async function saveLastUsed(slug: string): Promise<void> {
	try { await browser.storage.local.set({ [LAST_USED_KEY]: slug }); } catch { /* the order is a nicety */ }
}

/** Fetch the lists and cache them. Returns null (cache untouched) when the call fails. */
export async function refreshLists(conn: Connection, now: number = Date.now()): Promise<ListInfo[] | null> {
	const raw = await post(conn, 'shareTypes', {});
	if (!raw.ok || !Array.isArray(raw.json?.types)) return null;
	const lists = parseLists(raw.json);
	// If the cache cannot be written the menu would find it empty and ask again, forever: count it as a failure.
	try { await browser.storage.local.set({ [LISTS_KEY]: { lists, at: now } }); } catch { return null; }
	return lists;
}

export function listsAreStale(stored: StoredLists | null, now: number = Date.now()): boolean {
	return !stored || now - stored.at > LISTS_MAX_AGE_MS || stored.at > now + 60_000;
}

export interface MenuItemSpec {
	id: string;
	title?: string;
	type?: 'separator';
	parentId?: string;
	enabled?: boolean;
	contexts: Array<'selection' | 'link'>;
}

export const ADD_TO_LIST_ID = 'add-to-list';
export const ADD_TO_LIST_PREFIX = 'add-to-list:';
// States get their own prefix so a list called "none" can never be taken for one.
export const ADD_TO_LIST_STATE_PREFIX = 'add-to-list-state:';
export type ListMenuState = 'connect' | 'loading' | 'reload' | 'none';

/**
 * Pure: the parent and its children. `stored` null with a token means the lists have
 * not arrived (loading), or `failed` when the last fetch failed.
 */
export function listMenuItems(
	opts: { connected: boolean; stored: StoredLists | null; lastUsed: string | null; failed?: boolean },
	t: (key: string) => string
): MenuItemSpec[] {
	const contexts: Array<'selection' | 'link'> = ['selection', 'link'];
	const items: MenuItemSpec[] = [{ id: ADD_TO_LIST_ID, title: t('listAddMenu'), contexts }];
	const child = (state: ListMenuState, key: string, enabled = true) =>
		items.push({ id: `${ADD_TO_LIST_STATE_PREFIX}${state}`, parentId: ADD_TO_LIST_ID, title: t(key), enabled, contexts });
	if (!opts.connected) { child('connect', 'listAddConnect'); return items; }
	if (!opts.stored) {
		if (opts.failed) child('reload', 'listAddReload'); else child('loading', 'listAddLoading', false);
		return items;
	}
	if (opts.stored.lists.length === 0) { child('none', 'listAddNone'); return items; }
	orderLists(opts.stored.lists, opts.lastUsed).forEach((l, i) => {
		items.push({ id: `${ADD_TO_LIST_PREFIX}${l.slug}`, parentId: ADD_TO_LIST_ID, title: l.label, contexts });
		if (i === 0 && opts.stored!.lists.length > 1) {
			items.push({ id: `${ADD_TO_LIST_STATE_PREFIX}separator`, parentId: ADD_TO_LIST_ID, type: 'separator', contexts });
		}
	});
	return items;
}

/** Pure: the list behind a menu id, or the state it stands for. */
export function parseMenuId(id: unknown): { state: ListMenuState } | { slug: string } | null {
	if (typeof id !== 'string') return null;
	if (id.startsWith(ADD_TO_LIST_STATE_PREFIX)) {
		const state = id.slice(ADD_TO_LIST_STATE_PREFIX.length);
		return state === 'connect' || state === 'loading' || state === 'reload' || state === 'none' ? { state } : null;
	}
	if (!id.startsWith(ADD_TO_LIST_PREFIX)) return null;
	const slug = id.slice(ADD_TO_LIST_PREFIX.length);
	return slug ? { slug } : null;
}
