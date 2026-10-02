import type { SyncDeps, SyncStore, SendResult } from './sync-core';

export function memoryStore(initial: Record<string, any> = {}): SyncStore & { data: Record<string, any> } {
	const data: Record<string, any> = structuredClone(initial);
	return {
		data,
		async get(k) { return data[k] === undefined ? undefined : structuredClone(data[k]); },
		async set(k, v) { data[k] = structuredClone(v); },
	};
}

export type Route = (url: string, init?: RequestInit) => { status?: number; json?: any; text?: string } | undefined;

export function fakeFetch(route: Route): typeof fetch & { calls: string[] } {
	const calls: string[] = [];
	const fn = (async (input: any, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		const r = route(url, init) ?? { status: 404 };
		const status = r.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => { if (r.json === undefined) throw new Error('not json'); return r.json; },
			text: async () => r.text ?? JSON.stringify(r.json ?? ''),
		} as Response;
	}) as any;
	fn.calls = calls;
	return fn;
}

export function makeDeps(over: Partial<SyncDeps> & { route: Route; sends?: SendResult[] }) {
	const store = (over.store as any) ?? memoryStore();
	const sent: Array<{ id: string; url: string; text?: string }> = [];
	const sleeps: number[] = [];
	let t = 1_000_000;
	const fetchFn = fakeFetch(over.route);
	const queue = [...(over.sends ?? [])];
	const deps: SyncDeps = {
		store,
		fetchFn,
		sleep: async (ms) => { sleeps.push(ms); t += ms; },
		now: () => (t += 1000),
		random: () => 0,
		send: async (post, text) => {
			sent.push({ id: post.id, url: post.url, text });
			return queue.shift() ?? { ok: true, status: 200 };
		},
		...(over as any),
	};
	deps.fetchFn = fetchFn;
	return { deps, store, sent, sleeps, fetchFn };
}
