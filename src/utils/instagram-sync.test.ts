import { describe, it, expect, vi } from 'vitest';
import { instagramSavedAssumed as fixture } from './fixtures/instagram-saved.assumed';
import { creditWarning, parseAccountPage, parseSavedPosts, runInstagramSync, IG_NEW_LIST_POSTS, IG_PAGE_DELAY_MS } from './instagram-sync';
import { emptyState } from './sync-core';
import { makeDeps, memoryStore, type Route } from './sync-test-helpers';

const ACCOUNT_HTML = '<html>..."csrf_token":"tok123"..."username":"bruna_test"...</html>';
const enabled = (extra: any = {}) => memoryStore({ 'sync:instagram': { ...emptyState(), enabled: true, ...extra } });

// `total` saved posts, 10 per page, ids s0..s<total-1>, newest first.
function igRoute(total: number, opts: { account?: any; listStatus?: number } = {}): Route {
	return (url) => {
		if (url.includes('/accounts/edit/')) return opts.account ?? { text: ACCOUNT_HTML };
		if (url.includes('/feed/saved/posts/')) {
			if (opts.listStatus) return { status: opts.listStatus };
			const m = url.match(/max_id=m(\d+)/);
			const page = m ? Number(m[1]) : 0;
			const items = [];
			for (let i = page * 10; i < Math.min(total, page * 10 + 10); i++) items.push({ media: { code: `s${i}`, user: { username: 'u' }, caption: { text: `cap ${i}` } } });
			const more = (page + 1) * 10 < total;
			return { json: { items, next_max_id: more ? `m${page + 1}` : null, more_available: more } };
		}
	};
}

describe('Instagram parsers (assumed shapes)', () => {
	it('maps shortcodes to /p/ links and drops bad codes', () => {
		const page = parseSavedPosts(fixture);
		expect(page.posts.map((p) => p.url)).toEqual(['https://www.instagram.com/p/CxAbc123/', 'https://www.instagram.com/p/CyDef456/']);
		expect(page.posts[0].title).toBe('First caption');
		expect(page.posts[1].title).toBe('Instagram post by @other');
		expect(page.nextMaxId).toBe('max-2');
	});
	it('reads username and csrf from the account page', () => {
		expect(parseAccountPage(ACCOUNT_HTML)).toEqual({ username: 'bruna_test', csrf: 'tok123' });
		expect(parseAccountPage('<html>login</html>')).toEqual({ username: null, csrf: null });
	});
	it('warns about credits only past 20 posts', () => {
		expect(creditWarning(20)).toBeNull();
		expect(creditWarning(100)).toMatch(/about 100 SociaVault credits/);
	});
});

describe('runInstagramSync', () => {
	it('does nothing while the switch is off', async () => {
		const { deps, fetchFn } = makeDeps({ route: igRoute(5) });
		await runInstagramSync(deps, 'sync');
		expect(fetchFn.calls).toEqual([]);
	});

	it('first sync takes the newest 100, 3 s between pages, shows the username, sends links without text', async () => {
		const { deps, store, sent, sleeps } = makeDeps({ route: igRoute(250), store: enabled() });
		const r = await runInstagramSync(deps, 'sync');
		expect(r.username).toBe('bruna_test');
		expect(r.sent).toBe(100);
		expect(sent[0]).toEqual({ id: 's0', url: 'https://www.instagram.com/p/s0/', text: undefined });
		expect(sleeps.filter((s) => s === IG_PAGE_DELAY_MS)).toHaveLength(9);
		const st = store.data['sync:instagram'];
		expect(st.olderCursor).toBe('m10');
		expect(st.knownIds).toHaveLength(100);
	});

	it('Load older continues from the cursor (one-hour gap respected by moving the clock)', async () => {
		const first = makeDeps({ route: igRoute(130), store: enabled() });
		await runInstagramSync(first.deps, 'sync');
		const st = first.store.data['sync:instagram'];
		st.lastAttemptAt = 0;
		await first.store.set('sync:instagram', st);
		const older = makeDeps({ route: igRoute(130), store: first.store });
		(older.deps as any).now = () => 10 * 60 * 60 * 1000;
		const r = await runInstagramSync(older.deps, 'older');
		expect(r.sent).toBe(30);
		expect(older.store.data['sync:instagram'].olderExhausted).toBe(true);
	});

	it('a later sync stops after 3 known links in a row', async () => {
		const known = ['s3', 's4', 's5', 's6'];
		const { deps, sent, fetchFn } = makeDeps({ route: igRoute(250), store: enabled({ knownIds: known, lastSuccess: 5, lastAttemptAt: 0 }) });
		(deps as any).now = () => 10 * 60 * 60 * 1000;
		await runInstagramSync(deps, 'sync');
		expect(sent.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
		expect(fetchFn.calls.filter((u) => u.includes('/feed/saved/'))).toHaveLength(1);
	});

	const TOO_SOON = (lastAt: number) => {
		const at = new Date(lastAt + 60 * 60 * 1000);
		return `Instagram sync runs at most once an hour. Try again after ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}.`;
	};

	it('a scheduled run 30 min after a manual attempt stops with the too-soon message', async () => {
		const { deps, fetchFn } = makeDeps({ route: igRoute(5), store: enabled({ lastAttemptAt: 1_000_000 }) });
		(deps as any).now = () => 1_000_000 + 30 * 60 * 1000;
		const r = await runInstagramSync(deps, 'scheduled');
		expect(r.stopped).toBe('too-soon');
		expect(fetchFn.calls).toEqual([]);
		expect(r.message).toBe(TOO_SOON(1_000_000));
		expect(r.message).toMatch(/after \d\d:\d\d\.$/);
	});

	it('a non-admin press within the hour is still refused with the exact message (no isAdmin wired)', async () => {
		for (const kind of ['sync', 'older'] as const) {
			const { deps, fetchFn } = makeDeps({ route: igRoute(5), store: enabled({ lastAttemptAt: 1_000_000 }) });
			(deps as any).now = () => 1_000_000 + 30 * 60 * 1000;
			const r = await runInstagramSync(deps, kind);
			expect(r.stopped).toBe('too-soon');
			expect(r.message).toBe(TOO_SOON(1_000_000));
			expect(fetchFn.calls).toEqual([]);
		}
	});

	it('a press by a user whose admin check says no is refused', async () => {
		const { deps, fetchFn } = makeDeps({ route: igRoute(5), store: enabled({ lastAttemptAt: 1_000_000 }) });
		(deps as any).now = () => 1_000_000 + 30 * 60 * 1000;
		deps.isAdmin = async () => false;
		expect((await runInstagramSync(deps, 'sync')).stopped).toBe('too-soon');
		expect(fetchFn.calls).toEqual([]);
	});

	it('fails closed when the admin check throws, and logs it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { deps, fetchFn } = makeDeps({ route: igRoute(5), store: enabled({ lastAttemptAt: 1_000_000 }) });
		(deps as any).now = () => 1_000_000 + 30 * 60 * 1000;
		deps.isAdmin = async () => { throw new Error('profile down'); };
		const r = await runInstagramSync(deps, 'sync');
		expect(r.stopped).toBe('too-soon');
		expect(fetchFn.calls).toEqual([]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('an admin sync 30 min after the last attempt runs and moves the attempt clock', async () => {
		const { deps, fetchFn, store } = makeDeps({ route: igRoute(5), store: enabled({ lastAttemptAt: 1_000_000 }) });
		const at = 1_000_000 + 30 * 60 * 1000;
		(deps as any).now = () => at;
		deps.isAdmin = async () => true;
		const r = await runInstagramSync(deps, 'sync');
		expect(r.stopped).toBeNull();
		expect(fetchFn.calls.length).toBeGreaterThan(0);
		expect(store.data['sync:instagram'].lastAttemptAt).toBe(at);
		expect(store.data['sync:instagram'].lastAttemptScheduled).toBe(false);
	});

	it('an admin Load older 30 min after the last attempt runs', async () => {
		const { deps, fetchFn } = makeDeps({ route: igRoute(30), store: enabled({ lastAttemptAt: 1_000_000, olderCursor: 'm1' }) });
		(deps as any).now = () => 1_000_000 + 30 * 60 * 1000;
		deps.isAdmin = async () => true;
		const r = await runInstagramSync(deps, 'older');
		expect(r.stopped).toBeNull();
		expect(fetchFn.calls.some((u) => u.includes('/feed/saved/'))).toBe(true);
	});

	it('an admin check is not asked for a scheduled run, which never bypasses', async () => {
		const { deps } = makeDeps({ route: igRoute(5), store: enabled({ lastAttemptAt: 1_000_000, lastAttemptScheduled: false }) });
		(deps as any).now = () => 1_000_000 + 30 * 60 * 1000;
		let asked = 0;
		deps.isAdmin = async () => { asked++; return true; };
		expect((await runInstagramSync(deps, 'scheduled')).stopped).toBe('too-soon');
		expect(asked).toBe(0);
	});

	it('a press ignores a stored running flag from a dead run, for a non-admin too; a scheduled run does not', async () => {
		const state = { running: true, lastAttemptAt: 1_000_000 - 5 * 60 * 1000 };
		const press = makeDeps({ route: igRoute(5), store: enabled(state) });
		(press.deps as any).now = () => 1_000_000;
		// Non-admin and the attempt is 5 min old: the hour gate still applies, but the running flag does not return the silent empty result.
		const r = await runInstagramSync(press.deps, 'sync');
		expect(r.stopped).toBe('too-soon');
		expect(r.message).not.toBeNull();

		const adminPress = makeDeps({ route: igRoute(5), store: enabled(state) });
		(adminPress.deps as any).now = () => 1_000_000;
		adminPress.deps.isAdmin = async () => true;
		const a = await runInstagramSync(adminPress.deps, 'sync');
		expect(a.stopped).toBeNull();
		expect(adminPress.fetchFn.calls.length).toBeGreaterThan(0);

		const sched = makeDeps({ route: igRoute(5), store: enabled(state) });
		(sched.deps as any).now = () => 1_000_000;
		expect(await runInstagramSync(sched.deps, 'scheduled')).toEqual({ sent: 0, username: null, stopped: null, message: null });
		expect(sched.fetchFn.calls).toEqual([]);
	});

	it('a scheduled run after a scheduled run leaves the hourly floor to the shared schedule', async () => {
		const { deps, fetchFn, store } = makeDeps({ route: igRoute(5), store: enabled({ lastAttemptAt: 1_000_000, lastAttemptScheduled: true }) });
		(deps as any).now = () => 1_000_000 + 55 * 60 * 1000;
		const r = await runInstagramSync(deps, 'scheduled');
		expect(r.stopped).toBeNull();
		expect(fetchFn.calls.length).toBeGreaterThan(0);
		expect(store.data['sync:instagram'].lastAttemptScheduled).toBe(true);
	});

	it('a scheduled run soon after Load older or Sync now still waits the hour', async () => {
		const { deps, fetchFn } = makeDeps({ route: igRoute(5), store: enabled({ lastAttemptAt: 1_000_000, lastAttemptScheduled: false }) });
		(deps as any).now = () => 1_000_000 + 30 * 60 * 1000;
		const r = await runInstagramSync(deps, 'scheduled');
		expect(r.stopped).toBe('too-soon');
		expect(fetchFn.calls).toEqual([]);
	});

	it('stops on 429 with a plain message and no retry', async () => {
		const { deps, fetchFn, store } = makeDeps({ route: igRoute(50, { listStatus: 429 }), store: enabled() });
		const r = await runInstagramSync(deps, 'sync');
		expect(r.stopped).toBe('rate-limited');
		expect(r.message).toBe('Instagram asked us to slow down. Try again later.');
		expect(fetchFn.calls.filter((u) => u.includes('/feed/saved/'))).toHaveLength(1);
		expect(store.data['sync:instagram'].lastError).toBe(r.message);
	});

	it('signed out: no list call, and the one-hour clock is not spent', async () => {
		const { deps, fetchFn, store } = makeDeps({ route: igRoute(5, { account: { text: '<html>login</html>' } }), store: enabled() });
		const r = await runInstagramSync(deps, 'sync');
		expect(r.stopped).toBe('signed-out');
		expect(fetchFn.calls.some((u) => u.includes('/feed/saved/'))).toBe(false);
		expect(store.data['sync:instagram'].lastAttemptAt).toBeNull();
	});

	it('sends the Instagram headers and credentials', async () => {
		const inits: Array<{ url: string; init: any }> = [];
		const route: Route = (url, init) => { inits.push({ url, init }); return igRoute(3)(url, init); };
		const { deps } = makeDeps({ route, store: enabled() });
		await runInstagramSync(deps, 'sync');
		const list = inits.find((i) => i.url.includes('/feed/saved/'))!;
		expect(list.init.credentials).toBe('include');
		expect(list.init.headers['X-IG-App-ID']).toBe('936619743392459');
		expect(list.init.headers['X-CSRFToken']).toBe('tok123');
	});

	it('a rejected token stops the run', async () => {
		const { deps } = makeDeps({ route: igRoute(3), store: enabled(), sends: [{ ok: false, status: 401 }] });
		const r = await runInstagramSync(deps, 'sync');
		expect(r.stopped).toBe('token');
	});

	it('a 520 from Lazy Reader is retried and the post goes through', async () => {
		const { deps, sent, sleeps } = makeDeps({ route: igRoute(1), store: enabled(), sends: [{ ok: false, status: 520 }, { ok: true, status: 200 }] });
		const r = await runInstagramSync(deps, 'sync');
		expect(r.stopped).toBeNull();
		expect(r.sent).toBe(1);
		expect(sent).toHaveLength(2);
		expect(sleeps).toContain(3000);
	});
});

describe('READ-341: a list with no known post', () => {
	const oldKnown = Array.from({ length: 108 }, (_, i) => `old${i}`);
	const later = (deps: any) => { deps.now = () => 10 * 60 * 60 * 1000; };

	it('sends exactly the newest 20, saves the cursor after post 20 and fetches no further page', async () => {
		const { deps, store, sent, fetchFn } = makeDeps({ route: igRoute(30), store: enabled({ knownIds: oldKnown, lastSuccess: 5, lastAttemptAt: 0 }) });
		later(deps);
		const r = await runInstagramSync(deps, 'sync');
		expect(IG_NEW_LIST_POSTS).toBe(20);
		expect(r.stopped).toBeNull();
		expect(sent.map((s) => s.id)).toEqual(Array.from({ length: 20 }, (_, i) => `s${i}`));
		expect(fetchFn.calls.filter((u) => u.includes('/feed/saved/'))).toHaveLength(2);
		const st = store.data['sync:instagram'];
		expect(st.olderCursor).toBe('m2');
		expect(st.olderExhausted).toBe(false);
		expect(st.knownIds).toHaveLength(128);
		expect(st.knownIds.slice(-20)).toEqual(sent.map((s) => s.id));
	});

	it('a list shorter than 20 sends all of it and leaves the older cursor alone', async () => {
		const { deps, store, sent } = makeDeps({ route: igRoute(7), store: enabled({ knownIds: oldKnown, lastSuccess: 5, lastAttemptAt: 0 }) });
		later(deps);
		await runInstagramSync(deps, 'sync');
		expect(sent).toHaveLength(7);
		expect(store.data['sync:instagram'].olderCursor).toBeNull();
	});

	it('the 20 sent ids survive the known-id trim as the newest', async () => {
		const full = Array.from({ length: 5000 }, (_, i) => `old${i}`);
		const { deps, store, sent } = makeDeps({ route: igRoute(30), store: enabled({ knownIds: full, lastSuccess: 5, lastAttemptAt: 0 }) });
		later(deps);
		await runInstagramSync(deps, 'scheduled');
		const ids = store.data['sync:instagram'].knownIds;
		expect(ids).toHaveLength(5000);
		expect(ids.slice(-20)).toEqual(sent.map((s) => s.id));
	});

	it('a send that fails on page 2 keeps page 1 in the saved known ids', async () => {
		const sends = Array.from({ length: 10 }, () => ({ ok: true, status: 200 }));
		sends.push({ ok: false, status: 400 });
		const { deps, store } = makeDeps({ route: igRoute(30), store: enabled({ knownIds: oldKnown, lastSuccess: 5, lastAttemptAt: 0 }), sends });
		later(deps);
		const r = await runInstagramSync(deps, 'sync');
		expect(r.stopped).toBe('error');
		expect(r.sent).toBe(10);
		const st = store.data['sync:instagram'];
		expect(st.knownIds.slice(-10)).toEqual(Array.from({ length: 10 }, (_, i) => `s${i}`));
		expect(st.knownIds).not.toContain('s10');
		expect(st.running).toBe(false);
	});

	it('page 1 is saved before page 2 is fetched', async () => {
		let seen: string[] | null = null;
		const store = enabled({ knownIds: oldKnown, lastSuccess: 5, lastAttemptAt: 0 });
		const inner = igRoute(30);
		const route: Route = (url, init) => {
			if (url.includes('max_id=m1')) seen = store.data['sync:instagram'].knownIds.slice(-10);
			return inner(url, init);
		};
		const { deps } = makeDeps({ route, store });
		later(deps);
		await runInstagramSync(deps, 'sync');
		expect(seen).toEqual(Array.from({ length: 10 }, (_, i) => `s${i}`));
	});

	it('first run still caps at 100 and a later sync that meets known posts keeps its cursor alone', async () => {
		const first = makeDeps({ route: igRoute(250), store: enabled() });
		const r = await runInstagramSync(first.deps, 'sync');
		expect(r.sent).toBe(100);
		const known = ['s5', 's6', 's7'];
		const more = makeDeps({ route: igRoute(250), store: enabled({ knownIds: known, lastSuccess: 5, lastAttemptAt: 0 }) });
		later(more.deps);
		const r2 = await runInstagramSync(more.deps, 'sync');
		expect(r2.sent).toBe(5);
		expect(more.store.data['sync:instagram'].olderCursor).toBeNull();
	});
});
