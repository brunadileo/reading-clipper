import { describe, it, expect } from 'vitest';
import { memoryStore } from './sync-test-helpers';
import {
	intervalMinutes, isDue, nextDueAt, loadSchedule, saveSchedule, runSequence, describeScheduleStatus,
	JOB_PAUSE_MS, SCHEDULE_KEY, STALE_RUN_MS, FREQUENCY_LABELS, DEFAULT_FREQUENCY, type SyncJob, type SyncFrequency,
} from './sync-schedule';

const HOUR = 3_600_000;

function harness(initial: Record<string, any> = {}) {
	const store = memoryStore(initial);
	let t = 10_000_000;
	const sleeps: number[] = [];
	const deps = { store, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } };
	return { store, deps, sleeps, advance: (ms: number) => { t += ms; }, now: () => t };
}

function job(id: string, log: string[], over: Partial<SyncJob> & { fail?: boolean } = {}): SyncJob {
	return {
		id,
		name: id,
		enabled: over.enabled ?? (async () => true),
		run: over.run ?? (async () => {
			log.push(`start:${id}`);
			await Promise.resolve();
			if (over.fail) { log.push(`fail:${id}`); throw new Error(`${id} broke`); }
			log.push(`end:${id}`);
			return 'ok';
		}),
	};
}

describe('frequency to interval', () => {
	it('maps the four schedules and never goes under one hour', () => {
		expect(intervalMinutes('hourly')).toBe(60);
		expect(intervalMinutes('every3h')).toBe(180);
		expect(intervalMinutes('twiceDaily')).toBe(720);
		expect(intervalMinutes('daily')).toBe(1440);
		for (const f of Object.keys(FREQUENCY_LABELS) as SyncFrequency[]) {
			const m = intervalMinutes(f);
			if (m !== null) expect(m).toBeGreaterThanOrEqual(60);
		}
	});
	it('defaults to twice a day', () => {
		expect(DEFAULT_FREQUENCY).toBe('twiceDaily');
	});
	it('"Only when I press Sync now" never schedules', () => {
		expect(intervalMinutes('manual')).toBeNull();
		expect(nextDueAt('manual', null, 5)).toBeNull();
		expect(isDue('manual', null, 1e15)).toBe(false);
		expect(isDue('manual', 0, 1e15)).toBe(false);
	});
});

describe('catch-up rule', () => {
	it('is due when a full interval has passed since the last run started', () => {
		expect(isDue('hourly', 0, HOUR)).toBe(true);
		expect(isDue('hourly', 0, HOUR - 1)).toBe(false);
		expect(isDue('twiceDaily', 0, 11 * HOUR)).toBe(false);
		expect(isDue('twiceDaily', 0, 12 * HOUR)).toBe(true);
	});
	it('a run that never happened is due', () => {
		expect(isDue('daily', null, 5)).toBe(true);
	});
	it('startup and idle triggers run once when due, then not again inside the interval', async () => {
		const h = harness({ [SCHEDULE_KEY]: { frequency: 'every3h', lastRunAt: 10_000_000 - 4 * HOUR } });
		const log: string[] = [];
		const first = await runSequence([job('a', log)], h.deps, 'startup');
		expect(first.skipped).toBeNull();
		expect(log).toEqual(['start:a', 'end:a']);
		const second = await runSequence([job('a', log)], h.deps, 'idle');
		expect(second.skipped).toBe('not-due');
		h.advance(2 * HOUR);
		expect((await runSequence([job('a', log)], h.deps, 'idle')).skipped).toBe('not-due');
		h.advance(HOUR + 1000);
		expect((await runSequence([job('a', log)], h.deps, 'idle')).skipped).toBeNull();
	});
	it('stores lastRunAt when a run starts', async () => {
		const h = harness();
		await runSequence([job('a', [])], h.deps, 'now');
		expect((await loadSchedule(h.store)).lastRunAt).toBe(10_000_000);
	});
	it('Sync now runs at once even inside the interval', async () => {
		const h = harness({ [SCHEDULE_KEY]: { frequency: 'daily', lastRunAt: 10_000_000 - 1000 } });
		const log: string[] = [];
		expect((await runSequence([job('a', log)], h.deps, 'now')).skipped).toBeNull();
		expect(log).toContain('end:a');
	});
	it('manual frequency ignores alarm, startup and idle', async () => {
		const h = harness({ [SCHEDULE_KEY]: { frequency: 'manual', lastRunAt: null } });
		const log: string[] = [];
		for (const trig of ['alarm', 'startup', 'idle'] as const) {
			expect((await runSequence([job('a', log)], h.deps, trig)).skipped).toBe('manual');
		}
		expect(log).toEqual([]);
	});
});

describe('sequence', () => {
	it('runs strictly one after the other, in the given order, with a pause between', async () => {
		const h = harness();
		const log: string[] = [];
		await runSequence([job('finish', log), job('substack', log), job('instagram', log)], h.deps, 'now');
		expect(log).toEqual(['start:finish', 'end:finish', 'start:substack', 'end:substack', 'start:instagram', 'end:instagram']);
		expect(h.sleeps).toEqual([JOB_PAUSE_MS, JOB_PAUSE_MS]);
	});
	it('one failure never skips the later jobs', async () => {
		const h = harness();
		const log: string[] = [];
		const res = await runSequence([job('finish', log, { fail: true }), job('substack', log), job('instagram', log, { fail: true })], h.deps, 'now');
		expect(log).toEqual(['start:finish', 'fail:finish', 'start:substack', 'end:substack', 'start:instagram', 'fail:instagram']);
		expect(res.ran.map((r) => r.ok)).toEqual([false, true, false]);
		const state = await loadSchedule(h.store);
		expect(state.running).toBe(false);
		expect(state.lastSummary).toContain('finish: failed, finish broke');
	});
	it('skips disabled services and numbers the steps among the enabled ones', async () => {
		const h = harness();
		const log: string[] = [];
		const steps: string[] = [];
		const watch = (id: string): SyncJob => job(id, log, {
			run: async () => { steps.push(describeScheduleStatus(await loadSchedule(h.store), h.now())); log.push(id); return 'ok'; },
		});
		const off = job('substack', log, { enabled: async () => false });
		await runSequence([watch('finish'), off, watch('instagram')], h.deps, 'now');
		expect(log).toEqual(['finish', 'instagram']);
		expect(steps).toEqual(['1 of 2: finish', '2 of 2: instagram']);
	});
	it('nothing enabled means nothing runs and no clock is recorded', async () => {
		const h = harness();
		const res = await runSequence([job('a', [], { enabled: async () => false })], h.deps, 'now');
		expect(res.skipped).toBe('nothing-to-run');
		expect((await loadSchedule(h.store)).lastRunAt).toBeNull();
	});
	it('Load older and web Finish now leave the schedule clock alone', async () => {
		const h = harness();
		await runSequence([job('a', [])], h.deps, 'finish-now', { recordRun: false });
		expect((await loadSchedule(h.store)).lastRunAt).toBeNull();
	});
});

describe('lock', () => {
	it('a second trigger while running is ignored', async () => {
		const h = harness();
		const log: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const slow: SyncJob = { id: 'slow', name: 'slow', enabled: async () => true, run: async () => { log.push('slow:start'); await gate; log.push('slow:end'); return 'ok'; } };
		const first = runSequence([slow], h.deps, 'now');
		const second = await runSequence([job('other', log)], h.deps, 'alarm');
		const third = await runSequence([job('other', log)], h.deps, 'now');
		expect(second.skipped).toBe('busy');
		expect(third.skipped).toBe('busy');
		release();
		await first;
		expect(log).toEqual(['slow:start', 'slow:end']);
	});
	it('two triggers arriving in the same tick start only one run', async () => {
		const h = harness();
		const log: string[] = [];
		const [a, b] = await Promise.all([runSequence([job('x', log)], h.deps, 'now'), runSequence([job('x', log)], h.deps, 'now')]);
		expect([a.skipped, b.skipped].filter((x) => x === 'busy')).toHaveLength(1);
		expect([a.skipped, b.skipped]).toContain(null);
		expect(log).toEqual(['start:x', 'end:x']);
	});
	it('a stored running flag from another worker blocks, until it is stale', async () => {
		const h = harness();
		await saveSchedule(h.store, { ...(await loadSchedule(h.store)), running: true, lastAttemptAt: h.now() - 60_000 });
		const log: string[] = [];
		expect((await runSequence([job('x', log)], h.deps, 'now')).skipped).toBe('busy');
		await saveSchedule(h.store, { ...(await loadSchedule(h.store)), running: true, lastAttemptAt: h.now() - STALE_RUN_MS - 1 });
		expect((await runSequence([job('x', log)], h.deps, 'now')).skipped).toBeNull();
		expect(log).toEqual(['start:x', 'end:x']);
	});
	it('releases the lock after a run, so the next trigger works', async () => {
		const h = harness();
		await runSequence([job('x', [])], h.deps, 'now');
		expect((await loadSchedule(h.store)).running).toBe(false);
		expect((await runSequence([job('x', [])], h.deps, 'now')).skipped).toBeNull();
	});
});

describe('status line', () => {
	it('shows the running step, then the last result and time', () => {
		const base = { frequency: 'hourly' as const, lastRunAt: 0, running: true, lastAttemptAt: 1000, step: { index: 2, total: 3, name: 'Substack' }, lastFinishedAt: null, lastSummary: null };
		expect(describeScheduleStatus(base, 2000)).toBe('2 of 3: Substack');
		const done = { ...base, running: false, step: null, lastFinishedAt: 0, lastSummary: 'Substack: 2 saved' };
		expect(describeScheduleStatus(done, 5 * 60_000)).toBe('Last sync 5 min ago. Substack: 2 saved');
		expect(describeScheduleStatus({ ...done, lastFinishedAt: null, lastSummary: null }, 0)).toBe('No sync yet.');
	});
});
