// READ-39: bring the user's Instagram Saved posts into LazyReader from inside
// their own signed-in browser. Runs on the shared clipper schedule (READ-181
// choice 26), on Sync now, and on Load older. The login
// cookie stays in the browser; only post links go to LazyReader.
//
// ASSUMED SHAPES (from reading-wiki/scripts/instagram_saved_list.py, not yet
// probed live; see the live-probe list in the plan Run log):
//   GET https://www.instagram.com/api/v1/feed/saved/posts/?max_id=<c>
//     headers X-IG-App-ID, X-CSRFToken, X-Requested-With
//     -> { items: [{ media: { code, caption: { text }, user: { username } } }],
//          next_max_id, more_available }
//   GET https://www.instagram.com/accounts/edit/ (HTML) contains
//     "username":"<name>" and "csrf_token":"<token>" when signed in.
import { loadState, saveState, type SyncDeps, type SyncPost } from './sync-core';

export const IG_LIST_URL = 'https://www.instagram.com/api/v1/feed/saved/posts/';
export const IG_ACCOUNT_URL = 'https://www.instagram.com/accounts/edit/';
export const IG_APP_ID = '936619743392459';
export const IG_FIRST_RUN_POSTS = 100;
export const IG_PAGE_DELAY_MS = 3000;
export const IG_SEND_GAP_MS = 1000;
export const IG_STOP_AFTER_KNOWN = 3;
export const IG_MIN_INTERVAL_MS = 60 * 60 * 1000;
export const IG_CREDIT_WARNING_OVER = 20;

// 'scheduled': a run from the shared clipper schedule, whose own floor is one
// hour between runs, so Instagram's per-service gate is not applied twice.
export type InstagramRunKind = 'sync' | 'older' | 'scheduled';

export interface InstagramRunResult {
	sent: number;
	username: string | null;
	stopped: 'signed-out' | 'rate-limited' | 'too-soon' | 'token' | 'error' | null;
	message: string | null;
}

export interface IgListPage {
	posts: SyncPost[];
	nextMaxId: string | null;
}

/** Pure: one saved-posts response to posts (permalink built from the shortcode). */
export function parseSavedPosts(json: any): IgListPage {
	const items = Array.isArray(json?.items) ? json.items : [];
	const posts: SyncPost[] = [];
	for (const it of items) {
		const media = it?.media ?? it;
		const code = media?.code;
		if (typeof code !== 'string' || !/^[A-Za-z0-9_-]+$/.test(code)) continue;
		const caption = String(media?.caption?.text ?? '').trim().split('\n')[0].slice(0, 120);
		const user = String(media?.user?.username ?? '');
		posts.push({
			id: code,
			url: `https://www.instagram.com/p/${code}/`,
			title: caption || (user ? `Instagram post by @${user}` : 'Instagram post'),
			siteName: 'Instagram',
		});
	}
	const next = json?.next_max_id;
	const more = json?.more_available !== false;
	return { posts, nextMaxId: more && next !== undefined && next !== null && next !== '' ? String(next) : null };
}

/** Pure: signed-in username and csrf token from the accounts/edit HTML. */
export function parseAccountPage(html: string): { username: string | null; csrf: string | null } {
	const u = html.match(/"username":"([A-Za-z0-9._]+)"/);
	const c = html.match(/"csrf_token":"([A-Za-z0-9]+)"/);
	return { username: u ? u[1] : null, csrf: c ? c[1] : null };
}

/** Credits the first sync will cost: one SociaVault post-info per post (assumed 1 credit). */
export function creditWarning(count: number): string | null {
	return count > IG_CREDIT_WARNING_OVER
		? `This will use about ${count} SociaVault credits. Your SociaVault key must be saved in Lazy Reader Settings first, or the posts park as "no key".`
		: null;
}

export async function runInstagramSync(deps: SyncDeps, kind: InstagramRunKind): Promise<InstagramRunResult> {
	const out: InstagramRunResult = { sent: 0, username: null, stopped: null, message: null };
	const state = await loadState(deps.store, 'instagram');
	if (!state.enabled) return out;
	if (state.running && deps.now() - (state.lastAttemptAt ?? 0) < 15 * 60 * 1000) return out;
	// Schedule after schedule: the shared floor already spaces runs an hour apart
	// (Instagram's start drifts with the jobs before it). Any manual run in
	// between (Sync now, Load older) keeps Instagram's own one-hour gate.
	const scheduleOwnsFloor = kind === 'scheduled' && state.lastAttemptScheduled === true;
	if (!scheduleOwnsFloor && state.lastAttemptAt !== null && deps.now() - state.lastAttemptAt < IG_MIN_INTERVAL_MS) {
		out.stopped = 'too-soon';
		out.message = 'Instagram sync runs at most once an hour. Try again later.';
		return out;
	}
	const previousAttempt = state.lastAttemptAt;
	const previousScheduled = state.lastAttemptScheduled;
	state.running = true;
	state.lastAttemptAt = deps.now();
	state.lastAttemptScheduled = kind === 'scheduled';
	await saveState(deps.store, 'instagram', state);

	const finish = async (stopped: InstagramRunResult['stopped'], message: string | null) => {
		out.stopped = stopped;
		out.message = message;
		state.running = false;
		state.lastRunAt = deps.now();
		if (stopped === 'signed-out') { state.signedOut = true; state.lastError = null; state.lastAttemptAt = previousAttempt; state.lastAttemptScheduled = previousScheduled; }
		else if (stopped) state.lastError = message;
		else { state.lastSuccess = deps.now(); state.lastError = null; state.signedOut = false; }
		state.lastResult = `${out.sent} saved`;
		await saveState(deps.store, 'instagram', state);
		return out;
	};

	try {
		// Who is signed in: shown to the user, and the guard against a wrong account.
		const acc = await deps.fetchFn(IG_ACCOUNT_URL, { credentials: 'include' });
		const account = acc.ok ? parseAccountPage(await acc.text()) : { username: null, csrf: null };
		if (!account.username || !account.csrf) return await finish('signed-out', 'Log in to Instagram in this browser');
		out.username = account.username;

		const known = new Set(state.knownIds);
		const firstRun = state.lastSuccess === null && state.knownIds.length === 0 && state.olderCursor === null;
		const isOlder = kind === 'older';
		if (isOlder && state.olderExhausted) return await finish(null, 'No older saves left.');

		let cursor: string | null = isOlder ? state.olderCursor : null;
		const target = isOlder || firstRun ? IG_FIRST_RUN_POSTS : Infinity;
		const found: SyncPost[] = [];
		let knownRun = 0;
		let first = true;
		let exhausted = false;
		for (;;) {
			if (!first) await deps.sleep(IG_PAGE_DELAY_MS);
			first = false;
			const url = `${IG_LIST_URL}${cursor ? `?max_id=${encodeURIComponent(cursor)}` : ''}`;
			const res = await deps.fetchFn(url, {
				credentials: 'include',
				headers: { 'X-IG-App-ID': IG_APP_ID, 'X-CSRFToken': account.csrf, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
			});
			if (res.status === 429) return await finish('rate-limited', 'Instagram asked us to slow down. Try again later.');
			if (res.status === 401 || res.status === 403) return await finish('signed-out', 'Log in to Instagram in this browser');
			if (!res.ok) return await finish('error', `Instagram answered ${res.status}`);
			let json: any;
			try { json = await res.json(); } catch { return await finish('signed-out', 'Log in to Instagram in this browser'); }
			const page = parseSavedPosts(json);
			let stop = false;
			let used = 0;
			for (const p of page.posts) {
				used++;
				if (known.has(p.id)) {
					knownRun++;
					// Later syncs stop after 3 known links in a row (newest first).
					if (!isOlder && !firstRun && knownRun >= IG_STOP_AFTER_KNOWN) { stop = true; break; }
					continue;
				}
				knownRun = 0;
				found.push(p);
				if (found.length >= target) break;
			}
			// Stopped inside a page at the limit: keep the cursor on this page, so
			// Load older fetches it again and the known ids skip what was sent.
			if (found.length >= target && used < page.posts.length) break;
			cursor = page.nextMaxId;
			if (!cursor) { exhausted = true; break; }
			if (stop || found.length >= target) break;
		}

		let first2 = true;
		for (const post of found) {
			if (!first2) await deps.sleep(IG_SEND_GAP_MS);
			first2 = false;
			const sent = await deps.send(post, undefined);
			if (sent.status === 401) return await finish('token', 'Lazy Reader did not accept the token. Copy it again from Lazy Reader, Settings.');
			if (!sent.ok) return await finish('error', sent.error || `Lazy Reader answered ${sent.status ?? 'nothing'}`);
			out.sent++;
			state.knownIds.push(post.id);
		}
		if (isOlder || firstRun) {
			state.olderCursor = cursor;
			state.olderExhausted = exhausted;
		}
		return await finish(null, null);
	} catch (e) {
		return await finish('error', e instanceof Error ? e.message : String(e));
	}
}
