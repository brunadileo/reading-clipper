import { describe, it, expect } from 'vitest';
import { memoryStore } from './sync-test-helpers';
import {
	intervalMinutes, isDue, isOwnPageSender, isRunning, manualOnly, nextDueAt, loadSchedule, saveSchedule, runSequence, describeScheduleStatus,
	JOB_ORDER, JOB_PAUSE_MS, PENDING_WAKE_KEY, SCHEDULE_KEY, markPendingWake, STALE_RUN_MS, FREQUENCY_LABELS, DEFAULT_FREQUENCY, type SyncJob, type SyncFrequency,
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
	it('defaults to every hour', () => {
		expect(DEFAULT_FREQUENCY).toBe('hourly');
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

describe('four jobs with YouTube (READ-38)', () => {
	const names: Record<string, string> = { substack: 'Substack', instagram: 'Instagram', finish: 'Finish waiting articles', youtube: 'YouTube' };
	const four = (h: ReturnType<typeof harness>, log: string[], steps: string[], over: Record<string, Partial<SyncJob> & { fail?: boolean }> = {}): SyncJob[] =>
		JOB_ORDER.map((id) => ({
			...job(id, log, over[id] ?? {}),
			name: names[id],
			run: over[id]?.fail
				? async () => { log.push(`fail:${id}`); throw new Error('refused'); }
				: async () => { steps.push(describeScheduleStatus(await loadSchedule(h.store), h.now())); log.push(id); return 'ok'; },
		}));

	it('runs YouTube fourth, after Substack, Instagram and finish', () => {
		expect(JOB_ORDER).toEqual(['substack', 'instagram', 'finish', 'youtube']);
	});
	it('shows "4 of 4: YouTube" and never overlaps the others', async () => {
		const h = harness();
		const log: string[] = [];
		const steps: string[] = [];
		await runSequence(four(h, log, steps), h.deps, 'now');
		expect(log).toEqual(['substack', 'instagram', 'finish', 'youtube']);
		expect(steps).toEqual(['1 of 4: Substack', '2 of 4: Instagram', '3 of 4: Finish waiting articles', '4 of 4: YouTube']);
		expect(h.sleeps).toEqual([JOB_PAUSE_MS, JOB_PAUSE_MS, JOB_PAUSE_MS]);
	});
	it('a failing YouTube job is recorded and does not stop a job that comes after it', async () => {
		const h = harness();
		const log: string[] = [];
		const later = job('medium', log);
		const jobs = [...four(h, log, [], { youtube: { fail: true } }), later];
		const res = await runSequence(jobs, h.deps, 'now');
		expect(log).toEqual(['substack', 'instagram', 'finish', 'fail:youtube', 'start:medium', 'end:medium']);
		expect(res.ran.map((r) => r.ok)).toEqual([true, true, true, false, true]);
		expect((await loadSchedule(h.store)).lastSummary).toContain('YouTube: failed, refused');
	});
	it('a failing job before YouTube does not skip it', async () => {
		const h = harness();
		const log: string[] = [];
		await runSequence(four(h, log, [], { finish: { fail: true } }), h.deps, 'now');
		expect(log[log.length - 1]).toBe('youtube');
	});
	it('YouTube alone: step 1 of 1, and it follows the shared floor like the others', async () => {
		const h = harness();
		const log: string[] = [];
		const only = four(h, log, []).map((j) => ({ ...j, enabled: async () => j.id === 'youtube' }));
		expect((await runSequence(only, h.deps, 'alarm')).ran.map((r) => r.id)).toEqual(['youtube']);
		// Inside the interval a scheduled trigger does nothing.
		expect((await runSequence(only, h.deps, 'idle')).skipped).toBe('not-due');
	});
});

describe('Medium job (button-only, READ-36)', () => {
	// The order buildJobs uses: substack, instagram, medium, finish.
	const jobs = (manual: boolean, log: string[], over: { mediumFails?: boolean; mediumOn?: boolean } = {}): SyncJob[] => [
		job('substack', log),
		job('instagram', log),
		job('medium', log, { enabled: manualOnly(manual, async () => over.mediumOn ?? true), fail: over.mediumFails }),
		job('finish', log),
	];
	it('an alarm, idle or startup run skips Medium', async () => {
		for (const trig of ['alarm', 'idle', 'startup'] as const) {
			const h = harness({ [SCHEDULE_KEY]: { frequency: 'hourly', lastRunAt: null } });
			const log: string[] = [];
			await runSequence(jobs(false, log), h.deps, trig);
			expect(log).toEqual(['start:substack', 'end:substack', 'start:instagram', 'end:instagram', 'start:finish', 'end:finish']);
		}
	});
	it('Sync now runs Medium after Instagram and before finish', async () => {
		const h = harness();
		const log: string[] = [];
		await runSequence(jobs(true, log), h.deps, 'now');
		expect(log).toEqual(['start:substack', 'end:substack', 'start:instagram', 'end:instagram', 'start:medium', 'end:medium', 'start:finish', 'end:finish']);
	});
	it('a switch that is off keeps Medium out even on Sync now', async () => {
		const h = harness();
		const log: string[] = [];
		await runSequence(jobs(true, log, { mediumOn: false }), h.deps, 'now');
		expect(log).not.toContain('start:medium');
	});
	it('a failing Medium job does not stop finish', async () => {
		const h = harness();
		const log: string[] = [];
		const res = await runSequence(jobs(true, log, { mediumFails: true }), h.deps, 'now');
		expect(log).toEqual(['start:substack', 'end:substack', 'start:instagram', 'end:instagram', 'start:medium', 'fail:medium', 'start:finish', 'end:finish']);
		expect(res.ran.map((r) => r.ok)).toEqual([true, true, false, true]);
	});
	it('Load older and the row Sync run Medium alone and leave the schedule clock alone', async () => {
		const h = harness();
		const log: string[] = [];
		await runSequence([job('medium', log)], h.deps, 'older', { recordRun: false });
		expect(log).toEqual(['start:medium', 'end:medium']);
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

describe('stale lock and senders', () => {
	it('a running flag older than the stale limit no longer counts as running', () => {
		expect(isRunning({ running: true, lastAttemptAt: 0 }, STALE_RUN_MS - 1)).toBe(true);
		expect(isRunning({ running: true, lastAttemptAt: 0 }, STALE_RUN_MS)).toBe(false);
		expect(isRunning({ running: false, lastAttemptAt: 0 }, 1)).toBe(false);
	});
	it('the settings page in a tab is our own page; content scripts and other extensions are not', () => {
		const base = 'chrome-extension://abc/';
		expect(isOwnPageSender({ id: 'abc', url: `${base}settings.html`, tab: { id: 1 } }, 'abc', base)).toBe(true);
		expect(isOwnPageSender({ id: 'abc', url: 'https://lazyreader.app/x', tab: { id: 1 } }, 'abc', base)).toBe(false);
		expect(isOwnPageSender({ id: 'other', url: `${base}settings.html` }, 'abc', base)).toBe(false);
		expect(isOwnPageSender({ id: 'abc' }, 'abc', base)).toBe(false);
	});
});

describe('one-time move to the hourly default (READ-247)', () => {
	it('a saved twiceDaily without defaultV becomes hourly once and is stored', async () => {
		const h = harness({ [SCHEDULE_KEY]: { frequency: 'twiceDaily', lastRunAt: 5 } });
		const s = await loadSchedule(h.store);
		expect(s.frequency).toBe('hourly');
		expect(s.lastRunAt).toBe(5);
		expect(h.store.data[SCHEDULE_KEY]).toMatchObject({ frequency: 'hourly', defaultV: 2 });
	});
	it('a later choice of twiceDaily sticks', async () => {
		const h = harness({ [SCHEDULE_KEY]: { frequency: 'twiceDaily' } });
		const s = await loadSchedule(h.store);
		await saveSchedule(h.store, { ...s, frequency: 'twiceDaily' });
		expect((await loadSchedule(h.store)).frequency).toBe('twiceDaily');
	});
	it('other saved frequencies stay; a fresh install is hourly', async () => {
		expect((await loadSchedule(harness({ [SCHEDULE_KEY]: { frequency: 'daily' } }).store)).frequency).toBe('daily');
		expect((await loadSchedule(harness().store)).frequency).toBe('hourly');
	});
});

describe('pending push wake (READ-247)', () => {
	it('reruns the wake job once when the flag was set during the run, and clears it', async () => {
		const h = harness();
		const log: string[] = [];
		const wake = job('wake', log);
		const main = job('a', log, { run: async () => { await markPendingWake(h.store); log.push('a'); return 'ok'; } });
		await runSequence([main], h.deps, 'now', { wakeJob: wake });
		expect(log).toEqual(['a', 'start:wake', 'end:wake']);
		expect(h.store.data[PENDING_WAKE_KEY]).toBe(false);
		await runSequence([job('a', log)], h.deps, 'now', { wakeJob: wake });
		expect(log.filter((l) => l === 'start:wake').length).toBe(1);
	});
	it('a second trigger while running is busy; the caller marks the wake', async () => {
		const h = harness();
		const log: string[] = [];
		let inner: Awaited<ReturnType<typeof runSequence>> | undefined;
		const wake = job('wake', log);
		const main = job('a', log, { run: async () => {
			inner = await runSequence([wake], h.deps, 'finish-push', { recordRun: false });
			if (inner.skipped === 'busy') await markPendingWake(h.store);
			return 'ok';
		} });
		await runSequence([main], h.deps, 'now', { wakeJob: wake });
		expect(inner?.skipped).toBe('busy');
		expect(log).toEqual(['start:wake', 'end:wake']);
	});
});
