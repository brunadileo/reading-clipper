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

vi.mock('./storage-utils', () => ({
	loadReadingSettings: async () => ({ captureUrl: 'x', token: stored.token }),
	saveReadingSettings: async (s: { token?: string }) => {
		if (s.token !== undefined) stored.token = s.token;
	},
}));

import { refreshReadingToken } from './reading-token';

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
});
