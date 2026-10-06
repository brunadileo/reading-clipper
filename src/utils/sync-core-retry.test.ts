import { describe, it, expect } from 'vitest';
import { isTransientSend, sendWithRetry, SEND_RETRY_DELAYS_MS, type SendResult, type SyncDeps, type SyncPost } from './sync-core';

const post: SyncPost = { id: 'a', url: 'https://x.test/a', title: 'A', siteName: 'X' };

function run(results: SendResult[]) {
	const sleeps: number[] = [];
	let calls = 0;
	const deps = {
		sleep: async (ms: number) => { sleeps.push(ms); },
		send: async () => results[Math.min(calls++, results.length - 1)],
	} as unknown as SyncDeps;
	return { deps, sleeps, calls: () => calls };
}

describe('sendWithRetry', () => {
	it('waits 3 s then 10 s and gives up after two retries on a 5xx', async () => {
		const r = run([{ ok: false, status: 520 }]);
		const res = await sendWithRetry(r.deps, post, 'text');
		expect(res.status).toBe(520);
		expect(r.calls()).toBe(3);
		expect(r.sleeps).toEqual(SEND_RETRY_DELAYS_MS);
		expect(SEND_RETRY_DELAYS_MS).toEqual([3000, 10000]);
	});
	it('retries a network error (no status) and returns the first good answer', async () => {
		const r = run([{ ok: false, error: 'Failed to fetch' }, { ok: true, status: 200 }]);
		expect((await sendWithRetry(r.deps, post, undefined)).ok).toBe(true);
		expect(r.calls()).toBe(2);
		expect(r.sleeps).toEqual([3000]);
	});
	it('never retries 401, 429 or other 4xx', async () => {
		for (const status of [400, 401, 404, 429]) {
			const r = run([{ ok: false, status }]);
			expect((await sendWithRetry(r.deps, post, 't')).status).toBe(status);
			expect(r.calls()).toBe(1);
			expect(r.sleeps).toEqual([]);
		}
	});
	it('isTransientSend covers 500 to 599 and no status, not success', () => {
		expect(isTransientSend({ ok: false, status: 524 })).toBe(true);
		expect(isTransientSend({ ok: false })).toBe(true);
		expect(isTransientSend({ ok: false, status: 499 })).toBe(false);
		expect(isTransientSend({ ok: true, status: 200 })).toBe(false);
	});
});
