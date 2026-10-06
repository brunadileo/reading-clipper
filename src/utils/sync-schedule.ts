// READ-181 Task 6b (plan choice 26): one user-chosen sync schedule for the
// whole clipper, and the sequencer that runs the jobs strictly one after the
// other. Pure TypeScript with injected storage, clock and sleep, so every rule
// is unit-testable. No browser API is imported here.
import type { SyncStore } from './sync-core';

export type SyncFrequency = 'hourly' | 'every3h' | 'twiceDaily' | 'daily' | 'manual';

export const FREQUENCY_LABELS: Record<SyncFrequency, string> = {
	hourly: 'Every hour',
	every3h: 'Every 3 hours',
	twiceDaily: 'Twice a day',
	daily: 'Once a day',
	manual: 'Only when I press Sync now',
};
// READ-247 choice 11: Every hour is the default now. SCHEDULE_VERSION 2 marks a
// schedule saved after that change, so the one-time move from Twice a day runs once.
export const DEFAULT_FREQUENCY: SyncFrequency = 'hourly';
export const SCHEDULE_VERSION = 2;
// Set when a push wake found the sequence busy; the sequence reruns finish once when it ends.
export const PENDING_WAKE_KEY = 'finish:pendingWake';
export const MIN_INTERVAL_MINUTES = 60;
export const STALE_RUN_MS = 15 * 60 * 1000;
export const JOB_PAUSE_MS = 3000;
export const SCHEDULE_KEY = 'sync:schedule';

const MINUTES: Record<Exclude<SyncFrequency, 'manual'>, number> = {
	hourly: 60,
	every3h: 180,
	twiceDaily: 720,
	daily: 1440,
};

export const isFrequency = (v: unknown): v is SyncFrequency =>
	typeof v === 'string' && Object.prototype.hasOwnProperty.call(FREQUENCY_LABELS, v);

/** Minutes between scheduled runs, never under one hour. null = never scheduled. */
export function intervalMinutes(freq: SyncFrequency): number | null {
	if (freq === 'manual') return null;
	return Math.max(MIN_INTERVAL_MINUTES, MINUTES[freq]);
}

/** When the next scheduled run is due. null = never (manual). A run that never happened is due now. */
export function nextDueAt(freq: SyncFrequency, lastRunAt: number | null, now: number): number | null {
	const mins = intervalMinutes(freq);
	if (mins === null) return null;
	if (lastRunAt === null) return now;
	return lastRunAt + mins * 60_000;
}

/** Catch-up and alarm rule: a run is due only when a full interval has passed since the last run started. */
export function isDue(freq: SyncFrequency, lastRunAt: number | null, now: number): boolean {
	const due = nextDueAt(freq, lastRunAt, now);
	return due !== null && now >= due;
}

export type SequenceTrigger = 'alarm' | 'startup' | 'idle' | 'now' | 'older' | 'finish-now' | 'finish-push';

export interface ScheduleState {
	frequency: SyncFrequency;
	// When the last run STARTED. The next one is due a full interval after it.
	lastRunAt: number | null;
	running: boolean;
	lastAttemptAt: number | null;
	// Shown while running: "2 of 3: Substack".
	step: { index: number; total: number; name: string } | null;
	lastFinishedAt: number | null;
	lastSummary: string | null;
	defaultV?: number;
}

export const emptySchedule = (): ScheduleState => ({
	frequency: DEFAULT_FREQUENCY,
	lastRunAt: null,
	running: false,
	lastAttemptAt: null,
	step: null,
	lastFinishedAt: null,
	lastSummary: null,
	defaultV: SCHEDULE_VERSION,
});

export async function loadSchedule(store: SyncStore): Promise<ScheduleState> {
	const saved = await store.get(SCHEDULE_KEY);
	const s = { ...emptySchedule(), ...(saved && typeof saved === 'object' ? saved : {}) };
	if (!isFrequency(s.frequency)) s.frequency = DEFAULT_FREQUENCY;
	// One-time move (READ-247 choice 11): an older saved schedule has no defaultV.
	if (saved && typeof saved === 'object' && (saved as any).defaultV === undefined) {
		if (s.frequency === 'twiceDaily') s.frequency = 'hourly';
		s.defaultV = SCHEDULE_VERSION;
		await store.set(SCHEDULE_KEY, s);
	}
	return s;
}

export const saveSchedule = (store: SyncStore, s: ScheduleState) => store.set(SCHEDULE_KEY, s);

export interface SyncJob {
	id: string;
	name: string;
	enabled: () => Promise<boolean>;
	// Returns a short result line. Throwing counts as this job's failure only.
	run: () => Promise<string>;
}

export interface SequenceDeps {
	store: SyncStore;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
}

export interface SequenceResult {
	skipped: 'busy' | 'not-due' | 'manual' | 'nothing-to-run' | null;
	ran: Array<{ id: string; ok: boolean; message: string }>;
}

// The stored flag alone cannot stop two triggers that arrive together (each
// reads it before either saves), so the worker also keeps this in memory.
let inFlight = false;

/**
 * Run the enabled jobs strictly in the given order. Scheduled triggers (alarm,
 * startup, idle) run only when a full interval has passed and the frequency is
 * not "manual"; 'now', 'older' and 'finish-now' run at once. A second trigger
 * while a run is going is ignored. Never throws.
 * recordRun false (Load older, web Finish now) leaves the schedule's clock alone.
 * wakeJob: when a push wake arrived during the run (PENDING_WAKE_KEY), it runs
 * once more at the end, so items the run itself parked are not left for the next hour.
 */
export async function runSequence(
	jobs: SyncJob[],
	deps: SequenceDeps,
	trigger: SequenceTrigger,
	opts: { recordRun?: boolean; wakeJob?: SyncJob } = {},
): Promise<SequenceResult> {
	const out: SequenceResult = { skipped: null, ran: [] };
	if (inFlight) { out.skipped = 'busy'; return out; }
	inFlight = true;
	try {
		const state = await loadSchedule(deps.store);
		const scheduled = trigger === 'alarm' || trigger === 'startup' || trigger === 'idle';
		const now = deps.now();
		if (isRunning(state, now)) { out.skipped = 'busy'; return out; }
		if (scheduled) {
			if (state.frequency === 'manual') { out.skipped = 'manual'; return out; }
			if (!isDue(state.frequency, state.lastRunAt, now)) { out.skipped = 'not-due'; return out; }
		}
		const active: SyncJob[] = [];
		for (const job of jobs) {
			try { if (await job.enabled()) active.push(job); } catch { /* treated as off */ }
		}
		if (active.length === 0) { out.skipped = 'nothing-to-run'; return out; }

		const record = opts.recordRun ?? true;
		state.running = true;
		state.lastAttemptAt = now;
		if (record) state.lastRunAt = now;
		state.step = { index: 1, total: active.length, name: active[0].name };
		await saveSchedule(deps.store, state);

		const lines: string[] = [];
		for (let i = 0; i < active.length; i++) {
			const job = active[i];
			if (i > 0) await deps.sleep(JOB_PAUSE_MS);
			state.step = { index: i + 1, total: active.length, name: job.name };
			state.lastAttemptAt = deps.now();
			await saveSchedule(deps.store, state);
			try {
				const message = await job.run();
				out.ran.push({ id: job.id, ok: true, message });
				lines.push(`${job.name}: ${message}`);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				out.ran.push({ id: job.id, ok: false, message });
				lines.push(`${job.name}: failed, ${message}`);
			}
		}
		if (opts.wakeJob && await takePendingWake(deps.store)) {
			if (active.length > 0) await deps.sleep(JOB_PAUSE_MS);
			try {
				const message = await opts.wakeJob.run();
				out.ran.push({ id: opts.wakeJob.id, ok: true, message });
				lines.push(`${opts.wakeJob.name}: ${message}`);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				out.ran.push({ id: opts.wakeJob.id, ok: false, message });
				lines.push(`${opts.wakeJob.name}: failed, ${message}`);
			}
		}
		state.running = false;
		state.step = null;
		state.lastFinishedAt = deps.now();
		state.lastSummary = lines.join('. ');
		await saveSchedule(deps.store, state);
		return out;
	} catch (e) {
		// Storage failed mid-run: release the stored flag best-effort.
		try {
			const s = await loadSchedule(deps.store);
			s.running = false; s.step = null;
			await saveSchedule(deps.store, s);
		} catch { /* nothing more to do */ }
		return out;
	} finally {
		inFlight = false;
	}
}

/** A push wake found the sequence busy: remember it for the end of the run. */
export const markPendingWake = (store: SyncStore) => store.set(PENDING_WAKE_KEY, true);

async function takePendingWake(store: SyncStore): Promise<boolean> {
	try {
		if (!(await store.get(PENDING_WAKE_KEY))) return false;
		await store.set(PENDING_WAKE_KEY, false);
		return true;
	} catch { return false; }
}

const ago = (ms: number): string => {
	const mins = Math.max(0, Math.round(ms / 60000));
	return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
};

/** A stored running flag counts only while fresh; a worker killed mid-run leaves a stale one. */
export const isRunning = (s: Pick<ScheduleState, 'running' | 'lastAttemptAt'>, now: number): boolean =>
	s.running && s.lastAttemptAt !== null && now - s.lastAttemptAt < STALE_RUN_MS;

/**
 * Pure: a message came from one of the clipper's own pages (settings, side
 * panel). Those pages run in a tab (options open_in_tab), so sender.tab is set
 * for them too; the page URL is what tells them apart from content scripts.
 */
export function isOwnPageSender(sender: any, runtimeId: string, extensionBaseUrl: string): boolean {
	if (!sender || sender.id !== runtimeId) return false;
	const url = typeof sender.url === 'string' ? sender.url : '';
	return extensionBaseUrl !== '' && url.startsWith(extensionBaseUrl);
}

/** Pure: the one status line for the schedule. */
export function describeScheduleStatus(s: ScheduleState, now: number): string {
	if (isRunning(s, now) && s.step) {
		return `${s.step.index} of ${s.step.total}: ${s.step.name}`;
	}
	if (s.lastFinishedAt === null) return 'No sync yet.';
	return `Last sync ${ago(now - s.lastFinishedAt)}${s.lastSummary ? `. ${s.lastSummary}` : ''}`;
}
