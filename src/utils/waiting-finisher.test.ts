import { describe, it, expect } from 'vitest';
import { checkFullText, isSafeFetchUrl, pickBestText } from './full-text-check';
import { endpointUrl, parseWaitingItems } from './waiting-api';
import type { WaitingApi, WaitingItem, ProvideResult } from './waiting-api';
import {
	AUTO_LIMIT, AUTO_MIN_GAP_MS, FINISH_KEY, NOW_LIMIT, emptyFinishState, pruneAttempts, runFinisher, shouldRun,
	type FinisherDeps,
} from './waiting-finisher';
import { PREVIEW_NOTE } from './substack-sync';
import { memoryStore } from './sync-test-helpers';

const full = (n = 500) => 'word '.repeat(n).trim();
const item = (i: number, url = `https://site${i}.example.com/a`): WaitingItem => ({ id: `i${i}`, url, title: `T${i}` });

function setup(opts: {
	items?: WaitingItem[];
	state?: any;
	pages?: (url: string) => { status: number; html: string; finalUrl?: string } | Error;
	extract?: (html: string) => string;
	fallback?: (url: string) => string | null;
	provide?: (id: string, text?: string) => ProvideResult;
	list?: { ok: boolean; status?: number };
	hasToken?: boolean;
	noFallback?: boolean;
}) {
	const store = memoryStore(opts.state ? { [FINISH_KEY]: { ...emptyFinishState(), ...opts.state } } : {});
	const fetched: string[] = [];
	const opened: string[] = [];
	const provided: Array<{ id: string; text?: string; outcome?: string }> = [];
	let t = 10_000_000;
	const api: WaitingApi = {
		list: async () => ({ ok: opts.list?.ok ?? true, status: opts.list?.status ?? 200, items: opts.items ?? [] }),
		provideText: async (id, text) => { provided.push({ id, text }); return opts.provide?.(id, text) ?? { ok: true, status: 200 }; },
		markUnreadable: async (id) => { provided.push({ id, outcome: 'unreadable' }); return opts.provide?.(id) ?? { ok: true, status: 200 }; },
	};
	const deps: FinisherDeps = {
		store, api,
		hasToken: async () => opts.hasToken ?? true,
		fetchPage: async (url) => {
			fetched.push(url);
			const r = opts.pages ? opts.pages(url) : { status: 200, html: '<p>x</p>' };
			if (r instanceof Error) throw r;
			return { finalUrl: url, ...r };
		},
		extractHtml: async (html) => (opts.extract ? opts.extract(html) : html),
		openForExtraction: opts.noFallback ? undefined : async (url) => { opened.push(url); return opts.fallback ? opts.fallback(url) : null; },
		sleep: async (ms) => { t += ms; },
		now: () => (t += 1000),
		random: () => 0,
	};
	return { deps, store, fetched, opened, provided };
}

describe('waiting-api', () => {
	it('derives endpoints from the capture URL', () => {
		expect(endpointUrl('https://lazyreader.app/api/capture', 'listWaiting')).toBe('https://lazyreader.app/api/listWaiting');
		expect(endpointUrl('https://x.supabase.co/functions/v1/capture/', 'provideText')).toBe('https://x.supabase.co/functions/v1/provideText');
		expect(endpointUrl('https://example.com/custom', 'provideText')).toBe('https://example.com/api/provideText');
		expect(endpointUrl('not a url', 'listWaiting')).toBeNull();
	});
	it('parses items and drops broken ones', () => {
		expect(parseWaitingItems({ items: [{ id: 'a', url: 'https://a.com', title: 'A' }, { id: 'b' }, null] }).map((i) => i.id)).toEqual(['a']);
		expect(parseWaitingItems(undefined)).toEqual([]);
	});
});

describe('checkFullText', () => {
	it('flags walls, previews and empty text; passes real articles', () => {
		expect(checkFullText(full()).ok).toBe(true);
		expect(checkFullText('')).toEqual({ ok: false, reason: 'empty' });
		expect(checkFullText('Just a moment... ' + full(50))).toEqual({ ok: false, reason: 'wall' });
		expect(checkFullText(full(300) + ' Subscribe to continue reading this story')).toEqual({ ok: false, reason: 'wall' });
		expect(checkFullText(full(300) + PREVIEW_NOTE)).toEqual({ ok: false, reason: 'teaser' });
	});
	it('keeps a short public page', () => {
		expect(checkFullText(full(60)).ok).toBe(true);
	});
	it('picks the better text', () => {
		expect(pickBestText(full(100) + PREVIEW_NOTE, full(80))).toBe(full(80));
		expect(pickBestText(full(100), full(500))).toBe(full(500));
		expect(pickBestText('', '')).toBe('');
	});
});

describe('isSafeFetchUrl', () => {
	it.each(['http://example.com/a', 'file:///etc/passwd', 'https://localhost/a', 'https://127.0.0.1/a', 'https://10.0.0.5/a', 'https://192.168.1.2/a',
		'https://172.20.0.1/a', 'https://169.254.169.254/a', 'https://[::1]/a', 'https://printer.local/a', 'https://intranet/a', 'https://u:p@example.com/a', 'nonsense'])('rejects %s', (u) => {
		expect(isSafeFetchUrl(u)).toBe(false);
	});
	it('accepts public https', () => {
		expect(isSafeFetchUrl('https://medium.com/@a/b-123')).toBe(true);
		expect(isSafeFetchUrl('https://blog.example.co.uk/x?y=1')).toBe(true);
	});
});

describe('trigger throttle', () => {
	const now = 50_000_000;
	it('automatic triggers wait 10 minutes; Finish now does not', () => {
		const s = { ...emptyFinishState(), lastAttemptAt: now - 5 * 60_000 };
		expect(shouldRun('alarm', s, true, now)).toBe('throttled');
		expect(shouldRun('idle', s, true, now)).toBe('throttled');
		expect(shouldRun('startup', s, true, now)).toBe('throttled');
		expect(shouldRun('now', s, true, now)).toBeNull();
		expect(shouldRun('alarm', { ...s, lastAttemptAt: now - AUTO_MIN_GAP_MS - 1 }, true, now)).toBeNull();
	});
	it('needs a token; off blocks automatic runs only; a fresh lock blocks all, a stale one does not', () => {
		expect(shouldRun('now', emptyFinishState(), false, now)).toBe('no-token');
		expect(shouldRun('alarm', { ...emptyFinishState(), enabled: false }, true, now)).toBe('disabled');
		expect(shouldRun('now', { ...emptyFinishState(), enabled: false }, true, now)).toBeNull();
		expect(shouldRun('alarm', emptyFinishState(), true, now)).toBeNull(); // on by default with a token
		const running = { ...emptyFinishState(), running: true, lastAttemptAt: now - 60_000 };
		expect(shouldRun('now', running, true, now)).toBe('busy');
		expect(shouldRun('now', { ...running, lastAttemptAt: now - 16 * 60_000 }, true, now)).toBeNull();
	});
	it('a throttled run does nothing', async () => {
		const { deps, fetched, provided } = setup({ items: [item(1)], state: { lastAttemptAt: 10_000_000 - 1000 } });
		const r = await runFinisher(deps, 'alarm');
		expect(r.skipped).toBe('throttled');
		expect(fetched).toEqual([]);
		expect(provided).toEqual([]);
	});
});

describe('runFinisher', () => {
	it('sends the fetched text and counts members only from the server answer', async () => {
		const { deps, provided, store } = setup({
			items: [item(1), item(2)],
			pages: () => ({ status: 200, html: full() }),
			provide: (id) => (id === 'i2' ? { ok: true, status: 200, outcome: 'members_only' } : { ok: true, status: 200 }),
		});
		const r = await runFinisher(deps, 'now');
		expect(r).toMatchObject({ finished: 1, membersOnly: 1, stopped: null });
		expect(provided.map((p) => p.id)).toEqual(['i1', 'i2']);
		expect(store.data[FINISH_KEY].running).toBe(false);
		expect(store.data[FINISH_KEY].waitingCount).toBe(2);
	});

	it('prunes attempts to the ids the list returned', () => {
		expect(pruneAttempts({ i1: 2, gone: 1 }, [item(1)])).toEqual({ i1: 2 });
	});
	it('prunes stored attempts on a run', async () => {
		const { deps, store } = setup({ items: [item(1)], state: { attempts: { gone: 2, i1: 1 } }, pages: () => ({ status: 200, html: '' }) });
		await runFinisher(deps, 'now');
		expect(store.data[FINISH_KEY].attempts).toEqual({ i1: 2 });
	});

	it('counts an attempt per failure and sends unreadable at 3', async () => {
		const { deps, provided, store } = setup({
			items: [item(1)], state: { attempts: { i1: 2 } },
			pages: () => ({ status: 200, html: '' }), noFallback: true,
		});
		const r = await runFinisher(deps, 'now');
		expect(provided).toEqual([{ id: 'i1', outcome: 'unreadable' }]);
		expect(r.unreadable).toBe(1);
		expect(store.data[FINISH_KEY].attempts).toEqual({});
	});
	it('first failure only counts one attempt', async () => {
		const { deps, provided, store } = setup({ items: [item(1)], pages: () => new Error('network'), noFallback: true });
		const r = await runFinisher(deps, 'now');
		expect(provided).toEqual([]);
		expect(r.retryLater).toBe(1);
		expect(store.data[FINISH_KEY].attempts).toEqual({ i1: 1 });
	});
	it('an item already at 3 attempts is marked unreadable without a fetch', async () => {
		const { deps, provided, fetched } = setup({ items: [item(1)], state: { attempts: { i1: 3 } } });
		await runFinisher(deps, 'now');
		expect(fetched).toEqual([]);
		expect(provided).toEqual([{ id: 'i1', outcome: 'unreadable' }]);
	});

	it('uses the fallback only when the fetched text fails the check', async () => {
		const ok = setup({ items: [item(1)], pages: () => ({ status: 200, html: full() }), fallback: () => full(900) });
		await runFinisher(ok.deps, 'now');
		expect(ok.opened).toEqual([]);

		const teaser = setup({
			items: [item(1)],
			pages: () => ({ status: 200, html: full(120) + ' Subscribe to continue reading this story' }),
			fallback: () => full(900),
		});
		await runFinisher(teaser.deps, 'now');
		expect(teaser.opened).toEqual(['https://site1.example.com/a']);
		expect(teaser.provided[0].text).toBe(full(900));

		const blocked = setup({ items: [item(1)], pages: () => ({ status: 403, html: '' }), fallback: () => full(700) });
		await runFinisher(blocked.deps, 'now');
		expect(blocked.opened.length).toBe(1);
		expect(blocked.provided[0].text).toBe(full(700));
	});
	it('does not open a window for a 404', async () => {
		const { deps, opened, store } = setup({ items: [item(1)], pages: () => ({ status: 404, html: '' }), fallback: () => full() });
		await runFinisher(deps, 'now');
		expect(opened).toEqual([]);
		expect(store.data[FINISH_KEY].attempts).toEqual({ i1: 1 });
	});
	it('sends the teaser when the fallback is no better, so the server can say members only', async () => {
		const { deps, provided } = setup({
			items: [item(1)],
			pages: () => ({ status: 200, html: full(120) + ' Subscribe to continue reading this story' }),
			fallback: () => null,
		});
		await runFinisher(deps, 'now');
		expect(provided[0].id).toBe('i1');
		expect(provided[0].text).toContain('Subscribe to continue');
	});

	it('never fetches a non-https or private link', async () => {
		const items = [item(1, 'http://example.com/a'), item(2, 'https://192.168.0.4/a'), item(3, 'https://localhost/a'), item(4, 'file:///etc/hosts')];
		const { deps, fetched, opened, provided } = setup({ items });
		const r = await runFinisher(deps, 'now');
		expect(fetched).toEqual([]);
		expect(opened).toEqual([]);
		expect(provided.every((p) => p.outcome === 'unreadable')).toBe(true);
		expect(r.unreadable).toBe(4);
	});
	it('ignores a redirect to a private address', async () => {
		const { deps, provided } = setup({
			items: [item(1)], noFallback: true,
			pages: () => ({ status: 200, html: full(), finalUrl: 'https://10.0.0.1/x' }),
		});
		await runFinisher(deps, 'now');
		expect(provided).toEqual([]);
	});

	it('stops on LazyReader 401, 429 and 5xx, but not on a 4xx from the article site', async () => {
		for (const [status, reason] of [[401, 'token'], [429, 'rate-limited'], [503, 'error']] as const) {
			const { deps, provided } = setup({
				items: [item(1), item(2)], pages: () => ({ status: 200, html: full() }),
				provide: () => ({ ok: false, status }),
			});
			const r = await runFinisher(deps, 'now');
			expect(r.stopped).toBe(reason);
			expect(provided.length).toBe(1);
		}
		const listFail = await runFinisher(setup({ items: [item(1)], list: { ok: false, status: 401 } }).deps, 'now');
		expect(listFail.stopped).toBe('token');
		const site403 = setup({ items: [item(1), item(2)], pages: () => ({ status: 403, html: '' }), noFallback: true });
		const r = await runFinisher(site403.deps, 'now');
		expect(r.stopped).toBeNull();
		expect(site403.fetched.length).toBe(2);
	});
	it('a network failure to LazyReader stops the run', async () => {
		const { deps } = setup({ items: [item(1)], pages: () => ({ status: 200, html: full() }), provide: () => ({ ok: false, error: 'offline' }) });
		expect((await runFinisher(deps, 'now')).stopped).toBe('error');
	});

	it('caps an automatic run at 10 items and Finish now at 20', async () => {
		const items = Array.from({ length: 30 }, (_, i) => item(i));
		const auto = setup({ items, pages: () => ({ status: 200, html: full() }) });
		await runFinisher(auto.deps, 'alarm');
		expect(auto.fetched.length).toBe(AUTO_LIMIT);
		const now = setup({ items, pages: () => ({ status: 200, html: full() }) });
		await runFinisher(now.deps, 'now');
		expect(now.fetched.length).toBe(NOW_LIMIT);
	});
	it('waits 2 to 4 seconds between items', async () => {
		const sleeps: number[] = [];
		const { deps } = setup({ items: [item(1), item(2), item(3)], pages: () => ({ status: 200, html: full() }) });
		deps.sleep = async (ms) => { sleeps.push(ms); };
		await runFinisher(deps, 'now');
		expect(sleeps).toEqual([2000, 2000]);
	});
	it('does nothing without a token', async () => {
		const { deps, fetched } = setup({ items: [item(1)], hasToken: false });
		expect((await runFinisher(deps, 'now')).skipped).toBe('no-token');
		expect(fetched).toEqual([]);
	});
});
