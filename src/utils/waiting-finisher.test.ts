import { describe, it, expect } from 'vitest';
import { checkFullText, isSafeFetchUrl, pickBestText } from './full-text-check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWaitingApi, endpointUrl, parseWaitingItems } from './waiting-api';
import { FEED_MAX_BYTES, feedTextFits, isCheckPageTitle, pickFeedText } from './feed-read';
import type { WaitingApi, WaitingItem, ProvideResult } from './waiting-api';
import {
	AUTO_LIMIT, AUTO_MIN_GAP_MS, cleanTitle, FINISH_KEY, NOW_LIMIT, emptyFinishState, ITEM_RETRY_MS, pruneAttempts, runFinisher, shouldRun, youtubeVideoId,
	type FinisherDeps,
} from './waiting-finisher';
import { PREVIEW_NOTE } from './substack-sync';
import { memoryStore } from './sync-test-helpers';
import type { TranscriptRead } from './youtube-sync';

const full = (n = 500) => 'word '.repeat(n).trim();
const item = (i: number, url = `https://site${i}.example.com/a`): WaitingItem => ({ id: `i${i}`, url, title: `T${i}`, code: 'needs_text' });
const video = (i: number): WaitingItem => ({ id: `v${i}`, url: `https://www.youtube.com/watch?v=vid${String(i).padStart(8, '0')}`, title: '', code: 'needs_transcript' });

function setup(opts: {
	items?: WaitingItem[];
	state?: any;
	pages?: (url: string) => { status: number; html: string; finalUrl?: string } | Error;
	extract?: (html: string) => string;
	// READ-249: the title Defuddle reads from the fetched page, and the window tab's title.
	pageTitle?: string;
	fallbackTitle?: string;
	fallback?: (url: string) => string | null;
	provide?: (id: string, text?: string) => ProvideResult;
	list?: { ok: boolean; status?: number };
	hasToken?: boolean;
	noFallback?: boolean;
	transcript?: (videoId: string) => TranscriptRead | Error;
	noTranscriptReader?: boolean;
	// READ-414
	feedSend?: (id: string, text: string) => ProvideResult;
	feedWindow?: (url: string) => string | null | Error;
	noFeedWindow?: boolean;
}) {
	const store = memoryStore(opts.state ? { [FINISH_KEY]: { ...emptyFinishState(), ...opts.state } } : {});
	const fetched: string[] = [];
	const opened: string[] = [];
	const provided: Array<{ id: string; text?: string; title?: string; publisher?: string; outcome?: string }> = [];
	let t = 10_000_000;
	const api: WaitingApi = {
		list: async () => ({ ok: opts.list?.ok ?? true, status: opts.list?.status ?? 200, items: opts.items ?? [] }),
		provideText: async (id, text, title, publisher) => { provided.push({ id, text, title: title || undefined, ...(publisher ? { publisher } : {}) }); return opts.provide?.(id, text) ?? { ok: true, status: 200 }; },
		markUnreadable: async (id) => { provided.push({ id, outcome: 'unreadable' }); return opts.provide?.(id) ?? { ok: true, status: 200 }; },
		provideFeedText: async (id, text) => { feedSent.push({ id, text }); return opts.feedSend?.(id, text) ?? { ok: true, status: 200 }; },
	};
	const feedSent: Array<{ id: string; text: string }> = [];
	const feedWindowCalls: string[] = [];
	const transcriptCalls: string[] = [];
	const deps: FinisherDeps = {
		store, api,
		readTranscript: opts.noTranscriptReader ? undefined : async (id) => {
			transcriptCalls.push(id);
			const r = opts.transcript ? opts.transcript(id) : { text: null, blocked: false };
			if (r instanceof Error) throw r;
			return r;
		},
		hasToken: async () => opts.hasToken ?? true,
		fetchPage: async (url) => {
			fetched.push(url);
			const r = opts.pages ? opts.pages(url) : { status: 200, html: '<p>x</p>' };
			if (r instanceof Error) throw r;
			return { finalUrl: url, ...r };
		},
		extractHtml: async (html) => ({ text: opts.extract ? opts.extract(html) : html, title: opts.pageTitle ?? '' }),
		openForExtraction: opts.noFallback ? undefined : async (url) => {
			opened.push(url);
			const text = opts.fallback ? opts.fallback(url) : null;
			return text === null ? null : { text, title: opts.fallbackTitle ?? '' };
		},
		readFeedInWindow: opts.noFeedWindow ? undefined : async (url) => {
			feedWindowCalls.push(url);
			const r = opts.feedWindow ? opts.feedWindow(url) : null;
			if (r instanceof Error) throw r;
			return r;
		},
		sleep: async (ms) => { t += ms; },
		now: () => (t += 1000),
		random: () => 0,
	};
	return { deps, store, fetched, opened, provided, transcriptCalls, feedSent, feedWindowCalls };
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

describe('push wake (READ-247)', () => {
	const now = 50_000_000;
	it('a push has no gap, and keeps the other rules', () => {
		const at = (ms: number) => ({ ...emptyFinishState(), lastAttemptAt: now - ms });
		expect(shouldRun('push', at(5 * 60_000), true, now)).toBeNull();
		expect(shouldRun('push', at(1000), true, now)).toBeNull();
		expect(shouldRun('push', { ...emptyFinishState(), enabled: false }, true, now)).toBe('disabled');
		expect(shouldRun('push', emptyFinishState(), false, now)).toBe('no-token');
		expect(shouldRun('push', { ...emptyFinishState(), running: true, lastAttemptAt: now - 60_000 }, true, now)).toBe('busy');
	});
	it('the rerun after a busy wake has no gap', () => {
		expect(shouldRun('wake-rerun', { ...emptyFinishState(), lastAttemptAt: now - 1000 }, true, now)).toBeNull();
	});
	it('two wakes 30 seconds apart both finish their new item', async () => {
		const a = setup({ items: [item(1)], pages: () => ({ status: 200, html: full() }) });
		expect((await runFinisher(a.deps, 'push')).finished).toBe(1);
		const b = setup({ items: [item(2)], pages: () => ({ status: 200, html: full() }), state: { lastAttemptAt: 10_000_000 - 30_000 } });
		const r = await runFinisher(b.deps, 'push');
		expect(r.skipped).toBeNull();
		expect(r.finished).toBe(1);
		expect(b.provided.map((p) => p.id)).toEqual(['i2']);
	});
	it('a new item is finished by a push at once', async () => {
		const { deps, provided } = setup({ items: [item(1)], pages: () => ({ status: 200, html: full() }) });
		const r = await runFinisher(deps, 'push');
		expect(r.finished).toBe(1);
		expect(provided.map((p) => p.id)).toEqual(['i1']);
	});
});

describe('hourly retry per item (READ-247)', () => {
	const failing = { pages: () => ({ status: 500, html: '' }), noFallback: true };
	it('an automatic run skips an item tried under 60 minutes ago, and records the try', async () => {
		const a = setup({ items: [item(1), item(2)], ...failing, state: { triedAt: { i1: 10_000_000 - 10 * 60_000 } } });
		await runFinisher(a.deps, 'alarm');
		expect(a.fetched).toEqual(['https://site2.example.com/a']);
		expect((await a.store.get(FINISH_KEY)).triedAt.i2).toBeGreaterThan(0);
	});
	it('an item tried more than 60 minutes ago is tried again', async () => {
		const a = setup({ items: [item(1)], ...failing, state: { triedAt: { i1: 10_000_000 - ITEM_RETRY_MS - 5000 } } });
		await runFinisher(a.deps, 'push');
		expect(a.fetched.length).toBe(1);
	});
	it('Sync now tries everything', async () => {
		const a = setup({ items: [item(1)], ...failing, state: { triedAt: { i1: 10_000_000 - 1000 } } });
		await runFinisher(a.deps, 'now');
		expect(a.fetched.length).toBe(1);
	});
	it('forgets items that left the list', async () => {
		const a = setup({ items: [item(1)], ...failing, state: { triedAt: { gone: 1 } } });
		await runFinisher(a.deps, 'now');
		expect(Object.keys((await a.store.get(FINISH_KEY)).triedAt)).toEqual(['i1']);
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
	it('ignores a redirect to a private address and opens no window for it', async () => {
		const { deps, provided, opened } = setup({
			items: [item(1)],
			pages: () => ({ status: 200, html: full(), finalUrl: 'https://10.0.0.1/x' }),
			fallback: () => full(),
		});
		await runFinisher(deps, 'now');
		expect(provided).toEqual([]);
		expect(opened).toEqual([]);
	});
	it('the clipper check normalises curly quotes and markdown headings', () => {
		expect(checkFullText('# Attention Required! | Cloudflare').ok).toBe(false);
		expect(checkFullText(`${full(600)} Subscribe to read the full story`).ok).toBe(false);
	});

	it('stops on Lazy Reader 401, 429 and 5xx, but not on a 4xx from the article site', async () => {
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
	it('a network failure to Lazy Reader stops the run', async () => {
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

describe('describeFinishStatus wording', () => {
	it('no token points to Connection', async () => {
		const { describeFinishStatus, emptyFinishState } = await import('./waiting-finisher');
		expect(describeFinishStatus(emptyFinishState(), false, 0)).toBe('Connect to Lazy Reader first (see Connection).');
	});
	it('every status line starts with a capital letter', async () => {
		const { describeFinishStatus, emptyFinishState } = await import('./waiting-finisher');
		const s = { ...emptyFinishState(), enabled: true, lastRunAt: 0 };
		expect(describeFinishStatus(s, true, 5 * 60000)).toMatch(/^[A-Z0-9]/);
	});
});

describe('READ-48 all-sites grant', () => {
	it('shouldRun skips quietly without the grant, whatever the trigger', () => {
		const now = 50_000_000;
		expect(shouldRun('alarm', emptyFinishState(), true, now, false)).toBe('no-access');
		expect(shouldRun('now', emptyFinishState(), true, now, false)).toBe('no-access');
		expect(shouldRun('alarm', emptyFinishState(), true, now, true)).toBeNull();
		expect(shouldRun('alarm', emptyFinishState(), false, now, false)).toBe('no-token');
	});
	it('runFinisher does no fetch and no list call without the grant', async () => {
		const { deps, fetched, provided } = setup({ items: [item(1)] });
		const r = await runFinisher({ ...deps, hasAccess: async () => false }, 'alarm');
		expect(r.skipped).toBe('no-access');
		expect(fetched).toEqual([]);
		expect(provided).toEqual([]);
	});
	it('needs-access and status wording', async () => {
		const { describeFinishStatus, finishNeedsAccess } = await import('./waiting-finisher');
		const s = emptyFinishState();
		expect(finishNeedsAccess(s, true, false)).toBe(true);
		expect(finishNeedsAccess(s, true, true)).toBe(false);
		expect(finishNeedsAccess(s, false, false)).toBe(false);
		expect(finishNeedsAccess({ ...s, enabled: false }, true, false)).toBe(false);
		expect(describeFinishStatus(s, true, 0, false)).toBe('Off until you allow access to the sites you save from.');
	});
});

describe('needs_transcript items (READ-38)', () => {
	const words = 'word '.repeat(80).trim();

	it('a needs_text and a needs_transcript item take their own paths', async () => {
		const { deps, provided, fetched, transcriptCalls } = setup({
			items: [item(1), video(2)],
			pages: () => ({ status: 200, html: full() }),
			transcript: () => ({ text: `## Transcript\n\n${words}`, blocked: false }),
		});
		const r = await runFinisher(deps, 'now');
		expect(fetched).toEqual(['https://site1.example.com/a']); // the video page is never fetched
		expect(transcriptCalls).toEqual(['vid00000002']);
		expect(provided).toEqual([
			{ id: 'i1', text: full() },
			{ id: 'v2', text: `## Transcript\n\n${words}` },
		]);
		expect(r.finished).toBe(2);
	});

	it('READ-357: the video title and channel reach provideText', async () => {
		const { deps, provided } = setup({
			items: [video(1)],
			transcript: () => ({ text: `## Transcript\n\n${words}`, blocked: false, title: '  A real title  ', author: ' Some channel ' }),
		});
		await runFinisher(deps, 'now');
		expect(provided).toEqual([{ id: 'v1', text: `## Transcript\n\n${words}`, title: 'A real title', publisher: 'Some channel' }]);
	});

	it('READ-357: a title that is the link, blank, or missing is not sent; the channel still is', async () => {
		const url = video(1).url;
		for (const title of [url, '   ', undefined]) {
			const { deps, provided } = setup({ items: [video(1)], transcript: () => ({ text: `## Transcript\n\n${words}`, blocked: false, title, author: 'Chan' }) });
			await runFinisher(deps, 'now');
			expect(provided).toEqual([{ id: 'v1', text: `## Transcript\n\n${words}`, publisher: 'Chan' }]);
		}
		const { deps, provided } = setup({ items: [video(1)], transcript: () => ({ text: `## Transcript\n\n${words}`, blocked: false, title: 'x'.repeat(500) }) });
		await runFinisher(deps, 'now');
		expect(provided[0].title).toHaveLength(300);
		expect(provided[0].publisher).toBeUndefined();
	});

	it('a video with no transcript counts an attempt and stays waiting', async () => {
		const { deps, provided, store } = setup({ items: [video(1)] });
		const r = await runFinisher(deps, 'now');
		expect(provided).toEqual([]);
		expect(r.retryLater).toBe(1);
		expect(store.data[FINISH_KEY].attempts).toEqual({ v1: 1 });
	});

	it('the 3rd failed attempt marks the video unreadable so it leaves the waiting list', async () => {
		const { deps, provided, store, transcriptCalls } = setup({ items: [video(1)], state: { attempts: { v1: 2 } } });
		const third = await runFinisher(deps, 'now');
		expect(transcriptCalls).toHaveLength(1);
		expect(third.unreadable).toBe(1);
		expect(provided).toEqual([{ id: 'v1', outcome: 'unreadable' }]);
		expect(store.data[FINISH_KEY].attempts).toEqual({});
	});

	it('a refused unreadable mark keeps the video stuck and retried later', async () => {
		const { deps, transcriptCalls, store } = setup({ items: [video(1)], state: { attempts: { v1: 2 } }, provide: () => ({ ok: false, status: 409 }) });
		const third = await runFinisher(deps, 'now');
		expect(third.retryLater).toBe(1);
		expect(store.data[FINISH_KEY].attempts).toEqual({ v1: 3 });
		const fourth = await runFinisher(deps, 'now');
		expect(transcriptCalls).toHaveLength(1); // no new read, only the mark is retried
		expect(fourth.retryLater).toBe(1);
	});

	it('a video already at 3 attempts gets its unreadable mark retried without a transcript read, even when reads are off', async () => {
		const { deps, provided, store, transcriptCalls } = setup({
			items: [video(1), video(2)],
			state: { attempts: { v1: 3 } },
			transcript: () => ({ text: null, blocked: true }),
		});
		const r = await runFinisher(deps, 'now');
		expect(provided).toEqual([{ id: 'v1', outcome: 'unreadable' }]);
		expect(transcriptCalls).toEqual(['vid00000002']);
		expect(r.unreadable).toBe(1);
		expect(store.data[FINISH_KEY].attempts).toEqual({});
	});

	it('two unclear answers in a row end transcript reads for the run and cost no attempt', async () => {
		const { deps, provided, store, transcriptCalls } = setup({
			items: [video(1), video(2), video(3), item(4)],
			state: { attempts: { v1: 2 } },
			transcript: () => ({ text: null, blocked: false, transient: true }),
			pages: () => ({ status: 200, html: full() }),
		});
		const r = await runFinisher(deps, 'now');
		expect(transcriptCalls).toEqual(['vid00000001', 'vid00000002']);
		expect(r.transcriptsBlocked).toBe(false);
		expect(r.unreadable).toBe(0);
		expect(store.data[FINISH_KEY].attempts).toEqual({ v1: 2 });
		expect(store.data[FINISH_KEY].softMisses).toEqual({ v1: 1, v2: 1 });
		expect(provided).toEqual([{ id: 'i4', text: full() }]);
	});

	it('three unclear answers for one video cost one attempt, so it still leaves the list in the end', async () => {
		const { deps, store } = setup({
			items: [video(1)],
			state: { attempts: { v1: 2 }, softMisses: { v1: 2 } },
			transcript: () => ({ text: null, blocked: false, transient: true }),
		});
		const r = await runFinisher(deps, 'now');
		expect(r.unreadable).toBe(1);
		expect(store.data[FINISH_KEY].attempts).toEqual({});
		expect(store.data[FINISH_KEY].softMisses).toEqual({});
	});

	it('a blocked answer ends transcript reads for the run, costs no attempt, and articles still go', async () => {
		const { deps, provided, store, transcriptCalls } = setup({
			items: [video(1), video(2), item(3)],
			transcript: () => ({ text: null, blocked: true }),
			pages: () => ({ status: 200, html: full() }),
		});
		const r = await runFinisher(deps, 'now');
		expect(transcriptCalls).toEqual(['vid00000001']);
		expect(r.transcriptsBlocked).toBe(true);
		expect(store.data[FINISH_KEY].attempts).toEqual({});
		expect(provided).toEqual([{ id: 'i3', text: full() }]);
	});

	it('a throwing reader is not a definite answer and counts no attempt; an item with no reader is left alone', async () => {
		const a = setup({ items: [video(1)], transcript: () => new Error('boom') });
		await runFinisher(a.deps, 'now');
		expect(a.store.data[FINISH_KEY].attempts).toEqual({});
		const b = setup({ items: [video(1)], noTranscriptReader: true });
		const r = await runFinisher(b.deps, 'now');
		expect(b.store.data[FINISH_KEY].attempts).toEqual({});
		expect(r.retryLater).toBe(0);
	});

	it('an automatic run marks a read video as tried and the next run within the hour leaves it alone (READ-247)', async () => {
		const { deps, store, transcriptCalls } = setup({ items: [video(1)] });
		await runFinisher(deps, 'push');
		expect(transcriptCalls).toEqual(['vid00000001']);
		expect(store.data[FINISH_KEY].triedAt.v1).toBeGreaterThan(0);
		await runFinisher(deps, 'push');
		await runFinisher(deps, 'alarm');
		expect(transcriptCalls).toHaveLength(1);
		await runFinisher(deps, 'now'); // Sync now tries everything
		expect(transcriptCalls).toHaveLength(2);
	});

	it('a push run keeps the blocked rule: one read, later videos untouched and not marked as tried', async () => {
		const { deps, store, transcriptCalls, provided } = setup({
			items: [video(1), video(2), video(3), item(4)],
			transcript: () => ({ text: null, blocked: true }),
			pages: () => ({ status: 200, html: full() }),
		});
		const r = await runFinisher(deps, 'push');
		expect(transcriptCalls).toEqual(['vid00000001']);
		expect(r.transcriptsBlocked).toBe(true);
		expect(Object.keys(store.data[FINISH_KEY].triedAt).sort()).toEqual(['i4', 'v1']);
		expect(provided).toEqual([{ id: 'i4', text: full() }]);
		await runFinisher(deps, 'push'); // the next wake reads one video (v2), not v1 again
		expect(transcriptCalls).toEqual(['vid00000001', 'vid00000002']);
	});

	it('a push run reads at most AUTO_LIMIT videos', async () => {
		const { deps, transcriptCalls } = setup({ items: Array.from({ length: AUTO_LIMIT + 5 }, (_, i) => video(i + 1)) });
		await runFinisher(deps, 'push');
		expect(transcriptCalls).toHaveLength(AUTO_LIMIT);
	});

	it('a code-less item from an older server is an article', () => {
		expect(parseWaitingItems({ items: [{ id: 'a', url: 'https://a.com' }, { id: 'b', url: 'https://www.youtube.com/watch?v=abcdefghijk', code: 'needs_transcript' }] }).map((i) => i.code)).toEqual(['needs_text', 'needs_transcript']);
	});

	it('reads the video id only from a youtube.com watch link', () => {
		expect(youtubeVideoId('https://www.youtube.com/watch?v=abcdefghijk')).toBe('abcdefghijk');
		expect(youtubeVideoId('https://evil.example/watch?v=abcdefghijk')).toBeNull();
		expect(youtubeVideoId('https://www.youtube.com/watch')).toBeNull();
		expect(youtubeVideoId('nope')).toBeNull();
	});
});

describe('titles (READ-249)', () => {
	const url = 'https://site1.example.com/a';
	const fullPage = () => ({ status: 200, html: full() });
	const teaserPage = () => ({ status: 200, html: full(120) + ' Subscribe to continue reading this story' });

	it('sends the fetched page title, trimmed', async () => {
		const { deps, provided } = setup({ items: [item(1)], pages: fullPage, pageTitle: '  Real headline \n' });
		await runFinisher(deps, 'now');
		expect(provided[0].title).toBe('Real headline');
	});
	it('caps the title at 300 characters', async () => {
		const { deps, provided } = setup({ items: [item(1)], pages: fullPage, pageTitle: 'x'.repeat(400) });
		await runFinisher(deps, 'now');
		expect(provided[0].title).toBe('x'.repeat(300));
	});
	it('cleanTitle compares with the link before capping, so a long link is never sent as a title', () => {
		const long = 'https://example.com/' + 'a'.repeat(340);
		expect(cleanTitle(long, long)).toBe('');
		expect(cleanTitle(` ${long} `, long)).toBe('');
		expect(cleanTitle('y'.repeat(400), long)).toBe('y'.repeat(300));
		// READ-357: another form of the link (share sheet `youtube.com/...&is=`) is not a title either.
		expect(cleanTitle('https://youtube.com/watch?v=abc&is=xyz', 'https://www.youtube.com/watch?v=abc')).toBe('');
		expect(cleanTitle('See https://example.com for more', 'https://a.test/')).toBe('See https://example.com for more');
	});
	it('sends the window title when the window text won', async () => {
		const { deps, provided } = setup({ items: [item(1)], pages: teaserPage, pageTitle: 'Teaser title', fallback: () => full(900), fallbackTitle: 'Window title' });
		await runFinisher(deps, 'now');
		expect(provided[0].text).toBe(full(900));
		expect(provided[0].title).toBe('Window title');
	});
	it('falls back to the other path title when the winner has none', async () => {
		const a = setup({ items: [item(1)], pages: teaserPage, pageTitle: 'Teaser title', fallback: () => full(900), fallbackTitle: '' });
		await runFinisher(a.deps, 'now');
		expect(a.provided[0].title).toBe('Teaser title');
		const b = setup({ items: [item(1)], pages: () => ({ status: 403, html: '' }), fallback: () => full(900), fallbackTitle: 'Window title' });
		await runFinisher(b.deps, 'now');
		expect(b.provided[0].title).toBe('Window title');
	});
	it('sends no title when it equals the link or is empty', async () => {
		const same = setup({ items: [item(1)], pages: fullPage, pageTitle: ` ${url} ` });
		await runFinisher(same.deps, 'now');
		expect(same.provided[0].title).toBeUndefined();
		const empty = setup({ items: [item(1)], pages: fullPage, pageTitle: '   ' });
		await runFinisher(empty.deps, 'now');
		expect(empty.provided[0].title).toBeUndefined();
	});
	it('sends no title for a transcript', async () => {
		const { deps, provided } = setup({ items: [video(1)], transcript: () => ({ text: full(), blocked: false }) });
		await runFinisher(deps, 'now');
		expect(provided).toEqual([{ id: 'v1', text: full() }]);
		expect(provided[0].title).toBeUndefined();
	});
});

describe('provideText request (READ-249)', () => {
	const call = async (title?: string) => {
		let body: any;
		const fetchFn = (async (_u: any, init: any) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof fetch;
		await createWaitingApi('https://lazyreader.app/api/capture', 'tok', fetchFn).provideText('i1', 'body', title);
		return body;
	};
	it('sends title only when non-empty', async () => {
		expect(await call('Headline')).toEqual({ item_id: 'i1', text: 'body', title: 'Headline' });
		expect(await call('')).toEqual({ item_id: 'i1', text: 'body' });
		expect(await call('  ')).toEqual({ item_id: 'i1', text: 'body' });
		expect(await call()).toEqual({ item_id: 'i1', text: 'body' });
	});
});

describe('provideText publisher (READ-357)', () => {
	const call = async (title?: string, publisher?: string) => {
		let body: any;
		const fetchFn = (async (_u: any, init: any) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({}) }; }) as unknown as typeof fetch;
		await createWaitingApi('https://lazyreader.app/api/capture', 'tok', fetchFn).provideText('i1', 'body', title, publisher);
		return body;
	};
	it('sends publisher only when non-blank, trimmed', async () => {
		expect(await call('T', ' Chan ')).toEqual({ item_id: 'i1', text: 'body', title: 'T', publisher: 'Chan' });
		expect(await call('', 'Chan')).toEqual({ item_id: 'i1', text: 'body', publisher: 'Chan' });
		expect(await call('T', '  ')).toEqual({ item_id: 'i1', text: 'body', title: 'T' });
		expect(await call('T')).toEqual({ item_id: 'i1', text: 'body', title: 'T' });
	});
});

describe('listWaiting request (READ-38)', () => {
	it('asks for needs_text, needs_transcript and needs_feed items', async () => {
		const { createWaitingApi } = await import('./waiting-api');
		let body: any;
		const fetchFn = (async (_u: any, init: any) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ items: [] }) }; }) as unknown as typeof fetch;
		await createWaitingApi('https://lazyreader.app/api/capture', 'tok', fetchFn).list();
		expect(body).toEqual({ codes: ['needs_text', 'needs_transcript', 'needs_feed'] });
	});
});

describe('feeds of sites that turn the server away (READ-414)', () => {
	const feed = (i = 1, url = `https://blog${i}.example.com/feed/`): WaitingItem => ({ id: `f${i}`, url, title: `blog${i}.example.com`, code: 'needs_feed' });
	const rss = '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><item><title>A</title><link>https://blog1.example.com/a</link></item></channel></rss>';
	const checkPage = readFileSync(join(__dirname, 'fixtures', 'feeds', 'salesforceben-check-page.html'), 'utf8');

	it('parses needs_feed and keeps unknown codes as needs_text', () => {
		const items = parseWaitingItems({ items: [
			{ id: 'f1', url: 'https://a.com/feed', title: 'a.com', code: 'needs_feed' },
			{ id: 'x', url: 'https://a.com/x', code: 'needs_other' },
			{ id: 'y', url: 'https://a.com/y' },
		] });
		expect(items.map((i) => i.code)).toEqual(['needs_feed', 'needs_text', 'needs_text']);
	});

	it('sends a 2xx feed once, with no window', async () => {
		const t = setup({ items: [feed(1)], pages: () => ({ status: 200, html: rss }) });
		const r = await runFinisher(t.deps, 'now');
		expect(t.feedSent).toEqual([{ id: 'f1', text: rss }]);
		expect(t.feedWindowCalls).toEqual([]);
		expect(t.provided).toEqual([]);
		expect(r.finished).toBe(1);
	});

	it('a 403 goes to the window read and its text is sent', async () => {
		const t = setup({ items: [feed(1)], pages: () => ({ status: 403, html: '' }), feedWindow: () => rss });
		const r = await runFinisher(t.deps, 'now');
		expect(t.feedWindowCalls).toEqual(['https://blog1.example.com/feed/']);
		expect(t.feedSent).toEqual([{ id: 'f1', text: rss }]);
		expect(r.finished).toBe(1);
	});

	it('a worker fetch that throws also goes to the window read', async () => {
		const t = setup({ items: [feed(1)], pages: () => new Error('net'), feedWindow: () => rss });
		await runFinisher(t.deps, 'now');
		expect(t.feedSent).toHaveLength(1);
	});

	it('a window still on the check page after 30 s sends nothing and costs no attempt', async () => {
		const t = setup({ items: [feed(1)], pages: () => ({ status: 403, html: checkPage }), feedWindow: () => null });
		const r = await runFinisher(t.deps, 'now');
		expect(t.feedSent).toEqual([]);
		expect(r.retryLater).toBe(1);
		expect(r.finished).toBe(0);
		const saved: any = await t.store.get(FINISH_KEY);
		expect(saved.attempts).toEqual({});
	});

	it('a 200 answer with an empty body, and an over-2 MB body, go to the window read', async () => {
		const big = 'a'.repeat(FEED_MAX_BYTES + 1);
		const t = setup({ items: [feed(1), feed(2)], pages: (u) => ({ status: 200, html: u.includes('blog1') ? '' : big }), feedWindow: () => big });
		const r = await runFinisher(t.deps, 'now');
		expect(t.feedWindowCalls).toHaveLength(2);
		expect(t.feedSent).toEqual([]);
		expect(r.retryLater).toBe(2);
	});

	it('follows needs_device at most 3 times', async () => {
		let n = 0;
		const t = setup({
			items: [feed(1)],
			pages: () => ({ status: 200, html: rss }),
			feedSend: () => ({ ok: true, status: 200, needsDevice: `https://blog1.example.com/f${++n}` }),
		});
		const r = await runFinisher(t.deps, 'now');
		expect(t.feedSent).toHaveLength(3);
		expect(t.fetched).toEqual(['https://blog1.example.com/feed/', 'https://blog1.example.com/f1', 'https://blog1.example.com/f2']);
		expect(r.retryLater).toBe(1);
		expect(r.finished).toBe(0);
	});

	it('follows one needs_device and finishes', async () => {
		let n = 0;
		const t = setup({
			items: [feed(1)],
			pages: () => ({ status: 200, html: rss }),
			feedSend: () => (n++ === 0 ? { ok: true, status: 200, needsDevice: 'https://blog1.example.com/rss.xml' } : { ok: true, status: 200 }),
		});
		const r = await runFinisher(t.deps, 'now');
		expect(t.fetched).toEqual(['https://blog1.example.com/feed/', 'https://blog1.example.com/rss.xml']);
		expect(r.finished).toBe(1);
	});

	it('never follows a needs_device link it must not open', async () => {
		const t = setup({
			items: [feed(1)],
			pages: () => ({ status: 200, html: rss }),
			feedSend: () => ({ ok: true, status: 200, needsDevice: 'https://192.168.1.2/feed' }),
		});
		await runFinisher(t.deps, 'now');
		expect(t.fetched).toEqual(['https://blog1.example.com/feed/']);
		expect(t.feedSent).toHaveLength(1);
	});

	it('a feed failure never calls markUnreadable, however often it fails', async () => {
		const t = setup({ items: [feed(1)], pages: () => ({ status: 403, html: '' }), feedWindow: () => null,
			state: { attempts: { f1: 9 } } });
		for (let i = 0; i < 5; i++) await runFinisher(t.deps, 'now');
		expect(t.provided.filter((p) => p.outcome === 'unreadable')).toEqual([]);
	});

	it('a refused send (404, 409, 422) is retry later, no attempt, no markUnreadable', async () => {
		for (const status of [404, 409, 422, 413, 400]) {
			const t = setup({ items: [feed(1)], pages: () => ({ status: 200, html: rss }), feedSend: () => ({ ok: false, status }) });
			const r = await runFinisher(t.deps, 'now');
			expect(r.retryLater).toBe(1);
			expect(r.stopped).toBeNull();
			expect(t.provided).toEqual([]);
			expect(((await t.store.get(FINISH_KEY)) as any).attempts).toEqual({});
		}
	});

	it('401 from Lazy Reader stops the run like for articles', async () => {
		const t = setup({ items: [feed(1), feed(2)], pages: () => ({ status: 200, html: rss }), feedSend: () => ({ ok: false, status: 401 }) });
		const r = await runFinisher(t.deps, 'now');
		expect(r.stopped).toBe('token');
		expect(t.feedSent).toHaveLength(1);
	});

	it('an unsafe feed url is not fetched and not marked unreadable', async () => {
		const t = setup({ items: [feed(1, 'https://localhost/feed'), feed(2, 'file:///etc/passwd')] });
		const r = await runFinisher(t.deps, 'now');
		expect(t.fetched).toEqual([]);
		expect(t.feedWindowCalls).toEqual([]);
		expect(t.provided).toEqual([]);
		expect(r.retryLater).toBe(2);
	});

	it('a redirect to a link it must not read sends nothing', async () => {
		const t = setup({ items: [feed(1)], pages: (u) => ({ status: 200, html: rss, finalUrl: 'https://10.0.0.5/feed' }) });
		await runFinisher(t.deps, 'now');
		expect(t.feedSent).toEqual([]);
		expect(t.feedWindowCalls).toEqual([]);
	});

	it('without a window reader a refused feed is retried later', async () => {
		const t = setup({ items: [feed(1)], pages: () => ({ status: 403, html: '' }), noFeedWindow: true });
		const r = await runFinisher(t.deps, 'now');
		expect(r.retryLater).toBe(1);
		expect(t.feedSent).toEqual([]);
	});

	it('automatic runs leave a feed alone for an hour after the last try', async () => {
		const t = setup({ items: [feed(1)], pages: () => ({ status: 403, html: '' }), feedWindow: () => null });
		await runFinisher(t.deps, 'now');
		await runFinisher(t.deps, 'wake-rerun');
		expect(t.fetched).toHaveLength(1);
	});

	it('feeds and articles in one list are each handled by their own branch', async () => {
		const t = setup({ items: [item(1), feed(2), video(3)], pages: (u) => ({ status: 200, html: u.includes('blog2') ? rss : full() }),
			transcript: () => ({ text: full(), blocked: false }) });
		const r = await runFinisher(t.deps, 'now');
		expect(t.feedSent.map((f) => f.id)).toEqual(['f2']);
		expect(t.provided.map((p) => p.id)).toEqual(['i1', 'v3']);
		expect(r.finished).toBe(3);
	});

	it('an old-shape list without needs_feed behaves as before', async () => {
		const t = setup({ items: [item(1), item(2)], pages: () => ({ status: 200, html: full() }) });
		const r = await runFinisher(t.deps, 'now');
		expect(t.feedSent).toEqual([]);
		expect(t.feedWindowCalls).toEqual([]);
		expect(r.finished).toBe(2);
	});

	it('provideFeedText posts feed_id and text and reads needs_device', async () => {
		let url = '';
		let body: any;
		let headers: any;
		const fetchFn = (async (u: any, init: any) => { url = u; body = JSON.parse(init.body); headers = init.headers; return { ok: true, status: 200, json: async () => ({ needs_device: 'https://a.com/feed' }) }; }) as unknown as typeof fetch;
		const r = await createWaitingApi('https://lazyreader.app/api/capture', 'tok', fetchFn).provideFeedText('f1', '<html></html>');
		expect(url).toBe('https://lazyreader.app/api/provideFeedText');
		expect(body).toEqual({ feed_id: 'f1', text: '<html></html>' });
		expect(headers['x-reader-token']).toBe('tok');
		expect(r).toMatchObject({ ok: true, needsDevice: 'https://a.com/feed' });
	});

	it('provideFeedText: a 200 that carries error is not a read', async () => {
		const fetchFn = (async () => ({ ok: true, status: 200, json: async () => ({ feed: {}, added: 0, error: 'save failed' }) })) as unknown as typeof fetch;
		const r = await createWaitingApi('https://lazyreader.app/api/capture', 'tok', fetchFn).provideFeedText('f1', '<rss/>');
		expect(r).toMatchObject({ ok: false, status: 200, error: 'save failed' });
	});

	it('provideFeedText ignores a non-string needs_device and fails without a token', async () => {
		const json = async () => ({ needs_device: 5 });
		const fetchFn = (async () => ({ ok: true, status: 200, json })) as unknown as typeof fetch;
		expect((await createWaitingApi('https://lazyreader.app/api/capture', 'tok', fetchFn).provideFeedText('f1', 'x')).needsDevice).toBeUndefined();
		const r = await createWaitingApi('https://lazyreader.app/api/capture', '', fetchFn).provideFeedText('f1', 'x');
		expect(r.ok).toBe(false);
		expect(r.status).toBe(401);
	});

	it('the endpoint url for provideFeedText derives from the capture url', () => {
		expect(endpointUrl('https://lazyreader.app/api/capture', 'provideFeedText')).toBe('https://lazyreader.app/api/provideFeedText');
	});
});

describe('feed-read rules (READ-414)', () => {
	const checkPage = readFileSync(join(__dirname, 'fixtures', 'feeds', 'salesforceben-check-page.html'), 'utf8');
	const snap = (o: Partial<Parameters<typeof pickFeedText>[0]> = {}) => ({ contentType: 'text/xml', xmlSource: '', outerHTML: '', bodyText: '', preOnly: false, ...o });

	it('the saved check page title is read as a check page', () => {
		const title = /<title>([^<]*)<\/title>/.exec(checkPage)?.[1];
		expect(title).toBe('Checking your browser...');
		expect(isCheckPageTitle(title)).toBe(true);
	});
	it('knows check page titles, and not feed titles', () => {
		expect(isCheckPageTitle('Just a moment...')).toBe(true);
		expect(isCheckPageTitle('CHECKING YOUR BROWSER')).toBe(true);
		expect(isCheckPageTitle('Salesforce Ben RSS feed')).toBe(false);
		expect(isCheckPageTitle('')).toBe(false);
		expect(isCheckPageTitle(null)).toBe(false);
		expect(isCheckPageTitle(undefined)).toBe(false);
		expect(isCheckPageTitle('<script>alert(1)</script> Привет')).toBe(false);
	});
	it('feedTextFits: empty, blank, null, limit, multibyte', () => {
		expect(feedTextFits('')).toBe(false);
		expect(feedTextFits('   \n')).toBe(false);
		expect(feedTextFits(null)).toBe(false);
		expect(feedTextFits(undefined)).toBe(false);
		expect(feedTextFits('<rss/>')).toBe(true);
		expect(feedTextFits('a'.repeat(FEED_MAX_BYTES))).toBe(true);
		expect(feedTextFits('a'.repeat(FEED_MAX_BYTES + 1))).toBe(false);
		// fewer characters than the limit but more bytes
		expect(feedTextFits('é'.repeat(FEED_MAX_BYTES / 2 + 1))).toBe(false);
		expect(feedTextFits('é'.repeat(FEED_MAX_BYTES / 2))).toBe(true);
	});
	it('pickFeedText: xml source first, html outerHTML, plain text view falls back to the text', () => {
		expect(pickFeedText(snap({ xmlSource: '<rss/>', outerHTML: '<html>viewer</html>', bodyText: 'viewer' }))).toBe('<rss/>');
		expect(pickFeedText(snap({ contentType: 'text/html', outerHTML: '<html><rss/></html>', bodyText: 'x' }))).toBe('<html><rss/></html>');
		expect(pickFeedText(snap({ contentType: 'text/html', outerHTML: '<html><body><pre>&lt;rss/&gt;</pre></body></html>', bodyText: '<rss/>', preOnly: true }))).toBe('<rss/>');
		expect(pickFeedText(snap({ contentType: 'application/rss+xml', outerHTML: '<x/>', bodyText: '<rss/>' }))).toBe('<rss/>');
		expect(pickFeedText(snap({ xmlSource: '   ', contentType: 'text/xml', bodyText: 'text' }))).toBe('text');
	});
});
