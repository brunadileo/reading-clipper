import { describe, it, expect } from 'vitest';
import { substackSavedAssumed as fixture } from './fixtures/substack-saved.assumed';
import { fetchPostText, parseSavedPage, postApiUrl, runSubstackSync, ALARM_RUN_POSTS } from './substack-sync';
import { htmlToText, looksLikeLoginPage, emptyState } from './sync-core';
import { makeDeps, memoryStore, type Route } from './sync-test-helpers';

const longHtml = (n = 200) => `<p>${'word '.repeat(n)}</p>`;
const enabled = (extra: any = {}) => memoryStore({ 'sync:substack': { ...emptyState(), enabled: true, ...extra } });

// A list of `total` posts served 20 per page with cursors c1, c2, ...
function pagedRoute(total: number, opts: { body?: (url: string) => any; listStatus?: number } = {}): Route {
	return (url) => {
		if (url.startsWith('https://substack.com/api/v1/reader/saved')) {
			if (opts.listStatus) return { status: opts.listStatus };
			const m = url.match(/cursor=c(\d+)/);
			const page = m ? Number(m[1]) : 0;
			const items = [];
			for (let i = page * 20; i < Math.min(total, page * 20 + 20); i++) {
				items.push({ entity_key: `p-${i}`, post: { canonical_url: `https://pub${i}.substack.com/p/post-${i}`, title: `T${i}`, publication: { name: 'P' } } });
			}
			return { json: { items, nextCursor: (page + 1) * 20 < total ? `c${page + 1}` : null } };
		}
		if (url.includes('/api/v1/posts/')) return opts.body ? opts.body(url) : { json: { body_html: longHtml() } };
	};
}

describe('parseSavedPage (assumed shape)', () => {
	it('maps items, drops ones without a URL, keeps the cursor', () => {
		const page = parseSavedPage(fixture);
		expect(page.posts.map((p) => p.id)).toEqual(['p-1001', 'p-1002']);
		expect(page.posts[1].url).toBe('https://news.customdomain.test/p/second-post');
		expect(page.posts[0].siteName).toBe('Example Letter');
		expect(page.nextCursor).toBe('cursor-2');
	});
	it('survives garbage', () => {
		expect(parseSavedPage(null)).toEqual({ posts: [], nextCursor: null });
		expect(parseSavedPage({ items: 'x' }).posts).toEqual([]);
	});
});

describe('post text helpers', () => {
	it('builds the post API URL on the post own origin', () => {
		expect(postApiUrl('https://news.customdomain.test/p/second-post?x=1')).toBe('https://news.customdomain.test/api/v1/posts/second-post');
		expect(postApiUrl('https://example.com/not-a-post')).toBeNull();
	});
	it('turns HTML into paragraphs', () => {
		expect(htmlToText('<h2>Title</h2><p>One &amp; two</p><ul><li>a</li><li>b</li></ul><script>x()</script>')).toBe('## Title\n\nOne & two\n\n- a\n\n\n- b'.replace('\n\n\n', '\n'));
	});
	it('detects a login page', () => {
		expect(looksLikeLoginPage('Sign in to continue reading')).toBe(true);
		expect(looksLikeLoginPage('A normal article about signing things')).toBe(false);
	});
	it('rejects a short or login body', async () => {
		const { deps } = makeDeps({ route: () => ({ json: { body_html: '<p>too short</p>' } }) });
		expect(await fetchPostText(deps, { id: 'a', url: 'https://x.substack.com/p/a', title: '', siteName: '' })).toBeNull();
		const login = makeDeps({ route: () => ({ json: { body_html: `<p>Sign in to continue ${'w '.repeat(300)}</p>` } }) });
		expect(await fetchPostText(login.deps, { id: 'a', url: 'https://x.substack.com/p/a', title: '', siteName: '' })).toBeNull();
	});
});

describe('runSubstackSync', () => {
	it('does nothing while the switch is off', async () => {
		const { deps, fetchFn } = makeDeps({ route: pagedRoute(5) });
		const r = await runSubstackSync(deps, 'manual');
		expect(r.sent).toBe(0);
		expect(fetchFn.calls).toEqual([]);
	});

	it('first run discovers the newest 100 (5 pages), sends 20 on an alarm run, keeps the rest pending', async () => {
		const { deps, store, sent, fetchFn } = makeDeps({ route: pagedRoute(250), store: enabled() });
		const r = await runSubstackSync(deps, 'alarm');
		expect(fetchFn.calls.filter((u) => u.includes('/reader/saved'))).toHaveLength(5);
		expect(r.sent).toBe(ALARM_RUN_POSTS);
		expect(sent).toHaveLength(20);
		const st = store.data['sync:substack'];
		expect(st.pending).toHaveLength(80);
		expect(st.knownIds).toHaveLength(20);
		expect(st.olderCursor).toBe('c5');
		expect(st.lastSuccess).not.toBeNull();
		expect(sent[0].text).toContain('word');
	});

	it('a manual run sends all 100; a later run stops at the first known post and adds nothing', async () => {
		const first = makeDeps({ route: pagedRoute(250), store: enabled() });
		await runSubstackSync(first.deps, 'manual');
		expect(first.sent).toHaveLength(100);
		const again = makeDeps({ route: pagedRoute(250), store: first.store });
		const r = await runSubstackSync(again.deps, 'alarm');
		expect(r.sent).toBe(0);
		expect(again.fetchFn.calls.filter((u) => u.includes('/reader/saved'))).toHaveLength(1);
	});

	it('a new save on top of known ones is the only one sent', async () => {
		const known = Array.from({ length: 20 }, (_, i) => `p-${i + 1}`);
		const { deps, sent } = makeDeps({ route: pagedRoute(40), store: enabled({ knownIds: known, lastSuccess: 5 }) });
		// p-0 is the "new" one; p-1..p-19 known, page 2 never read
		await runSubstackSync(deps, 'alarm');
		expect(sent.map((s) => s.id)).toEqual(['p-0']);
	});

	it('Load older continues from the stored cursor and marks the end', async () => {
		const first = makeDeps({ route: pagedRoute(130), store: enabled() });
		await runSubstackSync(first.deps, 'manual');
		const older = makeDeps({ route: pagedRoute(130), store: first.store });
		const r = await runSubstackSync(older.deps, 'older');
		expect(r.sent).toBe(30);
		expect(older.store.data['sync:substack'].olderExhausted).toBe(true);
		expect(older.fetchFn.calls[0]).toContain('cursor=c5');
	});

	it('stops quietly on 429 and keeps pending for the next run', async () => {
		let n = 0;
		const route = pagedRoute(10, { body: () => (++n === 3 ? { status: 429 } : { json: { body_html: longHtml() } }) });
		const { deps, store } = makeDeps({ route, store: enabled() });
		const r = await runSubstackSync(deps, 'manual');
		expect(r.stopped).toBe('rate-limited');
		expect(r.sent).toBe(2);
		const st = store.data['sync:substack'];
		expect(st.pending).toHaveLength(8);
		expect(st.lastError).toMatch(/slow down/);
		expect(st.running).toBe(false);
	});

	it('401 from the list is the signed-out state, not an error', async () => {
		const { deps, store, sent } = makeDeps({ route: pagedRoute(5, { listStatus: 401 }), store: enabled() });
		const r = await runSubstackSync(deps, 'manual');
		expect(r.stopped).toBe('signed-out');
		expect(sent).toHaveLength(0);
		const st = store.data['sync:substack'];
		expect(st.signedOut).toBe(true);
		expect(st.lastError).toBeNull();
	});

	it('an HTML (login) answer to the list counts as signed out', async () => {
		const { deps, store } = makeDeps({ route: () => ({ text: '<html>login</html>' }), store: enabled() });
		const r = await runSubstackSync(deps, 'manual');
		expect(r.stopped).toBe('signed-out');
		expect(store.data['sync:substack'].signedOut).toBe(true);
	});

	it('short posts retry up to 3 runs, then are given up on; 5 failures in a row stop the run', async () => {
		const route = pagedRoute(8, { body: () => ({ json: { body_html: '<p>short</p>' } }) });
		const { deps, store, sent } = makeDeps({ route, store: enabled() });
		const r = await runSubstackSync(deps, 'manual');
		expect(sent).toHaveLength(0);
		expect(r.stopped).toBe('failures');
		expect(r.failed).toBe(5);
		const st = store.data['sync:substack'];
		expect(st.failed['p-0']).toBe(1);
		expect(st.knownIds).toHaveLength(0);
	});

	it('a token rejection stops the run with a clear message', async () => {
		const { deps, store } = makeDeps({ route: pagedRoute(3), store: enabled(), sends: [{ ok: false, status: 401 }] });
		const r = await runSubstackSync(deps, 'manual');
		expect(r.stopped).toBe('token');
		expect(store.data['sync:substack'].lastError).toMatch(/token/i);
	});

	it('requests credentials from the browser and never reads a cookie', async () => {
		const inits: any[] = [];
		const route: Route = (url, init) => { inits.push(init); return pagedRoute(1)(url, init); };
		const { deps } = makeDeps({ route, store: enabled() });
		await runSubstackSync(deps, 'manual');
		expect(inits.every((i) => i?.credentials === 'include' && !('Cookie' in (i.headers ?? {})))).toBe(true);
	});

	it('paces requests 2 to 4 seconds apart', async () => {
		const { deps, sleeps } = makeDeps({ route: pagedRoute(3), store: enabled() });
		await runSubstackSync(deps, 'manual');
		expect(sleeps.length).toBe(2);
		expect(sleeps.every((s) => s >= 2000 && s <= 4000)).toBe(true);
	});
});
