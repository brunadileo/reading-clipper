import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	addedAtFromCatalogItemId, extractApolloState, isMemberTier, listUrl, parseLibrary, parseListPage, runMediumSync,
	MEDIUM_RUN_POSTS, type MediumCollected, type MediumDeps,
} from './medium-sync';
import { checkFullText } from './full-text-check';
import { emptyState, htmlToText } from './sync-core';
import { makeDeps, memoryStore, type Route } from './sync-test-helpers';
import {
	LISTS, OWN, READING, USERNAME, VIEWER_ID, catalogItemIdOf, libraryHtml, listHtml, postHtml, postIdOf, words, type ItemSpec, type ListSpec,
} from './fixtures/medium/build';

const fx = (name: string) => readFileSync(resolve(__dirname, 'fixtures/medium', name), 'utf8');

const items = (listNo: number, n: number, from = 0, locked = false): ItemSpec[] =>
	Array.from({ length: n }, (_, k) => {
		const i = from + k;
		return { postId: postIdOf(listNo, i), catalogItemId: catalogItemIdOf(listNo, i), title: `Synthetic story ${listNo}-${i}`, locked };
	});

describe('extractApolloState', () => {
	it('reads the state after the marker up to </script>, trailing ; trimmed', () => {
		const s = extractApolloState(fx('library.html'));
		expect(s?.ROOT_QUERY.viewer).toEqual({ __ref: `User:${VIEWER_ID}` });
	});
	it('is null when the marker is absent, the JSON is cut, or the page is a Cloudflare challenge', () => {
		expect(extractApolloState('<html><body>hello</body></html>')).toBeNull();
		expect(extractApolloState('<script>window.__APOLLO_STATE__ = {"a":</script>')).toBeNull();
		expect(extractApolloState(fx('cloudflare.html'))).toBeNull();
		expect(extractApolloState(`<title>Just a moment...</title><script>window.__APOLLO_STATE__ = {"a":1};</script>`)).toBeNull();
		expect(extractApolloState('')).toBeNull();
	});
});

describe('parseLibrary', () => {
	it('gives viewer, username, tier and only the own lists (Reading list included)', () => {
		const lib = parseLibrary(extractApolloState(fx('library.html')))!;
		expect(lib.viewerId).toBe(VIEWER_ID);
		expect(lib.username).toBe(USERNAME);
		expect(lib.tier).toBe('MEMBER');
		expect(lib.lists).toEqual([
			{ catalogId: READING, postItemsCount: 48, predefined: true },
			{ catalogId: OWN, postItemsCount: 3, predefined: false },
		]);
	});
	it('is null with no viewer (signed out) and tier is null for a non-member', () => {
		expect(parseLibrary(extractApolloState(fx('library-signed-out.html')))).toBeNull();
		expect(parseLibrary(null)).toBeNull();
		expect(parseLibrary(extractApolloState(libraryHtml(LISTS, { tier: null })))!.tier).toBeNull();
	});
	it('listUrl uses reading-list for the predefined list', () => {
		expect(listUrl(USERNAME, { catalogId: READING, postItemsCount: 1, predefined: true })).toBe(`https://medium.com/@${USERNAME}/list/reading-list`);
		expect(listUrl(USERNAME, { catalogId: OWN, postItemsCount: 1, predefined: false })).toBe(`https://medium.com/@${USERNAME}/list/${OWN}`);
	});
});

describe('isMemberTier', () => {
	it('any non-empty tier except a free/none value is a member, in any case', () => {
		for (const t of ['MEMBER', 'member', 'FRIEND_OF_MEDIUM']) expect(isMemberTier(t)).toBe(true);
		for (const t of ['NONE', 'none', 'FREE', '', '  ', null]) expect(isMemberTier(t as any)).toBe(false);
	});
});

describe('parseListPage', () => {
	it('reads 20 items with title, link without query, locked flag, added-at and the total count', () => {
		const p = parseListPage(extractApolloState(fx('list-reading.html')));
		expect(p.count).toBe(48);
		expect(p.items).toHaveLength(20);
		expect(p.items[0].postId).toBe(postIdOf(1, 0));
		expect(p.items[0].url).toBe(`https://medium.com/@someauthor/synthetic-story-1-0-${postIdOf(1, 0)}`);
		expect(p.items[0].url).not.toContain('?');
		expect(p.items[0].locked).toBe(true);
		expect(p.items[1].locked).toBe(false);
		expect(p.items[0].addedAt).toBeGreaterThan(p.items[1].addedAt);
	});
	it('survives an empty or foreign state', () => {
		expect(parseListPage(null)).toEqual({ items: [], count: 0 });
		expect(parseListPage({ ROOT_QUERY: {} })).toEqual({ items: [], count: 0 });
	});
	it('addedAtFromCatalogItemId reads the first 8 hex as seconds', () => {
		expect(addedAtFromCatalogItemId('6ab8bba30000000000000000')).toBe(0x6ab8bba3 * 1000);
		expect(addedAtFromCatalogItemId('6ab8bba3')).toBeNull();
		expect(addedAtFromCatalogItemId('zzzzzzzz0000000000000000')).toBeNull();
	});
});

// --- run -------------------------------------------------------------------

interface World {
	// listNo, catalog id, own?, total count, how many the first page holds
	lists: Array<{ no: number; id: string; predefined?: boolean; count: number; page?: number; own?: boolean }>;
	tier?: string | null;
	locked?: boolean;
	listStatus?: number;
	libraryStatus?: number;
	signedOut?: boolean;
}

function route(w: World): Route {
	const specs: ListSpec[] = w.lists.map((l) => ({ catalogId: l.id, predefined: l.predefined, count: l.count, own: l.own }));
	return (url) => {
		if (url.endsWith('/me/lists')) {
			if (w.libraryStatus) return { status: w.libraryStatus, text: fx('cloudflare.html') };
			return { text: w.signedOut ? fx('library-signed-out.html') : libraryHtml(specs, { tier: w.tier }) };
		}
		for (const l of w.lists) {
			if (url.endsWith(l.predefined ? '/list/reading-list' : `/list/${l.id}`)) {
				if (w.listStatus) return { status: w.listStatus };
				return { text: listHtml(specs.find((s) => s.catalogId === l.id)!, items(l.no, Math.min(l.page ?? 20, l.count), 0, w.locked), l.count) };
			}
		}
	};
}

const enabled = (extra: any = {}) => memoryStore({ 'sync:medium': { ...emptyState(), enabled: true, ...extra } });

function setup(w: World, opts: { store?: any; articles?: (url: string) => string | { status: number }; collect?: MediumDeps['openListAndCollect']; sends?: any[] } = {}) {
	const base = makeDeps({ route: route(w), store: opts.store ?? enabled(), sends: opts.sends });
	const collect = vi.fn(opts.collect ?? (async (): Promise<MediumCollected> => ({ posts: [], total: 0, ended: true })));
	const articleFor = opts.articles ?? (() => postHtml(words(400)));
	const fetched: string[] = [];
	const deps: MediumDeps = {
		...base.deps,
		fetchPage: async (url) => {
			fetched.push(url);
			const a = articleFor(url);
			if (typeof a !== 'string') return { status: a.status, html: '', finalUrl: url };
			return { status: 200, html: a, finalUrl: url };
		},
		extractHtml: async (html) => htmlToText(html.match(/<article>([\s\S]*)<\/article>/)?.[1] ?? ''),
		checkFullText,
		openListAndCollect: collect,
	};
	return { ...base, deps, collect, fetched };
}

const many = (n: number): World['lists'] => [
	{ no: 1, id: READING, predefined: true, count: 20 },
	...Array.from({ length: n - 1 }, (_, k) => ({ no: k + 2, id: `b${k}b2b3b4b5b6`, count: 20 })),
];

describe('runMediumSync', () => {
	it('does nothing while the switch is off', async () => {
		const { deps, fetchFn } = setup({ lists: many(2) }, { store: memoryStore() });
		await runMediumSync(deps, 'manual');
		expect(fetchFn.calls).toEqual([]);
	});

	it('first run merges the lists, sorts newest first and sends 100 with text', async () => {
		const { deps, sent, store, sleeps, fetchFn } = setup({ lists: many(6) });
		const r = await runMediumSync(deps, 'manual');
		expect(r.sent).toBe(MEDIUM_RUN_POSTS);
		expect(r.username).toBe(USERNAME);
		expect(r.tier).toBe('MEMBER');
		// list 1 is the newest list: its 20 items come first, in order; list 6 (the oldest) is cut.
		expect(sent[0].id).toBe(`md:${postIdOf(1, 0)}`);
		expect(sent[19].id).toBe(`md:${postIdOf(1, 19)}`);
		expect(sent.some((s) => s.id.startsWith(`md:${postIdOf(6, 0)}`))).toBe(false);
		expect(sent[0].text).toBeTruthy();
		expect(sent[0].url).not.toContain('?');
		// 2 to 4 s (jitter with random 0 = 2 s) between list pages and posts
		expect(sleeps.length).toBeGreaterThan(100);
		expect(sleeps.every((s) => s === 2000)).toBe(true);
		const st = store.data['sync:medium'];
		expect(st.knownIds).toHaveLength(100);
		expect(st.pending).toEqual([]);
		expect(st.lastSuccess).not.toBeNull();
		// the clipper never sends its own GraphQL and never writes to Medium
		expect(fetchFn.calls.every((u) => !u.includes('/_/graphql'))).toBe(true);
	});

	it('skips lists the user does not own', async () => {
		const w: World = { lists: [...many(2), { no: 9, id: 'f1f2f3f4f5f6', count: 5, own: false }] };
		const { deps, fetchFn } = setup(w);
		await runMediumSync(deps, 'manual');
		expect(fetchFn.calls.some((u) => u.includes('f1f2f3f4f5f6'))).toBe(false);
	});

	it('a later run stops scanning a list after 3 known in a row', async () => {
		const known = [0, 1, 2].map((i) => `md:${postIdOf(1, i)}`);
		const w: World = { lists: [{ no: 1, id: READING, predefined: true, count: 20 }, { no: 2, id: OWN, count: 5 }] };
		const { deps, sent, store } = setup(w, { store: enabled({ knownIds: known, lastSuccess: 5, lists: {} }) });
		const r = await runMediumSync(deps, 'manual');
		// nothing from list 1 (its 3 newest were known, the scan stopped), all 5 of list 2
		expect(r.sent).toBe(5);
		expect(sent.map((x) => x.id)).toEqual([0, 1, 2, 3, 4].map((i) => `md:${postIdOf(2, i)}`));
		// list 1 was not scanned to its end, so it is not exhausted and Load older stays open
		const st = store.data['sync:medium'];
		expect(st.lists[READING].exhausted).toBe(false);
		expect(st.lists[OWN].exhausted).toBe(true);
		expect(st.olderExhausted).toBe(false);
	});

	it('Load older then sends what the stopped scan left, and only then is everything exhausted', async () => {
		const known = [0, 1, 2].map((i) => `md:${postIdOf(1, i)}`);
		const w: World = { lists: [{ no: 1, id: READING, predefined: true, count: 20 }] };
		const a = setup(w, { store: enabled({ knownIds: known, lastSuccess: 5, lists: { [READING]: { seen: 20, exhausted: true } } }) });
		await runMediumSync(a.deps, 'manual');
		expect(a.store.data['sync:medium'].lists[READING].exhausted).toBe(false);
		const b = setup(w, { store: a.store });
		const r = await runMediumSync(b.deps, 'older');
		expect(r.sent).toBe(17);
		expect(b.store.data['sync:medium'].olderExhausted).toBe(true);
	});

	it('dedupes by post id: the same post in two lists is sent once, and a second run sends nothing', async () => {
		const w: World = { lists: [{ no: 1, id: READING, predefined: true, count: 3 }, { no: 1, id: OWN, count: 3 }] };
		const a = setup(w);
		const r1 = await runMediumSync(a.deps, 'manual');
		expect(r1.sent).toBe(3);
		const b = setup(w, { store: a.store });
		expect((await runMediumSync(b.deps, 'manual')).sent).toBe(0);
		expect(b.sent).toEqual([]);
	});

	describe('Load older', () => {
		const w: World = { lists: [{ no: 1, id: READING, predefined: true, count: 45 }] };
		const collected = (): MediumCollected => ({
			posts: Array.from({ length: 25 }, (_, k) => ({ postId: postIdOf(1, 20 + k), title: `Deep ${k}`, url: `https://medium.com/@someauthor/deep-${k}-${postIdOf(1, 20 + k)}?x=1` })),
			total: 45,
			ended: true,
		});

		it('keeps a cursor per list, opens the list page for the rest, and ends exhausted', async () => {
			const first = setup(w);
			await runMediumSync(first.deps, 'manual');
			let st = first.store.data['sync:medium'];
			expect(st.lists[READING]).toMatchObject({ seen: 20, exhausted: false });
			expect(st.olderExhausted).toBe(false);

			const second = setup(w, { store: first.store, collect: async () => collected() });
			const r = await runMediumSync(second.deps, 'older');
			expect(second.collect).toHaveBeenCalledTimes(1);
			const [url, want, knownIds] = second.collect.mock.calls[0];
			expect(url).toBe(`https://medium.com/@${USERNAME}/list/reading-list`);
			expect(want).toBe(100);
			expect(knownIds).toHaveLength(20);
			expect(knownIds[0]).toBe(postIdOf(1, 0));
			expect(r.sent).toBe(25);
			expect(second.sent[0].url).toBe(`https://medium.com/@someauthor/deep-0-${postIdOf(1, 20)}`);
			st = second.store.data['sync:medium'];
			expect(st.lists[READING]).toMatchObject({ seen: 45, exhausted: true });
			expect(st.olderExhausted).toBe(true);

			const third = setup(w, { store: second.store });
			const r3 = await runMediumSync(third.deps, 'older');
			expect(r3.message).toBe('No older saves left.');
			expect(third.fetchFn.calls).toEqual([]);
		});

		it('stays not exhausted when the page still had more than was asked for', async () => {
			const first = setup(w);
			await runMediumSync(first.deps, 'manual');
			const more = setup(w, { store: first.store, collect: async () => ({ ...collected(), total: 30, ended: false }) });
			await runMediumSync(more.deps, 'older');
			const st = more.store.data['sync:medium'];
			expect(st.lists[READING]).toMatchObject({ seen: 30, exhausted: false });
			expect(st.olderExhausted).toBe(false);
		});

		it('a blocked list page reads as signed out and leaves the cursor alone', async () => {
			const first = setup(w);
			await runMediumSync(first.deps, 'manual');
			const blocked = setup(w, { store: first.store, collect: async () => ({ posts: [], total: 0, ended: true, blocked: true }) });
			const r = await runMediumSync(blocked.deps, 'older');
			expect(r.stopped).toBe('signed-out');
			expect(blocked.store.data['sync:medium'].lists[READING]).toMatchObject({ seen: 20, exhausted: false });
		});

		it('a stalled scroll below the list count is not the end and says so', async () => {
			const first = setup(w);
			await runMediumSync(first.deps, 'manual');
			const stall = setup(w, { store: first.store, collect: async () => ({ ...collected(), total: 30, ended: true }) });
			const r = await runMediumSync(stall.deps, 'older');
			expect(r.stopped).toBeNull();
			expect(r.message).toMatch(/stopped loading/);
			const st = stall.store.data['sync:medium'];
			expect(st.lists[READING]).toMatchObject({ seen: 30, exhausted: false });
			expect(st.olderExhausted).toBe(false);
		});

		it('a list page that cannot be read is skipped; the first-page batch is still sent and the cursor stays', async () => {
			const two: World = { lists: [{ no: 1, id: READING, predefined: true, count: 45 }, { no: 2, id: OWN, count: 3 }] };
			const run = setup(two, { collect: async () => { throw new Error('Reading the list page timed out'); } });
			const r = await runMediumSync(run.deps, 'older');
			expect(r.stopped).toBeNull();
			expect(r.sent).toBe(23);
			expect(r.message).toMatch(/Could not read a list page/);
			const st = run.store.data['sync:medium'];
			expect(st.pending).toEqual([]);
			expect(st.lists[READING]).toMatchObject({ seen: 20, exhausted: false });
		});

		it('a post link off Medium is never fetched, only sent as a link', async () => {
			const first = setup(w);
			await runMediumSync(first.deps, 'manual');
			const off = setup(w, {
				store: first.store,
				collect: async () => ({ posts: [{ postId: postIdOf(1, 30), title: 'Elsewhere', url: `https://evil.example/x-${postIdOf(1, 30)}` }], total: 45, ended: true }),
			});
			await runMediumSync(off.deps, 'older');
			expect(off.fetched).toEqual([]);
			expect(off.sent).toHaveLength(1);
			expect(off.sent[0].text).toBeUndefined();
		});

		it('a locked post found by scrolling is link-only with no fetch for a non-member, fetched for a member', async () => {
			const first = setup({ ...w, tier: 'NONE' });
			await runMediumSync(first.deps, 'manual');
			const collect = async () => collected();
			const non = setup({ ...w, tier: 'NONE' }, { store: first.store, collect });
			await runMediumSync(non.deps, 'older');
			expect(non.sent).toHaveLength(25);
			expect(non.fetched).toEqual([]);
			expect(non.sent.every((x) => x.text === undefined)).toBe(true);
			const f2 = setup(w);
			await runMediumSync(f2.deps, 'manual');
			const mem = setup(w, { store: f2.store, collect });
			await runMediumSync(mem.deps, 'older');
			expect(mem.fetched).toHaveLength(25);
		});

		it('two Load older passes with nothing new for a list end it as exhausted', async () => {
			const first = setup(w);
			await runMediumSync(first.deps, 'manual');
			const stall = () => setup(w, { store: first.store, collect: async () => ({ posts: [], total: 30, ended: true }) });
			await runMediumSync(stall().deps, 'older');
			expect(first.store.data['sync:medium'].lists[READING]).toMatchObject({ exhausted: false, stalls: 1 });
			await runMediumSync(stall().deps, 'older');
			const st = first.store.data['sync:medium'];
			expect(st.lists[READING].exhausted).toBe(true);
			expect(st.olderExhausted).toBe(true);
		});

		it('never opens the page for a list the first page already covers', async () => {
			const small = setup({ lists: [{ no: 2, id: OWN, count: 3 }] });
			await runMediumSync(small.deps, 'manual');
			expect(small.store.data['sync:medium'].olderExhausted).toBe(true);
		});
	});

	describe('text step', () => {
		const one: World = { lists: [{ no: 1, id: READING, predefined: true, count: 1 }] };

		it('a member post is read in the browser and sent with its text', async () => {
			const { deps, sent, fetched } = setup(one);
			const r = await runMediumSync(deps, 'manual');
			expect(fetched).toEqual([`https://medium.com/@someauthor/synthetic-story-1-0-${postIdOf(1, 0)}`]);
			expect(sent[0].text).toContain('word0 word1');
			expect(r.linkOnly).toBe(0);
		});
		it('a preview with a wall phrase is sent as a link alone (non-member)', async () => {
			const { deps, sent, store } = setup({ ...one, tier: null }, { articles: () => fx('post-preview.html') });
			const r = await runMediumSync(deps, 'manual');
			expect(sent[0].text).toBeUndefined();
			expect(r.sent).toBe(1);
			expect(r.linkOnly).toBe(1);
			expect(store.data['sync:medium'].knownIds).toEqual([`md:${postIdOf(1, 0)}`]);
		});
		it('a member-only story without membership is sent as a link alone even if the page looks long', async () => {
			const { deps, sent, fetched } = setup({ ...one, tier: 'NONE', locked: true }, { articles: () => postHtml(words(300)) });
			await runMediumSync(deps, 'manual');
			expect(fetched).toEqual([]);
			expect(sent[0].text).toBeUndefined();
			const member = setup({ ...one, tier: 'MEMBER', locked: true }, { articles: () => postHtml(words(300)) });
			await runMediumSync(member.deps, 'manual');
			expect(member.sent[0].text).toBeTruthy();
		});
		it('a short page, a failed fetch and an extractor error all send the link alone', async () => {
			for (const articles of [() => postHtml(words(40)), () => ({ status: 404 })]) {
				const { deps, sent } = setup(one, { articles });
				await runMediumSync(deps, 'manual');
				expect(sent[0].text).toBeUndefined();
			}
			const broken = setup(one);
			broken.deps.extractHtml = async () => { throw new Error('offscreen gone'); };
			await runMediumSync(broken.deps, 'manual');
			expect(broken.sent[0].text).toBeUndefined();
		});
	});

	describe('stop rules', () => {
		it('signed out: no viewer, 403 and a Cloudflare page are a state, not an error', async () => {
			for (const w of [{ lists: [], signedOut: true }, { lists: [], libraryStatus: 403 }] as World[]) {
				const { deps, store, sent } = setup(w);
				const r = await runMediumSync(deps, 'manual');
				expect(r.stopped).toBe('signed-out');
				expect(r.message).toBe('Sign in to Medium in this browser');
				expect(sent).toEqual([]);
				const st = store.data['sync:medium'];
				expect(st.signedOut).toBe(true);
				expect(st.lastError).toBeNull();
				expect(st.running).toBe(false);
			}
			const cf = setup({ lists: [] });
			cf.deps.fetchFn = (async () => ({ ok: true, status: 200, text: async () => fx('cloudflare.html') })) as any;
			expect((await runMediumSync(cf.deps, 'manual')).stopped).toBe('signed-out');
		});

		it('429 from Medium ends the run with a plain line', async () => {
			const { deps, store } = setup({ lists: many(2), libraryStatus: 429 });
			const r = await runMediumSync(deps, 'manual');
			expect(r.stopped).toBe('rate-limited');
			expect(r.message).toBe('Medium asked us to slow down. Try again later.');
			expect(store.data['sync:medium'].lastError).toBe(r.message);
			const art = setup({ lists: many(2) }, { articles: () => ({ status: 429 }) });
			const r2 = await runMediumSync(art.deps, 'manual');
			expect(r2.stopped).toBe('rate-limited');
			expect(art.sent).toEqual([]);
			expect(art.store.data['sync:medium'].pending.length).toBeGreaterThan(0);
		});

		it('403 or a Cloudflare page on an article stops the run as signed out and keeps the queue', async () => {
			for (const articles of [() => ({ status: 403 }), () => `<html><head><title>Just a moment...</title></head></html>`]) {
				const { deps, sent, store } = setup({ lists: many(2) }, { articles });
				const r = await runMediumSync(deps, 'manual');
				expect(r.stopped).toBe('signed-out');
				expect(sent).toEqual([]);
				const st = store.data['sync:medium'];
				expect(st.signedOut).toBe(true);
				expect(st.pending.length).toBeGreaterThan(0);
			}
		});

		it('five failures in a row end the run; the pending queue and counts survive', async () => {
			const fail = { ok: false, status: 400, error: 'bad' };
			const { deps, store, sent, r } = await (async () => {
				const s = setup({ lists: many(2) }, { sends: Array(8).fill(fail) });
				return { ...s, r: await runMediumSync(s.deps, 'manual') };
			})();
			expect(r.stopped).toBe('failures');
			expect(r.failed).toBe(5);
			expect(sent).toHaveLength(5);
			const st = store.data['sync:medium'];
			expect(st.pending).toHaveLength(40);
			expect(Object.keys(st.failed)).toHaveLength(5);
			expect(st.knownIds).toEqual([]);
			expect(deps).toBeTruthy();
		});

		it('a pending item from a stopped run goes out first next time', async () => {
			const fail = { ok: false, status: 400 };
			const a = setup({ lists: many(2) }, { sends: Array(5).fill(fail) });
			await runMediumSync(a.deps, 'manual');
			const b = setup({ lists: many(2) }, { store: a.store });
			const r = await runMediumSync(b.deps, 'manual');
			expect(r.sent).toBe(40);
			expect(a.store.data['sync:medium'].pending).toEqual([]);
		});

		it('401 from Lazy Reader stops with the token message', async () => {
			const { deps } = setup({ lists: many(2) }, { sends: [{ ok: false, status: 401 }] });
			const r = await runMediumSync(deps, 'manual');
			expect(r.stopped).toBe('token');
			expect(r.message).toMatch(/did not accept the token/);
		});
	});
});
