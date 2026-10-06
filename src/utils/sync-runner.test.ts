import { describe, it, expect, vi, beforeEach } from 'vitest';

// The seam: runSequence is replaced by a recorder, and the service runners by spies,
// so runOne's choice of jobs, order, options and run kinds can be read directly.
const calls: string[] = [];
const seq: { jobs: any[]; trigger: string; opts: any }[] = [];

vi.mock('./sync-schedule', async (orig) => ({
	...(await orig<typeof import('./sync-schedule')>()),
	runSequence: vi.fn(async (jobs: any[], _deps: unknown, trigger: string, opts: any) => {
		seq.push({ jobs, trigger, opts });
		return { skipped: null, ran: [] };
	}),
}));
vi.mock('./substack-sync', () => ({ runSubstackSync: vi.fn(async (_d: unknown, kind: string) => { calls.push(`substack:${kind}`); return { sent: 1, failed: 0, stopped: null }; }) }));
vi.mock('./instagram-sync', async (orig) => ({
	...(await orig<typeof import('./instagram-sync')>()),
	runInstagramSync: vi.fn(async (_d: unknown, kind: string) => { calls.push(`instagram:${kind}`); return { sent: 1, stopped: null }; }),
}));
vi.mock('./youtube-sync', async (orig) => ({
	...(await orig<typeof import('./youtube-sync')>()),
	runYoutubeSync: vi.fn(async (_d: unknown, kind: string) => { calls.push(`youtube:${kind}`); return { sent: 1, stopped: null }; }),
}));
vi.mock('./medium-sync', async (orig) => ({
	...(await orig<typeof import('./medium-sync')>()),
	runMediumSync: vi.fn(async (_d: unknown, kind: string) => { calls.push(`medium:${kind}`); return { sent: 1, linkOnly: 0, stopped: null }; }),
}));
vi.mock('./medium-runner', () => ({
	closeLeftoverMediumWindow: vi.fn(),
	makeMediumDeps: vi.fn((d: unknown) => d),
	releaseMediumOffscreen: vi.fn(async () => {}),
}));
const listeners: Array<(req: unknown, sender: unknown, send: (r?: any) => void) => unknown> = [];
let ownPage = true;
vi.mock('./browser-polyfill', () => ({
	default: {
		storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
		runtime: {
			onMessage: { addListener: (fn: any) => { listeners.push(fn); } },
			onInstalled: { addListener: () => {} },
		},
	},
}));
vi.mock('./waiting-runner', async (orig) => ({
	...(await orig<typeof import('./waiting-runner')>()),
	ownPageSender: () => ownPage,
	finishSupported: () => true,
	runFinish: vi.fn(async (kind: string) => { calls.push(`finish:${kind}`); return { finished: 0, membersOnly: 0, unreadable: 0 }; }),
}));

import { initSyncRunner, isRowSyncRequest, runOne } from './sync-runner';

beforeEach(() => { calls.length = 0; seq.length = 0; ownPage = true; });

describe('runOne(service, "now") (READ-250)', () => {
	for (const service of ['substack', 'instagram', 'youtube', 'medium'] as const) {
		it(`${service}: that service, then finish, one sequence that leaves the clock alone`, async () => {
			await runOne(service, 'now');
			expect(seq).toHaveLength(1);
			expect(seq[0].jobs.map((j) => j.id)).toEqual([service, 'finish']);
			expect(seq[0].opts.recordRun).toBe(false);
			expect(seq[0].trigger).toBe('now');
			for (const j of seq[0].jobs) await j.run();
			const manualKind = service === 'instagram' ? 'sync' : 'manual';
			expect(calls).toEqual([`${service}:${manualKind}`, 'finish:now']);
		});
	}

	it('Medium Load older runs Medium, then finish', async () => {
		await runOne('medium', 'older');
		expect(seq[0].jobs.map((j) => j.id)).toEqual(['medium', 'finish']);
		expect(seq[0].opts.recordRun).toBe(false);
		await seq[0].jobs[0].run();
		expect(calls).toEqual(['medium:older']);
	});
	it('other services Load older still run alone', async () => {
		await runOne('substack', 'older');
		expect(seq[0].jobs.map((j) => j.id)).toEqual(['substack']);
	});
});

describe('row Sync message whitelist (READ-250 choice 4)', () => {
	it('accepts now for all four services', () => {
		for (const service of ['substack', 'instagram', 'youtube', 'medium']) {
			expect(isRowSyncRequest({ action: 'syncRun', service, kind: 'now' })).toBe(true);
		}
	});
	it('rejects finish, unknown services, other kinds and other actions', () => {
		expect(isRowSyncRequest({ action: 'syncRun', service: 'finish', kind: 'now' })).toBe(false);
		expect(isRowSyncRequest({ action: 'syncRun', service: 'twitter', kind: 'now' })).toBe(false);
		expect(isRowSyncRequest({ action: 'syncRun', service: 'medium', kind: 'other' })).toBe(false);
		expect(isRowSyncRequest({ action: 'syncNow', service: 'medium', kind: 'now' })).toBe(false);
	});
});

describe('message handler (READ-250)', () => {
	const send = (req: unknown) => {
		const reply = vi.fn();
		const handled = listeners[0](req, {}, reply);
		return { handled, reply };
	};
	it('runs a row Sync only for the settings page', async () => {
		initSyncRunner();
		const ok = send({ action: 'syncRun', service: 'youtube', kind: 'now' });
		expect(ok.handled).toBe(true);
		await new Promise((r) => setTimeout(r, 0));
		expect(seq[seq.length - 1].jobs.map((j) => j.id)).toEqual(['youtube', 'finish']);
		const before = seq.length;
		ownPage = false;
		expect(send({ action: 'syncRun', service: 'youtube', kind: 'now' }).handled).toBeUndefined();
		expect(seq.length).toBe(before);
	});
});
