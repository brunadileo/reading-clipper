// Shared pieces of the Substack, Instagram and Medium syncs (READ-37, READ-39, READ-36).
// Pure TypeScript with injected storage, fetch and timers, so the rules are
// unit-testable. No browser API is imported here.

export type SyncService = 'substack' | 'instagram' | 'youtube' | 'medium';

export interface SyncStore {
	get(key: string): Promise<any>;
	set(key: string, value: any): Promise<void>;
}

export interface SyncState {
	enabled: boolean;
	// Where "Load older" continues (Substack nextCursor, Instagram next_max_id).
	olderCursor: string | null;
	olderExhausted: boolean;
	// Ids of posts already sent to LazyReader.
	knownIds: string[];
	// Discovered but not yet sent (survives a stopped run).
	pending: SyncPost[];
	// id -> failed attempts. At 3 the post is given up on.
	failed: Record<string, number>;
	lastSuccess: number | null;
	lastRunAt: number | null;
	lastAttemptAt: number | null;
	// Instagram only (READ-181): the last attempt came from the shared schedule,
	// whose one-hour floor then stands in for Instagram's own gate.
	lastAttemptScheduled?: boolean;
	// YouTube only (READ-38): which lists to read and where "Load older" continues.
	youtube?: YoutubeConfig;
	// Medium only (READ-36): per own list, how many items Load older has seen and
	// whether the whole list is in. Medium has no single cursor.
	lists?: Record<string, { seen: number; exhausted: boolean; stalls?: number }>;
	// 'signed-out' is a state, not an error: the settings page words it softly.
	lastError: string | null;
	signedOut: boolean;
	lastResult: string | null;
	running: boolean;
}

export interface YoutubeCursor {
	// Continuation token for the next unread page of this list.
	older: string | null;
	exhausted: boolean;
	// The list has had its first read (a list added later gets its own first run).
	started: boolean;
}

export interface YoutubeConfig {
	watchLater: boolean;
	// Playlist id (PL...), null when none is chosen.
	playlistId: string | null;
	playlistTitle: string;
	includeShorts: boolean;
	cursors: { wl: YoutubeCursor; pl: YoutubeCursor };
	// Set when YouTube refused transcripts in the last run (links only after that).
	transcriptsBlockedAt: number | null;
	// A plain note for the status line, e.g. "only the first 100 were read".
	note: string | null;
}

export interface SyncPost {
	id: string;
	url: string;
	title: string;
	siteName: string;
}

export const MAX_ATTEMPTS = 3;
export const MAX_KNOWN_IDS = 5000;

export const emptyState = (): SyncState => ({
	enabled: false,
	olderCursor: null,
	olderExhausted: false,
	knownIds: [],
	pending: [],
	failed: {},
	lastSuccess: null,
	lastRunAt: null,
	lastAttemptAt: null,
	lastError: null,
	signedOut: false,
	lastResult: null,
	running: false,
});

export const stateKey = (service: SyncService) => `sync:${service}`;

export async function loadState(store: SyncStore, service: SyncService): Promise<SyncState> {
	const saved = await store.get(stateKey(service));
	return { ...emptyState(), ...(saved && typeof saved === 'object' ? saved : {}) };
}

export async function saveState(store: SyncStore, service: SyncService, state: SyncState): Promise<void> {
	if (state.knownIds.length > MAX_KNOWN_IDS) state.knownIds = state.knownIds.slice(-MAX_KNOWN_IDS);
	await store.set(stateKey(service), state);
}

export interface SendResult {
	ok: boolean;
	status?: number;
	error?: string;
}

export type SendFn = (post: SyncPost, text: string | undefined) => Promise<SendResult>;

/** Waits before the 1st and 2nd retry of a send that got a gateway or network error. */
export const SEND_RETRY_DELAYS_MS = [3000, 10000];

/** A transient failure worth retrying: no answer at all, or a 5xx (520 to 524 are gateway pages). */
export const isTransientSend = (r: SendResult) => !r.ok && (r.status === undefined || (r.status >= 500 && r.status <= 599));

/**
 * deps.send, retried twice (3 s, then 10 s) on a network error or a 5xx. Safe
 * because capture dedupes by URL. Any other answer, 401 and 4xx included, comes
 * back at once for the caller's own rules.
 */
export async function sendWithRetry(deps: SyncDeps, post: SyncPost, text: string | undefined): Promise<SendResult> {
	let res = await deps.send(post, text);
	for (const wait of SEND_RETRY_DELAYS_MS) {
		if (!isTransientSend(res)) return res;
		await deps.sleep(wait);
		res = await deps.send(post, text);
	}
	return res;
}

export interface SyncDeps {
	store: SyncStore;
	fetchFn: typeof fetch;
	send: SendFn;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	random?: () => number;
}

export const countWords = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

const ENTITIES: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '...', mdash: '-', ndash: '-',
	rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
};

function decodeEntities(s: string): string {
	return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === '#') {
			const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

/**
 * Plain text with paragraph breaks from a post's HTML. The service worker has
 * no DOM, so this is a small tag stripper, not defuddle (assumed good enough
 * for Substack's body_html; the live probe confirms).
 */
export function htmlToText(html: string): string {
	let s = html
		.replace(/<(script|style|figure|svg|iframe)[\s\S]*?<\/\1>/gi, '')
		.replace(/<(ul|ol)[^>]*>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Math.min(Number(n), 6))} `)
		.replace(/<li[^>]*>/gi, '- ')
		.replace(/<\/li>/gi, '\n')
		.replace(/<\/(p|div|h[1-6]|ul|ol|blockquote|tr)>/gi, '\n\n')
		.replace(/<[^>]+>/g, '');
	s = decodeEntities(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
	return s.trim();
}

/** True when a page body is a sign-in wall instead of the post. */
export function looksLikeLoginPage(text: string): boolean {
	const head = text.slice(0, 600).toLowerCase();
	return /(sign in|log in|login) to (continue|read|substack|instagram)|create (an )?account to continue/.test(head);
}

export const jitter = (deps: SyncDeps, min: number, max: number) =>
	min + Math.floor((deps.random ? deps.random() : Math.random()) * (max - min + 1));
