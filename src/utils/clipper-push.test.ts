import { describe, it, expect } from 'vitest';
import { memoryStore, fakeFetch } from './sync-test-helpers';
import { base64UrlToBytes, describePushStatus, ensureClipperPush, loadPushState, PUSH_STATE_KEY, VAPID_PUBLIC_KEY, type ClipperPushDeps } from './clipper-push';

const sub = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'P', auth: 'A' } }) };

function setup(over: Partial<ClipperPushDeps> = {}, answer: { status?: number } = {}) {
	const store = memoryStore();
	const bodies: any[] = [];
	const headers: any[] = [];
	const f = fakeFetch(() => ({ status: answer.status ?? 200, json: { ok: true } }));
	const fetchFn = ((url: any, init: any) => { bodies.push(JSON.parse(init.body)); headers.push(init.headers); return f(url, init); }) as typeof fetch;
	const deps: ClipperPushDeps = {
		store,
		supported: () => true,
		loadSettings: async () => ({ token: 'tok', captureUrl: 'https://lazyreader.app/api/capture' }),
		getSubscription: async () => null,
		subscribe: async () => sub,
		fetchFn,
		now: () => 1000,
		...over,
	};
	return { deps, store, bodies, headers, f };
}

describe('ensureClipperPush', () => {
	it('subscribes and registers with the token header and the three fields', async () => {
		const t = setup();
		const s = await ensureClipperPush(t.deps);
		expect(s.registered).toBe(true);
		expect(t.f.calls).toEqual(['https://lazyreader.app/api/registerClipper']);
		expect(t.bodies[0]).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'P', auth: 'A' });
		expect(t.headers[0]['x-reader-token']).toBe('tok');
		expect((await loadPushState(t.store)).registered).toBe(true);
	});
	it('reuses an existing subscription', async () => {
		let subscribed = 0;
		const t = setup({ getSubscription: async () => sub, subscribe: async () => { subscribed++; return sub; } });
		await ensureClipperPush(t.deps);
		expect(subscribed).toBe(0);
	});
	it('a subscribe failure is silent, recorded, and sends nothing', async () => {
		const t = setup({ subscribe: async () => { throw new Error('permission denied'); } });
		const s = await ensureClipperPush(t.deps);
		expect(s.registered).toBe(false);
		expect(s.error).toBe('permission denied');
		expect(t.f.calls).toEqual([]);
		expect((await t.store.get(PUSH_STATE_KEY)).registered).toBe(false);
		// Nothing else in storage was touched (the schedule keeps running on its own).
		expect(Object.keys(t.store.data)).toEqual([PUSH_STATE_KEY]);
	});
	it('does nothing without a token, in an unsupported browser, or on a server error', async () => {
		const noToken = setup({ loadSettings: async () => ({ token: '', captureUrl: 'https://lazyreader.app/api/capture' }) });
		expect((await ensureClipperPush(noToken.deps)).registered).toBe(false);
		expect(noToken.f.calls).toEqual([]);
		const unsupported = setup({ supported: () => false });
		expect((await ensureClipperPush(unsupported.deps)).registered).toBe(false);
		const rejected = setup({}, { status: 401 });
		const s = await ensureClipperPush(rejected.deps);
		expect(s.registered).toBe(false);
		expect(s.error).toBe('server answered 401');
	});
});

describe('push helpers', () => {
	it('decodes the VAPID key to a 65 byte uncompressed point', () => {
		const b = base64UrlToBytes(VAPID_PUBLIC_KEY);
		expect(b.length).toBe(65);
		expect(b[0]).toBe(4);
	});
	it('words the settings line', () => {
		expect(describePushStatus({ registered: true, at: 1, error: null })).toBe('Instant finish: on');
		expect(describePushStatus({ registered: false, at: null, error: null })).toBe('Instant finish: off, waiting articles finish on the schedule');
	});
});
