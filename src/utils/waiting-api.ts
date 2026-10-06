// READ-181: the two LazyReader calls the finisher makes. Kept in one small
// file so the shapes are easy to adjust (the server side is built in parallel).
//   POST {base}/listWaiting  x-reader-token -> { items: [{ id, url, title, created_at, code }] }
//        code is 'needs_text' (an article) or 'needs_transcript' (a YouTube video, READ-38);
//        a server that predates it sends no code, read as 'needs_text'.
//   POST {base}/provideText  x-reader-token, { item_id, text } | { item_id, outcome: 'unreadable' }
//        -> { ok: true, outcome?: 'members_only' }
// {base} comes from the capture URL setting: ".../api/capture" -> ".../api".

export type WaitingCode = 'needs_text' | 'needs_transcript';

export interface WaitingItem {
	id: string;
	url: string;
	title: string;
	created_at?: string;
	code: WaitingCode;
}

export interface ListResult {
	ok: boolean;
	status?: number;
	items: WaitingItem[];
	error?: string;
}

export interface ProvideResult {
	ok: boolean;
	status?: number;
	outcome?: 'members_only' | string;
	error?: string;
}

export interface WaitingApi {
	list(): Promise<ListResult>;
	provideText(itemId: string, text: string): Promise<ProvideResult>;
	markUnreadable(itemId: string): Promise<ProvideResult>;
}

/** Endpoint URL for a function name, derived from the capture URL, or null. */
export function endpointUrl(captureUrl: string, name: 'listWaiting' | 'provideText'): string | null {
	try {
		const u = new URL(captureUrl);
		if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
		const path = u.pathname.replace(/\/+$/, '');
		u.search = '';
		u.hash = '';
		u.pathname = /\/capture$/.test(path) ? path.replace(/\/capture$/, `/${name}`) : `/api/${name}`;
		return u.toString();
	} catch {
		return null;
	}
}

/** Pure: a listWaiting body to items. Entries without id and url are dropped. */
export function parseWaitingItems(json: any): WaitingItem[] {
	const items = Array.isArray(json?.items) ? json.items : [];
	const out: WaitingItem[] = [];
	for (const it of items) {
		if (!it || typeof it.id !== 'string' || typeof it.url !== 'string' || !it.id || !it.url) continue;
		out.push({
			id: it.id,
			url: it.url,
			title: typeof it.title === 'string' ? it.title : '',
			created_at: typeof it.created_at === 'string' ? it.created_at : undefined,
			code: it.code === 'needs_transcript' ? 'needs_transcript' : 'needs_text',
		});
	}
	return out;
}

async function post(fetchFn: typeof fetch, url: string, token: string, body: unknown): Promise<{ ok: boolean; status?: number; json?: any; error?: string }> {
	try {
		const res = await fetchFn(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-reader-token': token },
			body: JSON.stringify(body),
		});
		let json: any;
		try { json = await res.json(); } catch { /* empty or non-JSON body */ }
		return { ok: res.ok, status: res.status, json, error: res.ok ? undefined : json?.error || `Request failed with status ${res.status}` };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/** Never logs the token. */
export function createWaitingApi(captureUrl: string, token: string, fetchFn: typeof fetch = fetch): WaitingApi {
	const listUrl = endpointUrl(captureUrl, 'listWaiting');
	const provideUrl = endpointUrl(captureUrl, 'provideText');
	const bad = { ok: false, status: 401, error: 'Missing capture URL or token' };
	const missing = !token || !listUrl || !provideUrl;
	return {
		async list() {
			if (missing) return { ...bad, items: [] };
			const r = await post(fetchFn, listUrl!, token, {});
			return { ok: r.ok, status: r.status, items: r.ok ? parseWaitingItems(r.json) : [], error: r.error };
		},
		async provideText(itemId, text) {
			if (missing) return bad;
			const r = await post(fetchFn, provideUrl!, token, { item_id: itemId, text });
			return { ok: r.ok, status: r.status, outcome: r.json?.outcome, error: r.error };
		},
		async markUnreadable(itemId) {
			if (missing) return bad;
			const r = await post(fetchFn, provideUrl!, token, { item_id: itemId, outcome: 'unreadable' });
			return { ok: r.ok, status: r.status, outcome: r.json?.outcome, error: r.error };
		},
	};
}
