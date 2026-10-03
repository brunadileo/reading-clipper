import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = { token: '' };
const tabs: { id: number; url: string }[] = [];
const sessions = new Map<number, string | null>();
const created: number[] = [];
const removed: number[] = [];

vi.mock('./browser-polyfill', () => ({
	default: {
		scripting: {
			executeScript: async ({ target }: { target: { tabId: number } }) => [{ result: sessions.get(target.tabId) ?? null }],
		},
		tabs: {
			query: async () => tabs,
			create: async () => {
				const id = 99;
				created.push(id);
				return { id };
			},
			remove: async (id: number) => {
				removed.push(id);
			},
			onUpdated: {
				addListener: (fn: (id: number, info: { status: string }) => void) => setTimeout(() => fn(99, { status: 'complete' }), 0),
				removeListener: () => {},
			},
		},
	},
}));

const offscreen = { supported: false, ensured: [] as string[], released: [] as string[] };
vi.mock('./offscreen-doc', () => ({
	offscreenSupported: () => offscreen.supported,
	ensureOffscreen: async (h: string) => { offscreen.ensured.push(h); },
	releaseOffscreen: async (h: string) => { offscreen.released.push(h); },
}));

// What the relay inside the hidden frame reports after openLazyReaderFrame:
// a session, null (signed out or partitioned storage), or nothing at all.
let frameReport: { session: string | null } | 'silent' = 'silent';
const offscreenMessages: string[] = [];
const frameSender = { url: 'https://lazyreader.app/#lazyreader-clipper-session' };
(globalThis as any).chrome = {
	runtime: {
		sendMessage: async (msg: { action: string }) => {
			offscreenMessages.push(msg.action);
			if (msg.action === 'openLazyReaderFrame' && frameReport !== 'silent') {
				const report = frameReport;
				setTimeout(() => acceptFrameSession(frameSender, report.session), 0);
			}
			return { ok: true };
		},
	},
};

vi.mock('./storage-utils', () => ({
	loadReadingSettings: async () => ({ captureUrl: 'x', token: stored.token }),
	saveReadingSettings: async (s: { token?: string }) => {
		if (s.token !== undefined) stored.token = s.token;
	},
}));

import { acceptFrameSession, FRAME_TIMEOUT_MS, refreshReadingToken } from './reading-token';

function profileFetch(token: string | null, status = 200) {
	return vi.fn(async (_url: string, init: RequestInit) => {
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer session-1');
		return new Response(JSON.stringify(token ? { capture_token: token } : { error: 'Unauthorized' }), { status });
	}) as unknown as typeof fetch;
}

beforeEach(() => {
	stored.token = '';
	tabs.length = 0;
	sessions.clear();
	created.length = 0;
	removed.length = 0;
	offscreen.supported = false;
	offscreen.ensured.length = 0;
	offscreen.released.length = 0;
	offscreenMessages.length = 0;
	frameReport = 'silent';
	vi.useRealTimers();
});

describe('refreshReadingToken', () => {
	it('reads the session from an open lazyreader.app tab and stores the token', async () => {
		tabs.push({ id: 5, url: 'https://lazyreader.app/settings' });
		sessions.set(5, 'session-1');
		const token = await refreshReadingToken(undefined, profileFetch('tok-new'));
		expect(token).toBe('tok-new');
		expect(stored.token).toBe('tok-new');
		expect(created).toEqual([]);
	});

	it('opens a background tab when none is open, and closes it', async () => {
		sessions.set(99, 'session-1');
		const token = await refreshReadingToken(undefined, profileFetch('tok-bg'));
		expect(token).toBe('tok-bg');
		expect(created).toEqual([99]);
		expect(removed).toEqual([99]);
	}, 10000);

	it('returns null and keeps the old token when not signed in', async () => {
		stored.token = 'old';
		tabs.push({ id: 5, url: 'https://lazyreader.app/' });
		sessions.set(5, null);
		const token = await refreshReadingToken(5, profileFetch('never'));
		expect(token).toBeNull();
		expect(stored.token).toBe('old');
	});

	it('returns null when getMyProfile rejects the session', async () => {
		tabs.push({ id: 5, url: 'https://lazyreader.app/' });
		sessions.set(5, 'session-1');
		const token = await refreshReadingToken(5, profileFetch(null, 401));
		expect(token).toBeNull();
		expect(stored.token).toBe('');
	});

	it('reads the session from a hidden offscreen frame before opening a tab', async () => {
		offscreen.supported = true;
		frameReport = { session: 'session-1' };
		const token = await refreshReadingToken(undefined, profileFetch('tok-frame'));
		expect(token).toBe('tok-frame');
		expect(created).toEqual([]);
		expect(offscreenMessages).toEqual(['openLazyReaderFrame', 'closeLazyReaderFrame']);
		expect(offscreen.ensured).toEqual(['token']);
		expect(offscreen.released).toEqual(['token']);
	});

	it('falls back to the background tab when the frame has no session', async () => {
		offscreen.supported = true;
		frameReport = { session: null };
		sessions.set(99, 'session-1');
		const token = await refreshReadingToken(undefined, profileFetch('tok-bg'));
		expect(token).toBe('tok-bg');
		expect(created).toEqual([99]);
		expect(offscreen.released).toEqual(['token']);
	}, 10000);

	it('gives up on a silent frame after the timeout and falls back', async () => {
		vi.useFakeTimers();
		offscreen.supported = true;
		sessions.set(99, 'session-1');
		const pending = refreshReadingToken(undefined, profileFetch('tok-bg'));
		await vi.advanceTimersByTimeAsync(FRAME_TIMEOUT_MS - 1);
		expect(created).toEqual([]);
		await vi.advanceTimersByTimeAsync(5000);
		expect(await pending).toBe('tok-bg');
		expect(created).toEqual([99]);
		expect(offscreenMessages).toEqual(['openLazyReaderFrame', 'closeLazyReaderFrame']);
	});
});

describe('acceptFrameSession', () => {
	it('ignores reports when no lookup is waiting', () => {
		expect(acceptFrameSession(frameSender, 'session-1')).toBe(false);
	});

	it('ignores reports from a tab or another origin while a lookup waits', async () => {
		vi.useFakeTimers();
		offscreen.supported = true;
		sessions.set(99, 'session-1');
		const pending = refreshReadingToken(undefined, profileFetch('tok-bg'));
		await vi.advanceTimersByTimeAsync(0);
		expect(acceptFrameSession({ ...frameSender, tab: { id: 3 } }, 'session-1')).toBe(false);
		expect(acceptFrameSession({ url: 'https://evil.example/' }, 'session-1')).toBe(false);
		expect(acceptFrameSession({ url: 'https://lazyreader.app.evil.example/' }, 'session-1')).toBe(false);
		expect(acceptFrameSession(frameSender, 'session-1')).toBe(true);
		expect(await pending).toBe('tok-bg');
		expect(created).toEqual([]);
	});
});
