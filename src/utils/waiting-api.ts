// READ-181: the two LazyReader calls the finisher makes. Kept in one small
// file so the shapes are easy to adjust (the server side is built in parallel).
//   POST {base}/listWaiting  x-reader-token, { codes: ['needs_text', 'needs_transcript', 'needs_feed'] } -> { items: [{ id, url, title, created_at, code }] }
//        code is 'needs_text' (an article) 'needs_transcript' (a YouTube video, READ-38) or
//        'needs_feed' (READ-414, a followed site's feed the server cannot open);
//        a server that predates it sends no code, read as 'needs_text'.
//   POST {base}/provideText  x-reader-token, { item_id, text, title?, publisher? } | { item_id, outcome: 'unreadable' }
//        title (READ-249) is sent only when the clipper read a real one from the page; the
//        server keeps an existing real title and uses this one only when the item has none.
//        READ-357: YouTube transcripts send the video's title and, as publisher, the channel;
//        the server uses them only when the stored title is empty or a link.
//        -> { ok: true, outcome?: 'members_only' }
//   POST {base}/provideFeedText  x-reader-token, { feed_id, text }   (READ-414)
//        the raw feed (or the page that links it) of a site that turns the server away; code 'needs_feed'
//        rows are listed only because the request asks for that code.
//        -> { feed, added } | { needs_device: "<url>" } (read this link next) | { feed, already: true }
// {base} comes from the capture URL setting: ".../api/capture" -> ".../api".

export type WaitingCode = 'needs_text' | 'needs_transcript' | 'needs_feed';

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
	// READ-414: provideFeedText answered with a link to read next.
	needsDevice?: string;
}

export interface WaitingApi {
	list(): Promise<ListResult>;
	provideText(itemId: string, text: string, title?: string, publisher?: string): Promise<ProvideResult>;
	markUnreadable(itemId: string): Promise<ProvideResult>;
	provideFeedText(feedId: string, text: string): Promise<ProvideResult>;
}

/** Endpoint URL for a function name, derived from the capture URL, or null. */
export function endpointUrl(captureUrl: string, name: 'listWaiting' | 'provideText' | 'provideFeedText' | 'registerClipper' | 'getMyRole' | 'shareTypes' | 'clipperAddToList' | 'clipperUndoAdd'): string | null {
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
			code: it.code === 'needs_transcript' || it.code === 'needs_feed' ? it.code : 'needs_text',
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
	const provideFeedUrl = endpointUrl(captureUrl, 'provideFeedText');
	const bad = { ok: false, status: 401, error: 'Missing capture URL or token' };
	const missing = !token || !listUrl || !provideUrl || !provideFeedUrl;
	return {
		async list() {
			if (missing) return { ...bad, items: [] };
			const r = await post(fetchFn, listUrl!, token, { codes: ['needs_text', 'needs_transcript', 'needs_feed'] });
			return { ok: r.ok, status: r.status, items: r.ok ? parseWaitingItems(r.json) : [], error: r.error };
		},
		async provideText(itemId, text, title, publisher) {
			if (missing) return bad;
			const t = (title ?? '').trim();
			const p = (publisher ?? '').trim();
			const r = await post(fetchFn, provideUrl!, token, { item_id: itemId, text, ...(t ? { title: t } : {}), ...(p ? { publisher: p } : {}) });
			return { ok: r.ok, status: r.status, outcome: r.json?.outcome, error: r.error };
		},
		async markUnreadable(itemId) {
			if (missing) return bad;
			const r = await post(fetchFn, provideUrl!, token, { item_id: itemId, outcome: 'unreadable' });
			return { ok: r.ok, status: r.status, outcome: r.json?.outcome, error: r.error };
		},
		async provideFeedText(feedId, text) {
			if (missing) return bad;
			const r = await post(fetchFn, provideFeedUrl!, token, { feed_id: feedId, text });
			const next = r.ok && typeof r.json?.needs_device === 'string' && r.json.needs_device ? r.json.needs_device : undefined;
			// READ-414: a 200 that carries `error` means the posts did not save; not a read.
			const saveError = r.ok && typeof r.json?.error === 'string' && r.json.error ? r.json.error : undefined;
			return { ok: r.ok && !saveError, status: r.status, needsDevice: next, error: r.error ?? saveError };
		},
	};
}
