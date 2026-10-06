import { describe, it, expect } from 'vitest';
import { continuationItem, continuationResponse, initialData, playlistPageHtml, vid, videoRow } from './fixtures/youtube/playlist';
import {
	ALARM_RUN_VIDEOS, MANUAL_RUN_VIDEOS, applyYoutubeConfig, checkPlaylist, hasSource, emptyYoutubeConfig, extractInitialData, extractPlaylistId,
	parseContinuation, parsePlaylistPage, parseRows, parseYtcfg, runYoutubeSync, watchLaterNeverRan, RESTART_MAX_PAGES, type YoutubeDeps,
} from './youtube-sync';
import { emptyState } from './sync-core';
import { makeDeps, memoryStore, type Route } from './sync-test-helpers';

const cfgWith = (extra: any = {}) => ({ ...emptyYoutubeConfig(), watchLater: true, ...extra });
const enabled = (youtube: any = cfgWith(), extra: any = {}) =>
	memoryStore({ 'sync:youtube': { ...emptyState(), enabled: true, youtube, ...extra } });

interface ListSpec { total: number; rowOpts?: (n: number) => any; offset?: number; title?: string }

// Lists served 100 per page like YouTube: page 1 by GET, later pages by POST token "<list>:<page>".
function ytRoute(lists: Record<string, ListSpec>, opts: { loggedIn?: boolean; browseStatus?: number; listStatus?: number; onBrowse?: (init?: RequestInit) => void } = {}): Route {
	const rowsFor = (id: string, page: number) => {
		const spec = lists[id];
		const out = [];
		for (let i = page * 100; i < Math.min(spec.total, page * 100 + 100); i++) out.push(videoRow((spec.offset ?? 0) + i, spec.rowOpts?.(i)));
		return out;
	};
	const tokenFor = (id: string, page: number) => ((page + 1) * 100 < lists[id].total ? `${id}:${page + 1}` : null);
	return (url, init) => {
		if (url.startsWith('https://www.youtube.com/playlist?list=')) {
			if (opts.listStatus) return { status: opts.listStatus };
			const id = new URL(url).searchParams.get('list')!;
			if (!lists[id]) return { text: playlistPageHtml([], { title: '', loggedIn: opts.loggedIn }) };
			return { text: playlistPageHtml(rowsFor(id, 0), { loggedIn: opts.loggedIn, title: lists[id].title ?? id, continuation: tokenFor(id, 0) }) };
		}
		if (url.startsWith('https://www.youtube.com/youtubei/v1/browse')) {
			opts.onBrowse?.(init);
			if (opts.browseStatus) return { status: opts.browseStatus };
			const body = JSON.parse(String(init?.body));
			const [id, p] = String(body.continuation).split(':');
			const page = Number(p);
			return { json: continuationResponse(rowsFor(id, page), tokenFor(id, page)) };
		}
	};
}

const sentIds = (sent: Array<{ id: string }>) => sent.map((s) => s.id);

describe('parsers', () => {
	it('reads ytcfg', () => {
		const html = playlistPageHtml([videoRow(1)]);
		expect(parseYtcfg(html)).toEqual({ loggedIn: true, apiKey: 'AIzaSyntheticKey0000', clientVersion: '2.20261002.10.00' });
		expect(parseYtcfg(playlistPageHtml([], { loggedIn: false })).loggedIn).toBe(false);
		expect(parseYtcfg('<html></html>')).toEqual({ loggedIn: null, apiKey: null, clientVersion: null });
	});

	it('extracts ytInitialData even with braces inside strings', () => {
		const html = `<script>var ytInitialData = {"a":"x}{\\"y","b":[1,{"c":2}]};</script><script>other()</script>`;
		expect(extractInitialData(html)).toEqual({ a: 'x}{"y', b: [1, { c: 2 }] });
		expect(extractInitialData('<html>nothing</html>')).toBeNull();
	});

	it('maps rows, the title, and the continuation token', () => {
		const page = parsePlaylistPage(playlistPageHtml([videoRow(1), videoRow(2, { title: 'Two', channel: 'Chan' })], { continuation: 'tok-1', title: 'My list' }));
		expect(page.signedOut).toBe(false);
		expect(page.title).toBe('My list');
		expect(page.continuation).toBe('tok-1');
		expect(page.rows.map((r) => r.id)).toEqual([vid(1), vid(2)]);
		expect(page.rows[1]).toMatchObject({ title: 'Two', channel: 'Chan', lengthSeconds: 600, playable: true, short: false });
	});

	it('has no continuation when the list fits one page', () => {
		expect(parsePlaylistPage(playlistPageHtml([videoRow(1)])).continuation).toBeNull();
	});

	it('detects Shorts by URL, by reel endpoint, and by length under 60 s; keeps rows with no length', () => {
		const rows = parseRows(initialData([
			videoRow(1, { short: 'url' }),
			videoRow(2, { short: 'reel' }),
			videoRow(3, { length: 45 }),
			videoRow(4, { length: 60 }),
			videoRow(5, { length: null }),
			videoRow(6, { length: 0 }),
		])).rows;
		expect(rows.map((r) => r.short)).toEqual([true, true, true, false, false, false]);
	});

	it('marks unplayable rows', () => {
		const rows = parseRows(initialData([videoRow(1, { playable: false }), videoRow(2)])).rows;
		expect(rows.map((r) => r.playable)).toEqual([false, true]);
	});

	it('takes a lockupViewModel row and ignores duplicates and non-video lockups', () => {
		const data = { items: [
			{ lockupViewModel: { contentId: 'abcdefghijk', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: 'Lockup video' } } } } },
			{ lockupViewModel: { contentId: 'abcdefghijk', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' } },
			{ lockupViewModel: { contentId: 'PLxxxxxxxxx', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' } },
		] };
		const rows = parseRows(data).rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: 'abcdefghijk', title: 'Lockup video' });
	});

	it('reads a continuation response and its next token', () => {
		const p = parseContinuation(continuationResponse([videoRow(7), videoRow(8)], 'next-2'));
		expect(p.rows.map((r) => r.id)).toEqual([vid(7), vid(8)]);
		expect(p.continuation).toBe('next-2');
		expect(parseContinuation(continuationResponse([videoRow(9)], null)).continuation).toBeNull();
		expect(parseContinuation(null)).toEqual({ rows: [], continuation: null });
		expect(continuationItem('t').continuationItemRenderer).toBeDefined();
	});

	it('signed out is LOGGED_IN false; no ytInitialData without it is a blocked check', () => {
		expect(parsePlaylistPage(playlistPageHtml([], { loggedIn: false })).signedOut).toBe(true);
		expect(parsePlaylistPage(playlistPageHtml([], { loggedIn: false, noData: true })).signedOut).toBe(true);
		const blocked = parsePlaylistPage(playlistPageHtml([], { loggedIn: null, noData: true }));
		expect(blocked).toMatchObject({ signedOut: false, blocked: true });
		expect(parsePlaylistPage(playlistPageHtml([videoRow(1)], { loggedIn: null }))).toMatchObject({ signedOut: false, blocked: false });
	});

	it('extracts a playlist id from a link or a bare id', () => {
		expect(extractPlaylistId('https://www.youtube.com/playlist?list=PLabcdefghijklmnop')).toBe('PLabcdefghijklmnop');
		expect(extractPlaylistId('https://www.youtube.com/watch?v=abc&list=PLabcdefghijklmnop&index=3')).toBe('PLabcdefghijklmnop');
		expect(extractPlaylistId('youtube.com/playlist?list=PLabcdefghijklmnop')).toBe('PLabcdefghijklmnop');
		expect(extractPlaylistId(' PLabcdefghijklmnop ')).toBe('PLabcdefghijklmnop');
		expect(extractPlaylistId('WL')).toBeNull();
		expect(extractPlaylistId('https://www.youtube.com/playlist')).toBeNull();
		expect(extractPlaylistId('')).toBeNull();
		expect(extractPlaylistId('hello world')).toBeNull();
	});
});

describe('checkPlaylist', () => {
	it('returns the title', async () => {
		const { deps } = makeDeps({ route: ytRoute({ PLabcdefghijklmnop: { total: 3, title: 'Cooking' } }) });
		const r = await checkPlaylist(deps, 'https://www.youtube.com/playlist?list=PLabcdefghijklmnop');
		expect(r).toMatchObject({ ok: true, id: 'PLabcdefghijklmnop', title: 'Cooking' });
	});
	it('says so for a bad link, an unknown playlist and a signed-out browser', async () => {
		const out = makeDeps({ route: ytRoute({}, { loggedIn: false }) });
		expect((await checkPlaylist(out.deps, 'nope')).ok).toBe(false);
		const r = await checkPlaylist(out.deps, 'PLabcdefghijklmnop');
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/Sign in to YouTube/);
		const none = makeDeps({ route: ytRoute({}) });
		expect((await checkPlaylist(none.deps, 'PLabcdefghijklmnop')).message).toMatch(/did not show a playlist/);
	});
});

describe('runYoutubeSync', () => {
	it('does nothing while the switch is off', async () => {
		const { deps, fetchFn } = makeDeps({ route: ytRoute({ WL: { total: 5 } }) });
		const r = await runYoutubeSync(deps, 'manual');
		expect(r.sent).toBe(0);
		expect(fetchFn.calls).toEqual([]);
	});

	it('stops softly when no source is chosen', async () => {
		const { deps, store } = makeDeps({ route: ytRoute({}), store: enabled(cfgWith({ watchLater: false })) });
		const r = await runYoutubeSync(deps, 'manual');
		expect(r.stopped).toBe('no-source');
		expect(store.data['sync:youtube'].running).toBe(false);
	});

	it('first run reads the first 100 (one page), sends 20 on an alarm run, keeps the rest pending and the cursor', async () => {
		const { deps, store, sent, fetchFn } = makeDeps({ route: ytRoute({ WL: { total: 250 } }), store: enabled() });
		const r = await runYoutubeSync(deps, 'alarm');
		expect(fetchFn.calls.filter((u) => u.includes('/playlist?list=WL'))).toHaveLength(1);
		expect(fetchFn.calls.filter((u) => u.includes('/youtubei/v1/browse'))).toHaveLength(0);
		expect(r.sent).toBe(ALARM_RUN_VIDEOS);
		expect(sentIds(sent)[0]).toBe(`yt:${vid(0)}`);
		expect(sent[0].url).toBe(`https://www.youtube.com/watch?v=${vid(0)}`);
		const st = store.data['sync:youtube'];
		expect(st.pending).toHaveLength(80);
		expect(st.knownIds).toHaveLength(20);
		expect(st.youtube.cursors.wl).toEqual({ older: 'WL:1', exhausted: false, started: true });
		expect(st.lastSuccess).not.toBeNull();
	});

	it('manual sync sends at most 100', async () => {
		const { deps, sent } = makeDeps({ route: ytRoute({ WL: { total: 250 } }), store: enabled() });
		const r = await runYoutubeSync(deps, 'manual');
		expect(r.sent).toBe(MANUAL_RUN_VIDEOS);
		expect(sent).toHaveLength(100);
	});

	it('sends the title and site name empty so the server fills them', async () => {
		const { deps } = makeDeps({ route: ytRoute({ WL: { total: 1 } }), store: enabled() });
		let seen: any;
		deps.send = async (post) => { seen = post; return { ok: true, status: 200 }; };
		await runYoutubeSync(deps, 'manual');
		expect(seen).toMatchObject({ title: '', siteName: '' });
	});

	it('a second run adds nothing for the same list', async () => {
		const { deps, sent } = makeDeps({ route: ytRoute({ WL: { total: 30 } }), store: enabled() });
		await runYoutubeSync(deps, 'manual');
		expect(sent).toHaveLength(30);
		const again = await runYoutubeSync(deps, 'manual');
		expect(again.sent).toBe(0);
		expect(sent).toHaveLength(30);
	});

	it('a scheduled run scans up to 5 pages and picks up only what is new', async () => {
		const first = makeDeps({ route: ytRoute({ WL: { total: 30 } }), store: enabled() });
		await runYoutubeSync(first.deps, 'manual');
		// 30 known, now 660 entries.
		const { deps, sent, fetchFn, store } = makeDeps({ route: ytRoute({ WL: { total: 660 } }), store: first.store });
		const r = await runYoutubeSync(deps, 'alarm');
		expect(fetchFn.calls.filter((u) => u.includes('/youtubei/v1/browse'))).toHaveLength(4); // pages 2 to 5
		expect(r.sent).toBe(20);
		expect(sent).toHaveLength(20);
		const st = store.data['sync:youtube'];
		expect(st.pending.length + st.knownIds.length).toBe(500);
	});

	it('waits 2 to 4 s between page requests', async () => {
		const first = makeDeps({ route: ytRoute({ WL: { total: 30 } }), store: enabled() });
		await runYoutubeSync(first.deps, 'manual');
		const { deps, sleeps } = makeDeps({ route: ytRoute({ WL: { total: 660 } }), store: first.store, random: () => 0.5 });
		await runYoutubeSync(deps, 'alarm');
		expect(sleeps.filter((s) => s === 3000).length).toBeGreaterThanOrEqual(4);
	});

	it('Load older continues from the stored cursor until the list is exhausted', async () => {
		const { deps, store, sent } = makeDeps({ route: ytRoute({ WL: { total: 250 } }), store: enabled() });
		await runYoutubeSync(deps, 'manual'); // first 100 sent
		expect(sent).toHaveLength(100);
		const o1 = await runYoutubeSync(deps, 'older');
		expect(o1.sent).toBe(100);
		expect(store.data['sync:youtube'].youtube.cursors.wl.older).toBe('WL:2');
		const o2 = await runYoutubeSync(deps, 'older');
		expect(o2.sent).toBe(50);
		expect(store.data['sync:youtube'].youtube.cursors.wl).toMatchObject({ older: null, exhausted: true });
		const o3 = await runYoutubeSync(deps, 'older');
		expect(o3.sent).toBe(0);
		expect(new Set(sentIds(sent)).size).toBe(250);
	});

	it('Load older with a refused stored token walks again from page 1, skipping known ids', async () => {
		const inner = ytRoute({ WL: { total: 250 } });
		const { deps, store, sent } = makeDeps({ route: ytRoute({ WL: { total: 250 } }), store: enabled() });
		await runYoutubeSync(deps, 'manual'); // first 100 sent, cursor WL:1
		expect(sent).toHaveLength(100);
		const stale = store.data['sync:youtube'].youtube.cursors.wl;
		stale.older = 'stale-token';
		const refuseStale: Route = (url, init) => {
			if (url.startsWith('https://www.youtube.com/youtubei/v1/browse') && String(init?.body).includes('stale-token')) return { status: 400 };
			return inner(url, init);
		};
		const again = makeDeps({ route: refuseStale, store });
		const r = await runYoutubeSync(again.deps, 'older');
		expect(r.stopped).toBeNull();
		expect(again.sent).toHaveLength(100); // page 1 is known and skipped; page 2 is new
		expect(again.sent.some((s) => sent.some((o) => o.id === s.id))).toBe(false);
		expect(store.data['sync:youtube'].youtube.cursors.wl.older).toBe('WL:2');
		const r2 = await runYoutubeSync(again.deps, 'older');
		expect(r2.sent).toBe(50);
		expect(store.data['sync:youtube'].youtube.cursors.wl.exhausted).toBe(true);
	});

	it('a 5xx on the stored Load older token ends the tap with a note and does not restart', async () => {
		const inner = ytRoute({ WL: { total: 250 } });
		const { deps, store, sent } = makeDeps({ route: ytRoute({ WL: { total: 250 } }), store: enabled() });
		await runYoutubeSync(deps, 'manual');
		store.data['sync:youtube'].youtube.cursors.wl.older = 'stale-token';
		const fiveXx: Route = (url, init) => (url.startsWith('https://www.youtube.com/youtubei/v1/browse') && String(init?.body).includes('stale-token') ? { status: 503 } : inner(url, init));
		const again = makeDeps({ route: fiveXx, store });
		const r = await runYoutubeSync(again.deps, 'older');
		expect(again.sent).toHaveLength(0);
		expect(r.note).toMatch(/problem on the next page/);
		expect(store.data['sync:youtube'].youtube.cursors.wl.older).toBe('stale-token');
	});

	it('a restarted Load older walk stops at 30 pages, keeps the cursor and says to tap again', async () => {
		const total = 100 * 40;
		const { deps, store } = makeDeps({ route: ytRoute({ WL: { total } }), store: enabled() });
		await runYoutubeSync(deps, 'manual');
		// Everything on the first 33 pages is already known, so the walk has nothing new to add.
		const st = store.data['sync:youtube'];
		for (let i = 0; i < 33 * 100; i++) st.knownIds.push(`yt:${vid(i)}`);
		st.youtube.cursors.wl.older = 'stale-token';
		const inner = ytRoute({ WL: { total } });
		let browseCalls = 0;
		const route: Route = (url, init) => {
			if (url.startsWith('https://www.youtube.com/youtubei/v1/browse')) {
				browseCalls++;
				if (String(init?.body).includes('stale-token')) return { status: 400 };
			}
			return inner(url, init);
		};
		const again = makeDeps({ route, store });
		const r = await runYoutubeSync(again.deps, 'older');
		expect(browseCalls).toBe(1 + RESTART_MAX_PAGES);
		expect(r.note).toMatch(/tap it again to continue/);
		expect(store.data['sync:youtube'].youtube.cursors.wl).toMatchObject({ older: `WL:${RESTART_MAX_PAGES + 1}`, exhausted: false });
		expect(store.data['sync:youtube'].youtube.note).toMatch(/tap it again/);
	});

	it('watchLaterNeverRan follows the Watch later cursor', () => {
		expect(watchLaterNeverRan({ ...emptyState() })).toBe(true);
		expect(watchLaterNeverRan({ ...emptyState(), youtube: cfgWith() })).toBe(true);
		const started = cfgWith();
		started.cursors.wl.started = true;
		expect(watchLaterNeverRan({ ...emptyState(), youtube: started })).toBe(false);
	});

	it('a video in both Watch later and the playlist is one item', async () => {
		const lists = { WL: { total: 10 }, PLabcdefghijklmnop: { total: 10, offset: 5, title: 'Mix' } };
		const { deps, sent, store } = makeDeps({ route: ytRoute(lists), store: enabled(cfgWith({ playlistId: 'PLabcdefghijklmnop' })) });
		const r = await runYoutubeSync(deps, 'manual');
		expect(r.sent).toBe(15);
		expect(new Set(sentIds(sent)).size).toBe(15);
		expect(store.data['sync:youtube'].youtube.playlistTitle).toBe('Mix');
	});

	it('a playlist added later gets its own first read', async () => {
		const { deps, store, sent } = makeDeps({ route: ytRoute({ WL: { total: 5 }, PLabcdefghijklmnop: { total: 7, offset: 100 } }), store: enabled() });
		await runYoutubeSync(deps, 'manual');
		expect(sent).toHaveLength(5);
		const st = store.data['sync:youtube'];
		st.youtube.playlistId = 'PLabcdefghijklmnop';
		await store.set('sync:youtube', st);
		await runYoutubeSync(deps, 'manual');
		expect(sent).toHaveLength(12);
	});

	const shortsList: ListSpec = { total: 6, rowOpts: (i) => (i === 1 ? { short: 'url' } : i === 3 ? { length: 30 } : i === 4 ? { playable: false } : {}) };

	it('skips Shorts and unavailable videos, counts them, and does not remember a Short', async () => {
		const { deps, store, sent } = makeDeps({ route: ytRoute({ WL: shortsList }), store: enabled() });
		const r = await runYoutubeSync(deps, 'manual');
		expect(r.shortsSkipped).toBe(2);
		expect(r.unavailable).toBe(1);
		expect(sent).toHaveLength(3);
		const st = store.data['sync:youtube'];
		expect(st.knownIds).not.toContain(`yt:${vid(1)}`);
		expect(st.knownIds).toContain(`yt:${vid(4)}`); // unavailable: never retried
		expect(st.lastResult).toMatch(/2 Shorts skipped/);
	});

	it('Include Shorts sends them, and turning it on later picks up the skipped ones', async () => {
		const off = makeDeps({ route: ytRoute({ WL: shortsList }), store: enabled() });
		await runYoutubeSync(off.deps, 'manual');
		const st = off.store.data['sync:youtube'];
		st.youtube.includeShorts = true;
		await off.store.set('sync:youtube', st);
		const r = await runYoutubeSync(off.deps, 'manual');
		expect(r.sent).toBe(2);
		expect(r.shortsSkipped).toBe(0);
	});

	it('signed out is a state: nothing sent, soft flag, no error text', async () => {
		const { deps, store, sent } = makeDeps({ route: ytRoute({ WL: { total: 5 } }, { loggedIn: false }), store: enabled() });
		const r = await runYoutubeSync(deps, 'manual');
		expect(r.stopped).toBe('signed-out');
		expect(sent).toHaveLength(0);
		const st = store.data['sync:youtube'];
		expect(st.signedOut).toBe(true);
		expect(st.lastError).toBeNull();
	});

	it('a 200 with no page data and no LOGGED_IN is a blocked check, not signed out', async () => {
		const route: Route = (url) => (url.startsWith('https://www.youtube.com/playlist?list=') ? { text: playlistPageHtml([], { loggedIn: null, noData: true }) } : undefined);
		const { deps, store, sent } = makeDeps({ route, store: enabled() });
		const r = await runYoutubeSync(deps, 'manual');
		expect(r.stopped).toBe('error');
		expect(sent).toHaveLength(0);
		const st = store.data['sync:youtube'];
		expect(st.signedOut).toBe(false);
		expect(st.lastError).toMatch(/blocked this check, try later/);
	});

	it('a 429 on the list ends the run quietly and sends nothing', async () => {
		const { deps, store, sent } = makeDeps({ route: ytRoute({ WL: { total: 5 } }, { listStatus: 429 }), store: enabled() });
		const r = await runYoutubeSync(deps, 'manual');
		expect(r.stopped).toBe('rate-limited');
		expect(sent).toHaveLength(0);
		expect(store.data['sync:youtube'].lastError).toMatch(/slow down/);
		expect(store.data['sync:youtube'].running).toBe(false);
	});

	it('a 429 on a later page keeps what was read and stops', async () => {
		const first = makeDeps({ route: ytRoute({ WL: { total: 30 } }), store: enabled() });
		await runYoutubeSync(first.deps, 'manual');
		const { deps, store, sent } = makeDeps({ route: ytRoute({ WL: { total: 330 } }, { browseStatus: 429 }), store: first.store });
		const r = await runYoutubeSync(deps, 'alarm');
		expect(r.stopped).toBe('rate-limited');
		expect(sent).toHaveLength(0);
		expect(store.data['sync:youtube'].pending).toHaveLength(70);
	});

	it('a refused continuation keeps the first page, says so, and sends it', async () => {
		const st = enabled();
		// A scheduled rescan reads past page 1 (a first run stops at 100 rows).
		st.data['sync:youtube'].youtube.cursors.wl.started = true;
		const { deps, store, sent } = makeDeps({ route: ytRoute({ WL: { total: 250 } }, { browseStatus: 400 }), store: st });
		const r = await runYoutubeSync(deps, 'manual');
		expect(r.stopped).toBeNull();
		expect(sent).toHaveLength(100);
		expect(r.note).toMatch(/refused the next page, so only the first 100 videos of Watch later were read/);
		expect(store.data['sync:youtube'].lastResult).toMatch(/only the first 100/);
		expect(store.data['sync:youtube'].youtube.note).toMatch(/refused/);
	});

	it('passes the auth header to the paging call only', async () => {
		const auths: Array<string | undefined> = [];
		const st = enabled();
		st.data['sync:youtube'].youtube.cursors.wl.started = true;
		const { deps } = makeDeps({ route: ytRoute({ WL: { total: 250 } }, { onBrowse: (init) => auths.push((init?.headers as any)?.Authorization) }), store: st });
		(deps as YoutubeDeps).authHeader = async () => 'SAPISIDHASH 1_abc';
		await runYoutubeSync(deps, 'manual');
		expect(auths.length).toBeGreaterThan(0);
		expect(auths.every((a) => a === 'SAPISIDHASH 1_abc')).toBe(true);
	});

	it('never sends a cookie or hash to LazyReader', async () => {
		const { deps, sent } = makeDeps({ route: ytRoute({ WL: { total: 3 } }), store: enabled() });
		(deps as YoutubeDeps).authHeader = async () => 'SAPISIDHASH 1_secret';
		await runYoutubeSync(deps, 'manual');
		expect(JSON.stringify(sent)).not.toMatch(/SAPISID|secret/);
	});

	it('sends the transcript with the link, and the link alone when none was read', async () => {
		const { deps, sent } = makeDeps({ route: ytRoute({ WL: { total: 3 } }), store: enabled() });
		(deps as YoutubeDeps).readTranscript = async (id) => ({ text: id === vid(1) ? null : `## Transcript\n\nwords of ${id}`, blocked: false });
		const r = await runYoutubeSync(deps, 'manual');
		expect(r.sent).toBe(3);
		expect(r.withTranscript).toBe(2);
		expect(sent.map((s) => s.text)).toEqual([`## Transcript\n\nwords of ${vid(0)}`, undefined, `## Transcript\n\nwords of ${vid(2)}`]);
	});

	it('a blocked transcript read ends transcript attempts for the rest of the run, links still go', async () => {
		const asked: string[] = [];
		const { deps, sent, store } = makeDeps({ route: ytRoute({ WL: { total: 5 } }), store: enabled() });
		(deps as YoutubeDeps).readTranscript = async (id) => { asked.push(id); return { text: null, blocked: asked.length === 2 }; };
		const r = await runYoutubeSync(deps, 'manual');
		expect(asked).toHaveLength(2);
		expect(sent).toHaveLength(5);
		expect(r.transcriptsBlocked).toBe(true);
		expect(store.data['sync:youtube'].youtube.transcriptsBlockedAt).not.toBeNull();
		expect(store.data['sync:youtube'].lastResult).toMatch(/slowed transcripts down/);
	});

	it('a throwing transcript read never blocks the save', async () => {
		const { deps, sent } = makeDeps({ route: ytRoute({ WL: { total: 2 } }), store: enabled() });
		(deps as YoutubeDeps).readTranscript = async () => { throw new Error('boom'); };
		const r = await runYoutubeSync(deps, 'manual');
		expect(r.sent).toBe(2);
		expect(sent.every((s) => s.text === undefined)).toBe(true);
	});

	it('401 from LazyReader stops the run on the token; 5 failures in a row stop it too', async () => {
		const a = makeDeps({ route: ytRoute({ WL: { total: 5 } }), store: enabled(), sends: [{ ok: false, status: 401 }] });
		expect((await runYoutubeSync(a.deps, 'manual')).stopped).toBe('token');
		const b = makeDeps({ route: ytRoute({ WL: { total: 9 } }), store: enabled(), sends: Array(9).fill({ ok: false, status: 400 }) });
		const r = await runYoutubeSync(b.deps, 'manual');
		expect(r.stopped).toBe('failures');
		expect(r.failed).toBe(5);
	});

	it('gives a video up after 3 failed saves', async () => {
		const store = enabled(cfgWith(), { failed: { [`yt:${vid(0)}`]: 3 } });
		const { deps, sent } = makeDeps({ route: ytRoute({ WL: { total: 2 } }), store });
		await runYoutubeSync(deps, 'manual');
		expect(sentIds(sent)).toEqual([`yt:${vid(1)}`]);
	});
});

describe('applyYoutubeConfig', () => {
	it('sets the switches and a checked playlist', () => {
		const st = emptyState();
		applyYoutubeConfig(st, { watchLater: true, includeShorts: true, playlist: { id: 'PLabcdefghijklmnop', title: 'Mix' } });
		expect(st.youtube).toMatchObject({ watchLater: true, includeShorts: true, playlistId: 'PLabcdefghijklmnop', playlistTitle: 'Mix' });
		expect(hasSource(st)).toBe(true);
	});
	it('a different playlist resets its cursor, the same one keeps it, Watch later is untouched', () => {
		const st = emptyState();
		applyYoutubeConfig(st, { playlist: { id: 'PLaaaaaaaaaaaa', title: 'A' } });
		st.youtube!.cursors.pl = { older: 'tok', exhausted: false, started: true };
		st.youtube!.cursors.wl = { older: 'wl', exhausted: false, started: true };
		applyYoutubeConfig(st, { playlist: { id: 'PLaaaaaaaaaaaa', title: 'A2' } });
		expect(st.youtube!.cursors.pl.older).toBe('tok');
		applyYoutubeConfig(st, { playlist: { id: 'PLbbbbbbbbbbbb', title: 'B' } });
		expect(st.youtube!.cursors.pl).toEqual({ older: null, exhausted: false, started: false });
		expect(st.youtube!.cursors.wl.older).toBe('wl');
		applyYoutubeConfig(st, { playlist: null });
		expect(st.youtube).toMatchObject({ playlistId: null, playlistTitle: '' });
	});
	it('hasSource is false with nothing chosen', () => {
		expect(hasSource(emptyState())).toBe(false);
		const st = emptyState();
		applyYoutubeConfig(st, { watchLater: false });
		expect(hasSource(st)).toBe(false);
	});
});
