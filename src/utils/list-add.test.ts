import { describe, it, expect, vi } from 'vitest';
import browser from 'webextension-polyfill';
import {
	addToList, undoAdd, parseLists, orderLists, buildAddRequest, mapAddResponse, collapseTitle, pickSelection,
	sanitizeRequest, isUnknownListError, POST_TIMEOUT_MS, listMenuItems, parseMenuId, listUrl, appOrigin, refreshLists, loadLists, listsAreStale,
	MAX_LIST_TEXT_CHARS, type AddRequest,
} from './list-add';

const CAPTURE = 'https://lazyreader.app/api/capture';
const reply = (status: number, body: unknown) => vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
const conn = (fetchFn: any, token = 'tok') => ({ token, captureUrl: CAPTURE, fetchFn });
const books = { slug: 'book', label: 'Books' };

describe('collapseTitle', () => {
	it('collapses whitespace and trims', () => expect(collapseTitle('  a \n\t b  ')).toBe('a b'));
	it('returns empty for non-strings', () => {
		expect(collapseTitle(null)).toBe('');
		expect(collapseTitle(undefined)).toBe('');
		expect(collapseTitle(42)).toBe('');
	});
	it('cuts on whole characters, never half an emoji', () => {
		const out = collapseTitle('😀'.repeat(400));
		expect(Array.from(out).length).toBe(300);
		expect(out).not.toContain('�');
	});
	it('keeps unicode and script text as plain text', () => {
		expect(collapseTitle('Café <script>alert(1)</script>')).toBe('Café <script>alert(1)</script>');
	});
});

describe('parseLists and orderLists', () => {
	it('drops entries without a slug and duplicates', () => {
		expect(parseLists({ types: [{ slug: 'a', label: 'A' }, null, { label: 'x' }, { slug: 'a', label: 'Again' }, { slug: 'b' }] }))
			.toEqual([{ slug: 'a', label: 'A' }, { slug: 'b', label: 'b' }]);
	});
	it('survives junk', () => {
		expect(parseLists(null)).toEqual([]);
		expect(parseLists({ types: 'no' })).toEqual([]);
	});
	it('puts the last used first and keeps the owner order for the rest', () => {
		const l = [{ slug: 'a', label: 'A' }, { slug: 'b', label: 'B' }, { slug: 'c', label: 'C' }];
		expect(orderLists(l, 'c').map(x => x.slug)).toEqual(['c', 'a', 'b']);
	});
	it('ignores an unknown, empty or null last used', () => {
		const l = [{ slug: 'a', label: 'A' }, { slug: 'b', label: 'B' }];
		expect(orderLists(l, 'zzz').map(x => x.slug)).toEqual(['a', 'b']);
		expect(orderLists(l, null).map(x => x.slug)).toEqual(['a', 'b']);
		expect(orderLists(l, '').map(x => x.slug)).toEqual(['a', 'b']);
		expect(orderLists([], 'a')).toEqual([]);
		expect(orderLists(undefined as any, 'a')).toEqual([]);
	});
});

describe('buildAddRequest', () => {
	it('a selection is sent as typed (trimmed)', () => {
		expect(buildAddRequest(books, { selectionText: '  O Jeito Harvard de Ser Feliz Shawn Achor ' }))
			.toEqual({ request: { list: 'book', label: 'Books', text: 'O Jeito Harvard de Ser Feliz Shawn Achor' } });
	});
	it('the link wins over a selection and the selected text is the title (EC-9)', () => {
		expect(buildAddRequest(books, { linkUrl: 'https://a.com/x', selectionText: 'my  words', linkText: 'link text' }))
			.toEqual({ request: { list: 'book', label: 'Books', url: 'https://a.com/x', title: 'my words' } });
	});
	it('a link uses the link text, collapsed and capped at 300', () => {
		const r = buildAddRequest(books, { linkUrl: 'https://a.com/x', linkText: ' karakeep \n app ' }) as any;
		expect(r.request.title).toBe('karakeep app');
		const long = buildAddRequest(books, { linkUrl: 'https://a.com/x', linkText: 'x'.repeat(5000) }) as any;
		expect(long.request.title.length).toBe(300);
	});
	it('a link with no text sends no title (EC-10)', () => {
		const r = buildAddRequest(books, { linkUrl: 'https://a.com/x', linkText: '' }) as any;
		expect(r.request).toEqual({ list: 'book', label: 'Books', url: 'https://a.com/x' });
		expect('title' in r.request).toBe(false);
	});
	it('empty or missing selection is bad input', () => {
		expect(buildAddRequest(books, {})).toEqual({ error: 'bad-input' });
		expect(buildAddRequest(books, { selectionText: '   ' })).toEqual({ error: 'bad-input' });
		expect(buildAddRequest(books, { selectionText: 5 as any })).toEqual({ error: 'bad-input' });
	});
	it('2,000 characters pass, 2,001 are too long (EC-5)', () => {
		expect('request' in buildAddRequest(books, { selectionText: 'a'.repeat(MAX_LIST_TEXT_CHARS) })).toBe(true);
		expect(buildAddRequest(books, { selectionText: 'a'.repeat(MAX_LIST_TEXT_CHARS + 1) })).toEqual({ error: 'too-long' });
	});
	it('keeps <script> as text', () => {
		const r = buildAddRequest(books, { selectionText: '<script>alert(1)</script>' }) as any;
		expect(r.request.text).toBe('<script>alert(1)</script>');
	});
});

describe('pickSelection', () => {
	it('uses Chrome text when the page has nothing longer', () => expect(pickSelection('abc', '')).toBe('abc'));
	it('uses the page selection when Chrome cut it short', () => expect(pickSelection('abc', 'abc def')).toBe('abc def'));
	it('ignores a page selection that is a different text', () => expect(pickSelection('abc', 'xyz long text')).toBe('abc'));
	it('returns empty when Chrome saw no selection (link outside the selection)', () => expect(pickSelection('', 'something else')).toBe(''));
	it('survives non-strings', () => {
		expect(pickSelection(undefined, null)).toBe('');
		expect(pickSelection('a', 3)).toBe('a');
	});
});

describe('sanitizeRequest', () => {
	it('rebuilds a text request and a link request', () => {
		expect(sanitizeRequest({ list: 'book', label: 'Books', text: ' hi ', extra: 1 })).toEqual({ list: 'book', label: 'Books', text: 'hi' });
		expect(sanitizeRequest({ list: 'tool', url: 'https://a.com', title: ' t ' })).toEqual({ list: 'tool', label: 'tool', url: 'https://a.com', title: 't' });
	});
	it('refuses junk, non-http links and long text', () => {
		expect(sanitizeRequest(null)).toBeNull();
		expect(sanitizeRequest('x')).toBeNull();
		expect(sanitizeRequest({ list: '', text: 'a' })).toBeNull();
		expect(sanitizeRequest({ list: 'a', url: 'javascript:alert(1)' })).toBeNull();
		expect(sanitizeRequest({ list: 'a', url: 'https://a.com/' + 'x'.repeat(2100) })).toBeNull();
		expect(sanitizeRequest({ list: 'a', text: 'x'.repeat(2001) })).toBeNull();
		expect(sanitizeRequest({ list: 'a', text: '  ' })).toBeNull();
		expect(sanitizeRequest({ list: 'a' })).toBeNull();
	});
});

describe('mapAddResponse', () => {
	it('a new entry can be undone; status failed says so (EC-8)', () => {
		expect(mapAddResponse({ ok: true, status: 200, json: { id: 'i1', created: true, status: 'ready', list_label: 'Books' } }, 'x'))
			.toEqual({ kind: 'added', id: 'i1', label: 'Books', canUndo: true, descriptionFailed: false });
		expect(mapAddResponse({ ok: true, status: 200, json: { id: 'i1', created: true, status: 'failed' } }, 'Books'))
			.toMatchObject({ kind: 'added', descriptionFailed: true, label: 'Books' });
	});
	it('already in a list has no undo (EC-4)', () => {
		expect(mapAddResponse({ ok: true, status: 200, json: { already_exists: 'i1', message: 'm' } }, 'Tools & Repos')).toEqual({ kind: 'already', label: 'Tools & Repos' });
	});
	it('moved from the feed, and an unfiled find filed without undo (EC-4, real server bodies)', () => {
		expect(mapAddResponse({ ok: true, status: 200, json: { id: 'i1', created: false, filed: true, in_review: false, status: 'ready' } }, 'Books'))
			.toEqual({ kind: 'moved', label: 'Books' });
		expect(mapAddResponse({ ok: true, status: 200, json: { id: 'i2', created: false, filed: true, from: 'find' } }, 'Books'))
			.toEqual({ kind: 'added', id: 'i2', label: 'Books', canUndo: false, descriptionFailed: false });
		expect(mapAddResponse({ ok: true, status: 200, json: { already_exists: true, message: 'Already in Books' } }, 'Books'))
			.toEqual({ kind: 'already', label: 'Books' });
	});
	it('created false is not undoable', () => {
		expect(mapAddResponse({ ok: true, status: 200, json: { id: 'i1', created: false } }, 'Books')).toMatchObject({ canUndo: false });
	});
	it('maps errors', () => {
		expect(mapAddResponse({ ok: false, networkError: true }, 'B')).toEqual({ kind: 'error', code: 'offline' });
		expect(mapAddResponse({ ok: false, status: 401 }, 'B')).toEqual({ kind: 'error', code: 'not-connected' });
		expect(mapAddResponse({ ok: false, status: 413 }, 'B')).toEqual({ kind: 'error', code: 'too-long' });
		expect(mapAddResponse({ ok: false, status: 400, json: { error: 'No list called x' } }, 'B')).toEqual({ kind: 'error', code: 'bad-input', message: 'No list called x' });
		expect(mapAddResponse({ ok: false, status: 400 }, 'B')).toEqual({ kind: 'error', code: 'bad-input', message: undefined });
		expect(mapAddResponse({ ok: false, status: 503 }, 'B')).toEqual({ kind: 'error', code: 'failed' });
	});
	it('an empty or odd 200 is a failure, not a success', () => {
		expect(mapAddResponse({ ok: true, status: 200 }, 'B')).toEqual({ kind: 'error', code: 'failed' });
		expect(mapAddResponse({ ok: true, status: 200, json: {} }, 'B')).toEqual({ kind: 'error', code: 'failed' });
		expect(mapAddResponse({ ok: true, status: 200, json: 'str' }, 'B')).toEqual({ kind: 'error', code: 'failed' });
	});
});

describe('addToList', () => {
	it('posts a selection with the token header and only list and text', async () => {
		const f = reply(200, { id: 'i1', created: true, status: 'ready', list_label: 'Books' });
		const req: AddRequest = { list: 'book', label: 'Books', text: 'hello' };
		const out = await addToList(conn(f), req);
		expect(out).toMatchObject({ kind: 'added', id: 'i1' });
		const [url, init] = f.mock.calls[0];
		expect(url).toBe('https://lazyreader.app/api/clipperAddToList');
		expect(init.headers['x-reader-token']).toBe('tok');
		expect(JSON.parse(init.body)).toEqual({ list: 'book', text: 'hello' });
	});
	it('posts a link with url and title only', async () => {
		const f = reply(200, { id: 'i1', created: true });
		await addToList(conn(f), { list: 'tool', label: 'Tools', url: 'https://a.com', title: 'A' });
		expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ list: 'tool', url: 'https://a.com', title: 'A' });
	});
	it('no token is not-connected and sends nothing (EC-2)', async () => {
		const f = reply(200, {});
		expect(await addToList(conn(f, ''), { list: 'a', label: 'A', text: 'x' })).toEqual({ kind: 'error', code: 'not-connected' });
		expect(f).not.toHaveBeenCalled();
	});
	it('a bad capture URL is not-connected', async () => {
		const f = reply(200, {});
		expect(await addToList({ token: 't', captureUrl: 'ftp://x', fetchFn: f }, { list: 'a', label: 'A', text: 'x' })).toEqual({ kind: 'error', code: 'not-connected' });
	});
	it('a 401 is not-connected; a thrown fetch is offline (EC-1)', async () => {
		expect(await addToList(conn(reply(401, { error: 'no' })), { list: 'a', label: 'A', text: 'x' })).toEqual({ kind: 'error', code: 'not-connected' });
		expect(await addToList(conn(vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))), { list: 'a', label: 'A', text: 'x' })).toEqual({ kind: 'error', code: 'offline' });
	});
	it('413 and 5xx', async () => {
		expect(await addToList(conn(reply(413, {})), { list: 'a', label: 'A', text: 'x' })).toEqual({ kind: 'error', code: 'too-long' });
		expect(await addToList(conn(reply(500, {})), { list: 'a', label: 'A', text: 'x' })).toEqual({ kind: 'error', code: 'failed' });
	});
	it('two calls at once give two separate answers (EC-6)', async () => {
		const f = vi.fn()
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'i1', created: true }) })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'i2', created: true }) });
		const [a, b] = await Promise.all([
			addToList(conn(f), { list: 'a', label: 'A', text: 'one' }),
			addToList(conn(f), { list: 'a', label: 'A', text: 'two' }),
		]);
		expect([(a as any).id, (b as any).id]).toEqual(['i1', 'i2']);
	});
	it('a non-JSON body does not throw', async () => {
		const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('bad'); } });
		expect(await addToList(conn(f), { list: 'a', label: 'A', text: 'x' })).toEqual({ kind: 'error', code: 'failed' });
	});
});

describe('undoAdd', () => {
	it('removes on 200 and posts the id', async () => {
		const f = reply(200, { ok: true });
		expect(await undoAdd(conn(f), 'i1')).toEqual({ kind: 'removed' });
		expect(f.mock.calls[0][0]).toBe('https://lazyreader.app/api/clipperUndoAdd');
		expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ id: 'i1' });
	});
	it('404 means already kept (EC-7); 401, offline, 5xx', async () => {
		expect(await undoAdd(conn(reply(404, {})), 'i1')).toEqual({ kind: 'error', code: 'kept' });
		expect(await undoAdd(conn(reply(401, {})), 'i1')).toEqual({ kind: 'error', code: 'not-connected' });
		expect(await undoAdd(conn(vi.fn().mockRejectedValue(new Error('x'))), 'i1')).toEqual({ kind: 'error', code: 'offline' });
		expect(await undoAdd(conn(reply(500, {})), 'i1')).toEqual({ kind: 'error', code: 'failed' });
	});
	it('an empty id sends nothing', async () => {
		const f = reply(200, {});
		expect(await undoAdd(conn(f), '')).toEqual({ kind: 'error', code: 'failed' });
		expect(f).not.toHaveBeenCalled();
	});
});

describe('menu', () => {
	const t = (k: string) => k;
	const lists = [{ slug: 'book', label: 'Books' }, { slug: 'tool', label: 'Tools' }];
	it('not connected: one connect item (EC-2)', () => {
		const items = listMenuItems({ connected: false, stored: null, lastUsed: null }, t);
		expect(items.map(i => i.id)).toEqual(['add-to-list', 'add-to-list-state:connect']);
		expect(items[0].contexts).toEqual(['selection', 'link']);
	});
	it('loading is disabled; failed offers reload (EC-3)', () => {
		const loading = listMenuItems({ connected: true, stored: null, lastUsed: null }, t);
		expect(loading[1]).toMatchObject({ id: 'add-to-list-state:loading', enabled: false });
		expect(listMenuItems({ connected: true, stored: null, lastUsed: null, failed: true }, t)[1].id).toBe('add-to-list-state:reload');
	});
	it('no lists', () => {
		expect(listMenuItems({ connected: true, stored: { lists: [], at: 1 }, lastUsed: null }, t)[1].id).toBe('add-to-list-state:none');
	});
	it('lists: last used first, a rule after it, every child under the parent', () => {
		const items = listMenuItems({ connected: true, stored: { lists, at: 1 }, lastUsed: 'tool' }, t);
		expect(items.map(i => i.id)).toEqual(['add-to-list', 'add-to-list:tool', 'add-to-list-state:separator', 'add-to-list:book']);
		expect(items.slice(1).every(i => i.parentId === 'add-to-list')).toBe(true);
		expect(items[2].type).toBe('separator');
	});
	it('one list has no rule; 40 lists are all shown', () => {
		expect(listMenuItems({ connected: true, stored: { lists: [lists[0]], at: 1 }, lastUsed: null }, t).map(i => i.id)).toEqual(['add-to-list', 'add-to-list:book']);
		const many = Array.from({ length: 40 }, (_, i) => ({ slug: `s${i}`, label: `L${i}` }));
		expect(listMenuItems({ connected: true, stored: { lists: many, at: 1 }, lastUsed: null }, t).filter(i => i.id.startsWith('add-to-list:')).length).toBe(40);
	});
	it('parseMenuId keeps a list called "none" apart from the state', () => {
		expect(parseMenuId('add-to-list:none')).toEqual({ slug: 'none' });
		expect(parseMenuId('add-to-list-state:none')).toEqual({ state: 'none' });
		expect(parseMenuId('add-to-list-state:separator')).toBeNull();
		expect(parseMenuId('add-to-list')).toBeNull();
		expect(parseMenuId('open-obsidian-clipper')).toBeNull();
		expect(parseMenuId(undefined)).toBeNull();
		expect(parseMenuId(5)).toBeNull();
		expect(parseMenuId('add-to-list:')).toBeNull();
	});
});

describe('urls', () => {
	it('builds the Open link from the capture URL', () => {
		expect(listUrl(CAPTURE, 'tools-repos')).toBe('https://lazyreader.app/lists/tools-repos');
		expect(listUrl(CAPTURE)).toBe('https://lazyreader.app/lists');
		expect(listUrl(CAPTURE, 'a/b c')).toBe('https://lazyreader.app/lists/a%2Fb%20c');
	});
	it('falls back to the default origin', () => {
		expect(appOrigin('not a url')).toBe('https://lazyreader.app');
		expect(appOrigin('javascript:alert(1)')).toBe('https://lazyreader.app');
		expect(appOrigin('http://localhost:54321/api/capture')).toBe('http://localhost:54321');
	});
});

describe('cache', () => {
	it('stale when missing, older than an hour or from the future', () => {
		expect(listsAreStale(null, 1000)).toBe(true);
		expect(listsAreStale({ lists: [], at: 1000 }, 1000 + 3600_000 + 1)).toBe(true);
		expect(listsAreStale({ lists: [], at: 1000 }, 1000 + 3600_000)).toBe(false);
		expect(listsAreStale({ lists: [], at: 10_000_000 }, 1000)).toBe(true);
	});
	it('refreshLists stores the lists; a failure leaves the cache alone', async () => {
		const set = vi.spyOn(browser.storage.local, 'set').mockResolvedValue(undefined as any);
		const ok = await refreshLists(conn(reply(200, { types: [{ slug: 'book', label: 'Books', color: 'x' }] })), 5);
		expect(ok).toEqual([{ slug: 'book', label: 'Books' }]);
		expect(set).toHaveBeenCalledWith({ readingLists: { lists: [{ slug: 'book', label: 'Books' }], at: 5 } });
		set.mockClear();
		expect(await refreshLists(conn(reply(500, {})))).toBeNull();
		expect(await refreshLists(conn(reply(200, { nope: 1 })))).toBeNull();
		expect(await refreshLists(conn(vi.fn().mockRejectedValue(new Error('x'))))).toBeNull();
		expect(set).not.toHaveBeenCalled();
		set.mockRestore();
	});
	it('refreshLists returns null when the cache write throws, so the menu cannot loop on it', async () => {
		const set = vi.spyOn(browser.storage.local, 'set').mockRejectedValue(new Error('quota'));
		expect(await refreshLists(conn(reply(200, { types: [{ slug: 'book', label: 'Books' }] })))).toBeNull();
		set.mockRestore();
	});
	it('loadLists reads the cache and survives bad storage', async () => {
		const get = vi.spyOn(browser.storage.local, 'get');
		get.mockResolvedValueOnce({ readingLists: { lists: [{ slug: 'a', label: 'A' }], at: 9 }, readingListLastUsed: 'a' } as any);
		expect(await loadLists()).toEqual({ stored: { lists: [{ slug: 'a', label: 'A' }], at: 9 }, lastUsed: 'a' });
		get.mockResolvedValueOnce({ readingLists: 'junk' } as any);
		expect(await loadLists()).toEqual({ stored: null, lastUsed: null });
		get.mockRejectedValueOnce(new Error('x'));
		expect(await loadLists()).toEqual({ stored: null, lastUsed: null });
		get.mockRestore();
	});
});

describe('timeout and unknown list', () => {
	it('every call carries a 30 s abort signal', async () => {
		expect(POST_TIMEOUT_MS).toBe(30000);
		const f = reply(200, { id: 'x', created: true });
		await addToList(conn(f), { list: 'book', label: 'Books', text: 'hi' });
		expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
	});
	it('a timeout is a failed outcome (Try again), not offline', async () => {
		const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
		const f = vi.fn().mockRejectedValue(timeout);
		expect(await addToList(conn(f), { list: 'book', label: 'Books', text: 'hi' })).toEqual({ kind: 'error', code: 'failed' });
		expect(await undoAdd(conn(f), 'i1')).toEqual({ kind: 'error', code: 'failed' });
		const off = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		expect(await addToList(conn(off), { list: 'book', label: 'Books', text: 'hi' })).toEqual({ kind: 'error', code: 'offline' });
	});
	it('isUnknownListError matches only a 400 saying the list or type is gone', () => {
		const bad = (message?: string) => ({ kind: 'error', code: 'bad-input', message }) as const;
		expect(isUnknownListError(bad('No list called "x"'))).toBe(true);
		expect(isUnknownListError(bad('No type called x'))).toBe(true);
		expect(isUnknownListError(bad('Text is empty'))).toBe(false);
		expect(isUnknownListError(bad(undefined))).toBe(false);
		expect(isUnknownListError({ kind: 'error', code: 'failed' })).toBe(false);
		expect(isUnknownListError({ kind: 'already', label: 'x' })).toBe(false);
		expect(isUnknownListError(mapAddResponse({ ok: false, status: 400, json: { error: 'No list called "<script>"' } }, 'x'))).toBe(true);
	});
});
