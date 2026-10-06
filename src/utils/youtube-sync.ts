// READ-38: bring the user's YouTube Watch later and/or one chosen playlist into
// LazyReader from inside their own signed-in browser. Read-only: nothing is
// ever added to or removed from a list. Runs as a job on the shared clipper
// schedule (READ-181), on Sync now, and on Load older.
//
// No YouTube cookie is stored, logged or sent to LazyReader. List pages are
// fetched with credentials 'include' (the browser attaches its own cookies).
// The paging call may add a SAPISIDHASH header, built in sapisid-hash.ts and
// passed in as deps.authHeader; it only ever goes to youtube.com.
//
// Shapes (no live probe; page 1 observed 2026-10-06, the rest follows the
// graveyard playlist loop and the web client):
//   GET https://www.youtube.com/playlist?list=WL
//     HTML with ytcfg.set({LOGGED_IN, INNERTUBE_API_KEY, INNERTUBE_CONTEXT_CLIENT_VERSION})
//     and ytInitialData holding playlistVideoRenderer rows and, when the list
//     goes on, a continuationItemRenderer token.
//   POST https://www.youtube.com/youtubei/v1/browse {context: WEB client, continuation}
//     -> rows and the next continuationItemRenderer, nested anywhere in the tree.
import {
	MAX_ATTEMPTS, jitter, loadState, saveState, sendWithRetry,
	type SyncDeps, type SyncPost, type SyncState, type YoutubeConfig, type YoutubeCursor,
} from './sync-core';

export const YT_PLAYLIST_URL = 'https://www.youtube.com/playlist';
export const YT_BROWSE_URL = 'https://www.youtube.com/youtubei/v1/browse';
export const FALLBACK_CLIENT_VERSION = '2.20261002.10.00';
export const FIRST_RUN_VIDEOS = 100;
export const MAX_PAGES_NEW = 5;
export const ALARM_RUN_VIDEOS = 20;
export const MANUAL_RUN_VIDEOS = 100;
export const MAX_CONSECUTIVE_FAILURES = 5;
// Shorts rule from the graveyard channel import: under 60 seconds.
export const SHORT_UNDER_SECONDS = 60;

export type YoutubeRunKind = 'alarm' | 'manual' | 'older';

export interface TranscriptRead {
	// null when nothing usable was read (the link is saved alone).
	text: string | null;
	// YouTube answered 429 or "not a bot": no more transcript attempts this run.
	blocked: boolean;
	// The answer was not definite (timeout, network error, 5xx, 403, empty caption body): no more
	// reads this run, and the finisher counts no attempt. Absent means a definite answer.
	transient?: boolean;
}

export interface YoutubeDeps extends SyncDeps {
	// Reads one video's transcript in the browser (youtube-transcript.ts). Omitted: links only.
	readTranscript?: (videoId: string) => Promise<TranscriptRead>;
	// "SAPISIDHASH ..." for the paging call, or null (no permission, signed out).
	authHeader?: () => Promise<string | null>;
}

export interface YoutubeRunResult {
	sent: number;
	failed: number;
	withTranscript: number;
	shortsSkipped: number;
	unavailable: number;
	transcriptsBlocked: boolean;
	note: string | null;
	stopped: 'signed-out' | 'rate-limited' | 'token' | 'failures' | 'error' | 'no-source' | null;
}

export interface YtVideo {
	id: string;
	title: string;
	channel: string;
	lengthSeconds: number | null;
	playable: boolean;
	short: boolean;
}

export interface YtCfg {
	loggedIn: boolean | null;
	apiKey: string | null;
	clientVersion: string | null;
}

export interface YtPage {
	rows: YtVideo[];
	continuation: string | null;
}

class StopRun extends Error {
	constructor(public reason: NonNullable<YoutubeRunResult['stopped']>, message: string) {
		super(message);
	}
}

const SIGNED_OUT = 'Sign in to YouTube in this browser';

// --- pure parsers -----------------------------------------------------------

/** Pasted playlist link or bare id to a playlist id. Watch later (WL) and Liked (LL) are not accepted here. */
export function extractPlaylistId(input: string): string | null {
	const raw = (input ?? '').trim();
	if (!raw) return null;
	let id = raw;
	if (/^[a-z]+:\/\//i.test(raw) || /^(www\.|m\.)?youtube\.com/i.test(raw)) {
		try {
			id = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).searchParams.get('list') ?? '';
		} catch {
			return null;
		}
	}
	if (!/^[A-Za-z0-9_-]{12,64}$/.test(id)) return null;
	return id;
}

/** Balanced-brace JSON object that starts at the first "{" at or after `from`, or null. */
function readJsonObject(s: string, from: number): any | null {
	const start = s.indexOf('{', from);
	if (start < 0) return null;
	let depth = 0;
	let inStr = false;
	for (let i = start; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			if (ch === '\\') i++;
			else if (ch === '"') inStr = false;
		} else if (ch === '"') inStr = true;
		else if (ch === '{') depth++;
		else if (ch === '}' && --depth === 0) {
			try {
				return JSON.parse(s.slice(start, i + 1));
			} catch {
				return null;
			}
		}
	}
	return null;
}

/** ytInitialData of a YouTube page, or null. */
export function extractInitialData(html: string): any | null {
	const m = /ytInitialData\s*=\s*/.exec(html) ?? /window\["ytInitialData"\]\s*=\s*/.exec(html);
	return m ? readJsonObject(html, m.index + m[0].length) : null;
}

export function parseYtcfg(html: string): YtCfg {
	const login = html.match(/"LOGGED_IN"\s*:\s*(true|false)/);
	const key = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
	const ver = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
	return { loggedIn: login ? login[1] === 'true' : null, apiKey: key ? key[1] : null, clientVersion: ver ? ver[1] : null };
}

/** Every object in the tree, parents before children, in document order. */
function* walk(node: any): Generator<any> {
	const stack: any[] = [node];
	while (stack.length) {
		const n = stack.pop();
		if (n === null || typeof n !== 'object') continue;
		yield n;
		if (Array.isArray(n)) for (let i = n.length - 1; i >= 0; i--) stack.push(n[i]);
		else {
			const vals = Object.values(n);
			for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
		}
	}
}

const textOf = (t: any): string =>
	typeof t === 'string' ? t : typeof t?.simpleText === 'string' ? t.simpleText : Array.isArray(t?.runs) ? t.runs.map((r: any) => r?.text ?? '').join('') : typeof t?.content === 'string' ? t.content : '';

function toSeconds(v: any): number | null {
	const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
	return Number.isFinite(n) ? n : null;
}

function isShort(nav: any, length: number | null): boolean {
	const url = String(nav?.commandMetadata?.webCommandMetadata?.url ?? '');
	if (url.includes('/shorts/') || nav?.reelWatchEndpoint) return true;
	// Backup: the graveyard rule. A row with no length (or a live 0) is kept.
	return length !== null && length > 0 && length < SHORT_UNDER_SECONDS;
}

/** Pure: the video rows and the next continuation token anywhere in a response tree. */
export function parseRows(data: any): YtPage {
	const rows: YtVideo[] = [];
	const seen = new Set<string>();
	let continuation: string | null = null;
	for (const n of walk(data)) {
		const r = n.playlistVideoRenderer;
		if (r && typeof r.videoId === 'string' && r.videoId && !seen.has(r.videoId)) {
			seen.add(r.videoId);
			const length = toSeconds(r.lengthSeconds);
			rows.push({
				id: r.videoId,
				title: textOf(r.title),
				channel: textOf(r.shortBylineText),
				lengthSeconds: length,
				playable: r.isPlayable !== false,
				short: isShort(r.navigationEndpoint, length),
			});
		}
		// Newer list rows: lockupViewModel with the video id as contentId.
		const lk = n.lockupViewModel;
		if (lk && typeof lk.contentId === 'string' && /^[\w-]{11}$/.test(lk.contentId) && (!lk.contentType || /VIDEO/.test(String(lk.contentType))) && !seen.has(lk.contentId)) {
			seen.add(lk.contentId);
			const url = String(lk.rendererContext?.commandContext?.onTap?.innertubeCommand?.commandMetadata?.webCommandMetadata?.url ?? '');
			rows.push({
				id: lk.contentId,
				title: textOf(lk.metadata?.lockupMetadataViewModel?.title),
				channel: '',
				lengthSeconds: null,
				playable: true,
				short: url.includes('/shorts/'),
			});
		}
		const c = n.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
		if (typeof c === 'string' && c) continuation = c;
	}
	return { rows, continuation };
}

/** Pure: one browse (continuation) response body. */
export const parseContinuation = (json: any): YtPage => parseRows(json);

export interface PlaylistPage extends YtPage {
	title: string;
	cfg: YtCfg;
	signedOut: boolean;
	// A page with no data that does not say LOGGED_IN false: YouTube blocked the check, which says nothing about sign-in.
	blocked: boolean;
}

/** Pure: the HTML of /playlist?list=... Signed out is LOGGED_IN false; no ytInitialData without LOGGED_IN false is blocked. */
export function parsePlaylistPage(html: string): PlaylistPage {
	const cfg = parseYtcfg(html);
	const data = extractInitialData(html);
	if (!data) return { rows: [], continuation: null, title: '', cfg, signedOut: cfg.loggedIn === false, blocked: cfg.loggedIn !== false };
	let title = '';
	for (const n of walk(data)) {
		const t = n.playlistMetadataRenderer?.title ?? n.playlistHeaderRenderer?.title;
		if (t) { title = textOf(t); break; }
	}
	return { ...parseRows(data), title, cfg, signedOut: cfg.loggedIn === false, blocked: false };
}

// --- config and state -------------------------------------------------------

const emptyCursor = (): YoutubeCursor => ({ older: null, exhausted: false, started: false });

export const emptyYoutubeConfig = (): YoutubeConfig => ({
	watchLater: false,
	playlistId: null,
	playlistTitle: '',
	includeShorts: false,
	cursors: { wl: emptyCursor(), pl: emptyCursor() },
	transcriptsBlockedAt: null,
	note: null,
});

/** The saved config merged over defaults, assigned back onto the state and returned. */
export function ytConfig(state: SyncState): YoutubeConfig {
	const saved: Partial<YoutubeConfig> = state.youtube && typeof state.youtube === 'object' ? state.youtube : {};
	const def = emptyYoutubeConfig();
	const cfg: YoutubeConfig = {
		...def,
		...saved,
		cursors: {
			wl: { ...def.cursors.wl, ...(saved.cursors?.wl ?? {}) },
			pl: { ...def.cursors.pl, ...(saved.cursors?.pl ?? {}) },
		},
	};
	state.youtube = cfg;
	return cfg;
}

export interface YoutubeConfigChange {
	watchLater?: boolean;
	includeShorts?: boolean;
	// A checked playlist id and its title, or null to clear the playlist.
	playlist?: { id: string; title: string } | null;
}

/** Pure: apply a settings change. A different playlist starts from its own first read. */
export function applyYoutubeConfig(state: SyncState, change: YoutubeConfigChange): YoutubeConfig {
	const cfg = ytConfig(state);
	if (typeof change.watchLater === 'boolean') cfg.watchLater = change.watchLater;
	if (typeof change.includeShorts === 'boolean') cfg.includeShorts = change.includeShorts;
	if (change.playlist !== undefined) {
		const next = change.playlist;
		if ((next?.id ?? null) !== cfg.playlistId) cfg.cursors.pl = emptyCursor();
		cfg.playlistId = next?.id ?? null;
		cfg.playlistTitle = next?.title ?? '';
	}
	return cfg;
}

/** Pure: has the user chosen anything to read? */
export const hasSource = (s: SyncState): boolean => !!s.youtube && (!!s.youtube.watchLater || !!s.youtube.playlistId);

/** Pure: Watch later has never been read (its cursor is empty), so ticking it costs a first run. */
export const watchLaterNeverRan = (s: SyncState): boolean => !s.youtube?.cursors?.wl?.started;

/** The warning shown before the first run. */
export function costWarning(count: number): string {
	return `The first run saves up to ${count} videos, then up to ${ALARM_RUN_VIDEOS} per scheduled run until the rest of the list is in. Each one gets a summary from your OpenRouter key, and transcripts are long, so each costs more than an article.`;
}

// --- network ----------------------------------------------------------------

function checkStatus(status: number): void {
	if (status === 401 || status === 403) throw new StopRun('signed-out', SIGNED_OUT);
	if (status === 429) throw new StopRun('rate-limited', 'YouTube asked us to slow down. Next run retries.');
}

async function fetchFirstPage(deps: SyncDeps, listId: string): Promise<PlaylistPage> {
	const res = await deps.fetchFn(`${YT_PLAYLIST_URL}?list=${encodeURIComponent(listId)}`, {
		credentials: 'include',
		headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
	});
	checkStatus(res.status);
	if (!res.ok) throw new StopRun('error', `YouTube answered ${res.status}`);
	const page = parsePlaylistPage(await res.text());
	if (page.signedOut) throw new StopRun('signed-out', SIGNED_OUT);
	if (page.blocked) throw new StopRun('error', 'YouTube blocked this check, try later.');
	return page;
}

// 'refused' is a definite no (a 4xx on the token); 'error' is not (5xx, bad body).
type ContinuationFailure = 'refused' | 'error';

// A restarted Load older walk stops here; the cursor is kept so the next tap continues.
export const RESTART_MAX_PAGES = 30;

/** One continuation page, or why there is none (the caller keeps what it has). */
async function fetchContinuation(deps: YoutubeDeps, cfg: YtCfg, token: string): Promise<YtPage | ContinuationFailure> {
	const auth = deps.authHeader ? await deps.authHeader().catch(() => null) : null;
	const url = `${YT_BROWSE_URL}?${cfg.apiKey ? `key=${encodeURIComponent(cfg.apiKey)}&` : ''}prettyPrint=false`;
	const res = await deps.fetchFn(url, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			'X-Origin': 'https://www.youtube.com',
			'X-Goog-AuthUser': '0',
			...(auth ? { Authorization: auth } : {}),
		},
		body: JSON.stringify({
			context: { client: { clientName: 'WEB', clientVersion: cfg.clientVersion ?? FALLBACK_CLIENT_VERSION, hl: 'en' } },
			continuation: token,
		}),
	});
	if (res.status === 429) throw new StopRun('rate-limited', 'YouTube asked us to slow down. Next run retries.');
	if (!res.ok) return res.status >= 500 ? 'error' : 'refused';
	try {
		return parseContinuation(await res.json());
	} catch {
		return 'error';
	}
}

/** Check a pasted playlist: its title, or why it cannot be read. Never throws. */
export async function checkPlaylist(deps: SyncDeps, input: string): Promise<{ ok: boolean; id: string | null; title: string; message: string }> {
	const id = extractPlaylistId(input);
	if (!id) return { ok: false, id: null, title: '', message: 'That does not look like a playlist link. Paste the link that has list=... in it.' };
	try {
		const page = await fetchFirstPage(deps, id);
		if (!page.title) return { ok: false, id, title: '', message: 'YouTube did not show a playlist for that link.' };
		return { ok: true, id, title: page.title, message: page.title };
	} catch (e) {
		const msg = e instanceof StopRun && e.reason === 'signed-out' ? SIGNED_OUT : e instanceof Error ? e.message : String(e);
		return { ok: false, id, title: '', message: msg };
	}
}

// --- run --------------------------------------------------------------------

const toPost = (id: string): SyncPost => ({
	id: `yt:${id}`,
	url: `https://www.youtube.com/watch?v=${id}`,
	// Title and channel stay empty: the server fills them from oEmbed (plan choice 5).
	title: '',
	siteName: '',
});

const videoIdOf = (post: SyncPost) => post.id.replace(/^yt:/, '');

function remember(state: SyncState, id: string): void {
	if (!state.knownIds.includes(id)) state.knownIds.push(id);
	state.pending = state.pending.filter((p) => p.id !== id);
}

type Mode = 'first' | 'new' | 'older';

/** One status line for the settings page. */
export function resultLine(r: YoutubeRunResult): string {
	const parts = [`${r.sent} saved`];
	if (r.withTranscript) parts.push(`${r.withTranscript} with transcript`);
	if (r.failed) parts.push(`${r.failed} could not be saved`);
	if (r.shortsSkipped) parts.push(`${r.shortsSkipped} ${r.shortsSkipped === 1 ? 'Short' : 'Shorts'} skipped`);
	if (r.unavailable) parts.push(`${r.unavailable} private or deleted`);
	if (r.transcriptsBlocked) parts.push('YouTube slowed transcripts down, so the rest went as links');
	if (r.note) parts.push(r.note);
	return parts.join(', ');
}

/** One sync run. Never throws; the outcome goes to state and the result. */
export async function runYoutubeSync(deps: YoutubeDeps, kind: YoutubeRunKind): Promise<YoutubeRunResult> {
	const result: YoutubeRunResult = { sent: 0, failed: 0, withTranscript: 0, shortsSkipped: 0, unavailable: 0, transcriptsBlocked: false, note: null, stopped: null };
	const state = await loadState(deps.store, 'youtube');
	if (!state.enabled) return result;
	if (state.running && deps.now() - (state.lastAttemptAt ?? 0) < 15 * 60 * 1000) return result;
	const cfg = ytConfig(state);
	state.running = true;
	state.lastAttemptAt = deps.now();
	cfg.transcriptsBlockedAt = null;
	await saveState(deps.store, 'youtube', state);

	const sources: Array<{ key: 'wl' | 'pl'; id: string }> = [];
	if (cfg.watchLater) sources.push({ key: 'wl', id: 'WL' });
	if (cfg.playlistId) sources.push({ key: 'pl', id: cfg.playlistId });

	const known = new Set([
		...state.knownIds,
		...state.pending.map((p) => p.id),
		...Object.keys(state.failed).filter((k) => state.failed[k] >= MAX_ATTEMPTS),
	]);
	const shortsSeen = new Set<string>();
	const notes: string[] = [];

	// Rows from one page into the pending queue. Returns how many were new.
	const take = (rows: YtVideo[]): number => {
		let added = 0;
		for (const r of rows) {
			const id = `yt:${r.id}`;
			if (!r.playable) {
				// Deleted or private: never retried.
				if (!known.has(id)) { state.knownIds.push(id); known.add(id); result.unavailable++; }
				continue;
			}
			if (known.has(id)) continue;
			if (r.short && !cfg.includeShorts) {
				// Not remembered, so turning "Include Shorts" on later picks it up.
				if (!shortsSeen.has(id)) { shortsSeen.add(id); result.shortsSkipped++; }
				continue;
			}
			state.pending.push(toPost(r.id));
			known.add(id);
			added++;
		}
		return added;
	};

	const readSource = async (src: { key: 'wl' | 'pl'; id: string }) => {
		const cursor = cfg.cursors[src.key];
		const mode: Mode = kind === 'older' ? 'older' : cursor.started ? 'new' : 'first';
		if (mode === 'older' && (cursor.exhausted || !cursor.started)) return;
		const page = await fetchFirstPage(deps, src.id);
		if (src.key === 'pl' && page.title) cfg.playlistTitle = page.title;
		let token: string | null;
		let pages = 1;
		let seen = 0;
		let added = 0;
		if (mode === 'older') {
			token = cursor.older;
			pages = 0;
		} else {
			seen += page.rows.length;
			take(page.rows);
			token = page.continuation;
			if (mode === 'first') { cursor.started = true; cursor.older = token; cursor.exhausted = !token; }
		}
		let maxPages = mode === 'older' ? MAX_PAGES_NEW : mode === 'new' ? MAX_PAGES_NEW : Infinity;
		let restarted = false;
		while (token && pages < maxPages && (mode === 'new' || (mode === 'first' ? seen < FIRST_RUN_VIDEOS : added < FIRST_RUN_VIDEOS))) {
			await deps.sleep(jitter(deps, 2000, 4000));
			const next = await fetchContinuation(deps, page.cfg, token);
			if (next === 'refused' && mode === 'older' && pages === 0 && !restarted) {
				// The stored token was refused: walk again from page 1. Known ids are skipped by take(),
				// and the page cap is raised so the walk can get past them to the first unread video.
				restarted = true;
				maxPages = RESTART_MAX_PAGES;
				token = page.continuation;
				cursor.older = token;
				cursor.exhausted = !token;
				seen += page.rows.length;
				added += take(page.rows);
				continue;
			}
			if (typeof next === 'string') {
				notes.push(mode === 'older'
					? next === 'error'
						? 'YouTube had a problem on the next page, so Load older stopped there. Tap it again to retry'
						: 'YouTube refused the next page, so Load older stopped there'
					: `YouTube refused the next page, so only the first ${seen} videos of ${src.key === 'wl' ? 'Watch later' : 'the playlist'} were read`);
				return;
			}
			pages++;
			seen += next.rows.length;
			const n = take(next.rows);
			if (mode === 'older') added += n;
			token = next.continuation;
			if (mode !== 'new') { cursor.older = token; cursor.exhausted = !token; }
			// A page that brings nothing and no token ends the list.
			if (!next.rows.length) break;
		}
		if (restarted && token && pages >= maxPages && added < FIRST_RUN_VIDEOS) {
			notes.push(`Load older went through ${RESTART_MAX_PAGES} pages of videos already saved, so tap it again to continue`);
		}
		if (mode === 'older' && !token) { cursor.older = null; cursor.exhausted = true; }
	};

	const limit = kind === 'alarm' ? ALARM_RUN_VIDEOS : MANUAL_RUN_VIDEOS;
	let consecutive = 0;
	let transcriptsOff = false;
	try {
		if (sources.length === 0) throw new StopRun('no-source', 'Choose Watch later or a playlist first.');
		for (let i = 0; i < sources.length; i++) {
			if (i > 0) await deps.sleep(jitter(deps, 2000, 4000));
			await readSource(sources[i]);
			await saveState(deps.store, 'youtube', state);
		}

		const batch = state.pending.filter((p) => (state.failed[p.id] ?? 0) < MAX_ATTEMPTS).slice(0, limit);
		let first = true;
		for (const post of batch) {
			if (!first) await deps.sleep(jitter(deps, 2000, 4000));
			first = false;
			let text: string | undefined;
			if (deps.readTranscript && !transcriptsOff) {
				try {
					const t = await deps.readTranscript(videoIdOf(post));
					if (t.text) text = t.text;
					if (t.blocked) {
						transcriptsOff = true;
						result.transcriptsBlocked = true;
						cfg.transcriptsBlockedAt = deps.now();
					}
				} catch {
					// A transcript failure never blocks the save.
				}
			}
			const sent = await sendWithRetry(deps, post, text);
			if (sent.status === 401) throw new StopRun('token', 'Lazy Reader did not accept the token. Copy it again from Lazy Reader, Settings.');
			if (sent.status === 429 || (sent.status ?? 0) >= 500 || (!sent.ok && sent.status === undefined)) {
				throw new StopRun('error', sent.error || 'Lazy Reader could not be reached. Next run retries.');
			}
			if (!sent.ok) {
				state.failed[post.id] = (state.failed[post.id] ?? 0) + 1;
				result.failed++;
				consecutive++;
				if (consecutive >= MAX_CONSECUTIVE_FAILURES) throw new StopRun('failures', 'Five videos in a row could not be saved. Next run retries.');
			} else {
				consecutive = 0;
				result.sent++;
				if (text) result.withTranscript++;
				remember(state, post.id);
				delete state.failed[post.id];
			}
			await saveState(deps.store, 'youtube', state);
		}
		state.lastSuccess = deps.now();
		state.lastError = null;
		state.signedOut = false;
	} catch (e) {
		const stop = e instanceof StopRun ? e : new StopRun('error', e instanceof Error ? e.message : String(e));
		result.stopped = stop.reason;
		if (stop.reason === 'signed-out') {
			state.signedOut = true;
			state.lastError = null;
		} else {
			state.lastError = stop.message;
		}
	}
	result.note = notes.length ? notes.join('. ') : null;
	cfg.note = result.note;
	state.running = false;
	state.lastRunAt = deps.now();
	state.lastResult = resultLine(result);
	await saveState(deps.store, 'youtube', state);
	return result;
}
