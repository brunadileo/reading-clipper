// READ-38: read one YouTube video's transcript from the user's own browser, so
// the clipper can send it with the link and the server never has to call
// YouTube for that item (the server gets 429 after one video from a cloud IP).
//
// Ported by hand from lazyreader core/src/extract/youtube.ts (the VISIONOS
// route, json3 with an XML fallback, output `## Description` plus
// `## Transcript`) and, for the fallback clients, from the old brain app's
// transcript service (WEB, ANDROID, IOS, then srv3 XML). About 70 lines are
// duplicated on purpose: core is a separate repo. The two core fixtures in
// fixtures/youtube/ are shared, so drift shows up in youtube-transcript.test.ts.
//
// Every request uses credentials 'omit': captions need no sign-in, and nothing
// here is tied to the account. Failure never blocks a save: the caller sends
// the link alone. 429 or a "not a bot" answer sets `blocked`; a timeout, network
// error, 5xx, 403 or empty caption body sets `transient`. Either way the caller
// stops transcript attempts for the rest of its run, and the finisher counts no
// attempt: only a definite answer (no captions on any client, under 50 words,
// a video that cannot be played) is a miss.
import { countWords } from './sync-core';
import type { TranscriptRead } from './youtube-sync';

export const MIN_TRANSCRIPT_WORDS = 50;
const TIMEOUT_MS = 15_000;

const YT_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

interface CaptionTrack {
	languageCode?: string;
	kind?: string;
	baseUrl: string;
}

interface CaptionsRenderer {
	captionTracks?: CaptionTrack[];
	audioTracks?: Array<{ defaultCaptionTrackIndex?: number }>;
	defaultAudioTrackIndex?: number;
}

interface PlayerClient {
	name: string;
	// Fallback clients pick "en, else first track translated to en" (graveyard rule).
	fallback: boolean;
	client: (visitorData: string | null) => Record<string, unknown>;
}

// The server's own route first, then the three clients the old brain app tried.
export const PLAYER_CLIENTS: PlayerClient[] = [
	{
		name: 'VISIONOS',
		fallback: false,
		client: (visitorData) => ({
			clientName: 'VISIONOS',
			clientVersion: '1.02',
			deviceMake: 'Apple',
			deviceModel: 'RealityDevice17,1',
			userAgent: YT_UA,
			osName: 'visionOS',
			osVersion: '26.5.23O471',
			hl: 'en',
			gl: 'US',
			...(visitorData ? { visitorData } : {}),
		}),
	},
	{ name: 'WEB', fallback: true, client: () => ({ clientName: 'WEB', clientVersion: '2.20240313.05.00', hl: 'en' }) },
	{ name: 'ANDROID', fallback: true, client: () => ({ clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30, hl: 'en' }) },
	{ name: 'IOS', fallback: true, client: () => ({ clientName: 'IOS', clientVersion: '19.09.3', hl: 'en' }) },
];

/** YouTube is refusing this browser for now (429 or a bot check). */
class Blocked extends Error {}

/**
 * Core's rule: the track the default audio track points at, manual before
 * auto-generated, never translated; else any manual track; else the first.
 */
export function pickCaptionTrack(renderer: CaptionsRenderer | undefined | null): CaptionTrack | null {
	const tracks = renderer?.captionTracks || [];
	if (!tracks.length) return null;
	const audioTrack = renderer?.audioTracks?.[renderer?.defaultAudioTrackIndex || 0];
	const defaultIdx = audioTrack?.defaultCaptionTrackIndex;
	const originalLang = defaultIdx != null && tracks[defaultIdx] ? tracks[defaultIdx].languageCode : null;
	if (originalLang) {
		const manual = tracks.find((t) => t.languageCode === originalLang && t.kind !== 'asr');
		if (manual) return manual;
		const asr = tracks.find((t) => t.languageCode === originalLang && t.kind === 'asr');
		if (asr) return asr;
	}
	return tracks.find((t) => t.kind !== 'asr') || tracks[0];
}

/** Graveyard rule for the fallback clients: first "en" track, else the first track translated to English. */
export function pickFallbackTrack(renderer: CaptionsRenderer | undefined | null): CaptionTrack | null {
	const tracks = renderer?.captionTracks || [];
	if (!tracks.length) return null;
	const en = tracks.find((t) => t.languageCode === 'en');
	if (en) return en;
	return { ...tracks[0], baseUrl: tracks[0].baseUrl + '&tlang=en' };
}

export function stripXmlEntities(s: string): string {
	return s
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.trim();
}

/** Lines of a json3 caption body, joined with blank lines. Empty when it is not json3. */
export function parseJson3(body: string): string {
	try {
		const data = JSON.parse(body);
		const lines: string[] = [];
		for (const ev of data.events || []) {
			const text = (ev.segs || []).map((s: { utf8?: string }) => s.utf8 || '').join('');
			if (text.trim()) lines.push(text.replace(/\n/g, ' ').trim());
		}
		return lines.join('\n\n');
	} catch {
		return '';
	}
}

/** Lines of an XML caption body: srv3 (<p><s>) or the older timedtext (<text>). */
export function parseCaptionXml(xml: string): string {
	if (!xml || xml.length < 10) return '';
	const lines: string[] = [];
	if (/<p\s[^>]*t="/.test(xml)) {
		for (const m of xml.matchAll(/<p\s[^>]*>([\s\S]*?)<\/p>/g)) {
			if (m[1].length > 100_000) continue;
			const text = stripXmlEntities(m[1].replace(/<[^>]+>/g, ''));
			if (text) lines.push(text);
		}
	} else {
		for (const m of xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)) lines.push(stripXmlEntities(m[1]));
	}
	return lines.join('\n\n');
}

const isYouTubeHost = (url: string): boolean => {
	try {
		const u = new URL(url);
		return u.protocol === 'https:' && (u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com'));
	} catch {
		return false;
	}
};

async function get(fetchFn: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
	return fetchFn(url, { ...init, credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function fetchVisitorData(fetchFn: typeof fetch, videoId: string): Promise<string | null> {
	const res = await get(fetchFn, `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, { headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
	if (res.status === 429) throw new Blocked('429');
	if (!res.ok) return null;
	const m = (await res.text()).match(/"visitorData":"([^"]+)"/);
	return m ? m[1] : null;
}

async function fetchCaptionText(fetchFn: typeof fetch, baseUrl: string): Promise<string> {
	const body = async (url: string) => {
		const res = await get(fetchFn, url);
		if (res.status === 429) throw new Blocked('429');
		return { ok: res.ok, text: await res.text() };
	};
	const json = await body(`${baseUrl}&fmt=json3`);
	if (json.ok && json.text.length > 10) {
		const text = parseJson3(json.text);
		if (text) return text;
	}
	// fmt=json3 sometimes comes back empty; the XML timedtext format is the fallback.
	return parseCaptionXml((await body(baseUrl)).text);
}

/** Assembled note text, as the server builds it. */
export function buildTranscriptMarkdown(description: string, transcript: string): string {
	const parts: string[] = [];
	if (description.trim()) parts.push(`## Description\n\n${description.trim()}`);
	parts.push(`## Transcript\n\n${transcript}`);
	return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Read one video's transcript. Never throws. text is null when nothing usable
 * was read. blocked is true when YouTube answered 429 or a bot check; transient
 * is true when the answer was not definite (timeout, network error, 5xx, 403,
 * empty caption body), so a retry later may work. Neither set: a definite miss.
 */
export async function readYouTubeTranscript(fetchFn: typeof fetch, videoId: string): Promise<TranscriptRead> {
	if (!/^[\w-]{6,20}$/.test(videoId)) return { text: null, blocked: false };
	try {
		const visitorData = await fetchVisitorData(fetchFn, videoId).catch((e) => {
			if (e instanceof Blocked) throw e;
			return null;
		});
		let transient = false;
		// A client that answered OK with no usable track is a definite "no captions",
		// even when another client failed: one flaky client must not keep a video waiting forever.
		let sawNoTrack = false;
		for (const pc of PLAYER_CLIENTS) {
			try {
				const res = await get(fetchFn, 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}) },
					body: JSON.stringify({ videoId, context: { client: pc.client(visitorData) } }),
				});
				if (res.status === 429) throw new Blocked('429');
				if (!res.ok) {
					// 5xx, 403 and the like say nothing about this video.
					transient = true;
					continue;
				}
				const data: any = await res.json();
				const status = data?.playabilityStatus?.status;
				const reason = String(data?.playabilityStatus?.reason ?? '');
				if (/bot/i.test(reason)) throw new Blocked('bot check');
				if (status && status !== 'OK') {
					// Sign-in wall on this client: the next one may differ. Anything else
					// (private, removed) is the same for every client.
					if (status === 'LOGIN_REQUIRED') continue;
					return { text: null, blocked: false };
				}
				const renderer = data?.captions?.playerCaptionsTracklistRenderer;
				const track = pc.fallback ? pickFallbackTrack(renderer) : pickCaptionTrack(renderer);
				if (!track?.baseUrl || !isYouTubeHost(track.baseUrl)) { sawNoTrack = true; continue; }
				const transcript = await fetchCaptionText(fetchFn, track.baseUrl);
				if (!transcript.trim()) {
					// A caption track that comes back empty is a bad answer, not "no captions".
					transient = true;
					continue;
				}
				if (countWords(transcript) < MIN_TRANSCRIPT_WORDS) return { text: null, blocked: false };
				return { text: buildTranscriptMarkdown(String(data?.videoDetails?.shortDescription ?? ''), transcript), blocked: false };
			} catch (e) {
				if (e instanceof Blocked) throw e;
				// This client failed (timeout, network, bad JSON): try the next.
				transient = true;
			}
		}
		return transient && !sawNoTrack ? { text: null, blocked: false, transient: true } : { text: null, blocked: false };
	} catch (e) {
		return e instanceof Blocked ? { text: null, blocked: true } : { text: null, blocked: false, transient: true };
	}
}
