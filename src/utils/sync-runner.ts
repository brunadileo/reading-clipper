// Browser wiring for the Substack and Instagram syncs (READ-37, READ-39).
// Runs in the background worker only. The rules live in substack-sync.ts and
// instagram-sync.ts; this file connects them to chrome.storage.local,
// chrome.alarms and the existing LazyReader capture call.
import browser from './browser-polyfill';
import { buildReadingCaptureBody, postCapture } from './reading-sender';
import { DEFAULT_READING_LANE, loadReadingSettings } from './storage-utils';
import { loadState, saveState, type SyncDeps, type SyncService } from './sync-core';
import { runSubstackSync } from './substack-sync';
import { runInstagramSync } from './instagram-sync';

export const SUBSTACK_ALARM = 'substack-sync';
export const SUBSTACK_PERIOD_MINUTES = 30;

const store = {
	async get(key: string) {
		const r = await browser.storage.local.get(key);
		return r[key];
	},
	async set(key: string, value: any) {
		await browser.storage.local.set({ [key]: value });
	},
};

function makeDeps(service: SyncService): SyncDeps {
	return {
		store,
		fetchFn: (input, init) => fetch(input, init),
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		now: () => Date.now(),
		send: async (post, text) => {
			const settings = await loadReadingSettings();
			const body = buildReadingCaptureBody({
				url: post.url,
				lane: DEFAULT_READING_LANE,
				title: post.title,
				siteName: post.siteName,
				text: text ?? '',
				source: service,
			});
			return postCapture(body, settings.captureUrl, settings.token);
		},
	};
}

const alarms = () => (typeof chrome !== 'undefined' ? (chrome as any).alarms : undefined);

/** Create or clear the 30-minute Substack alarm to match the switch. */
export async function applySubstackAlarm(): Promise<void> {
	const api = alarms();
	if (!api) return;
	const state = await loadState(store, 'substack');
	if (state.enabled) {
		const existing = await api.get(SUBSTACK_ALARM);
		if (!existing) api.create(SUBSTACK_ALARM, { periodInMinutes: SUBSTACK_PERIOD_MINUTES });
	} else {
		await api.clear(SUBSTACK_ALARM);
	}
}

export function initSyncRunner(): void {
	const api = alarms();
	if (api) {
		api.onAlarm.addListener((alarm: { name: string }) => {
			if (alarm.name === SUBSTACK_ALARM) void runSubstackSync(makeDeps('substack'), 'alarm');
		});
	}
	browser.runtime.onStartup?.addListener(() => {
		void applySubstackAlarm().then(() => runSubstackSync(makeDeps('substack'), 'alarm'));
	});
	browser.runtime.onInstalled.addListener(() => {
		void applySubstackAlarm();
	});

	browser.runtime.onMessage.addListener((request: unknown, _sender: unknown, sendResponse: (r?: any) => void): true | undefined => {
		const req = request as { action?: string; service?: SyncService; enabled?: boolean; kind?: 'manual' | 'older' };
		if (!req || typeof req !== 'object') return undefined;

		if (req.action === 'syncSetEnabled' && (req.service === 'substack' || req.service === 'instagram')) {
			const service = req.service;
			void (async () => {
				const state = await loadState(store, service);
				state.enabled = !!req.enabled;
				await saveState(store, service, state);
				if (service === 'substack') {
					await applySubstackAlarm();
					if (state.enabled) void runSubstackSync(makeDeps('substack'), 'manual');
				}
				sendResponse({ ok: true });
			})();
			return true;
		}

		if (req.action === 'syncRun' && (req.service === 'substack' || req.service === 'instagram')) {
			const older = req.kind === 'older';
			const run = req.service === 'substack'
				? runSubstackSync(makeDeps('substack'), older ? 'older' : 'manual')
				: runInstagramSync(makeDeps('instagram'), older ? 'older' : 'sync');
			run.then((result) => sendResponse({ ok: true, result })).catch((e) => sendResponse({ ok: false, error: String(e) }));
			return true;
		}
		return undefined;
	});
}
