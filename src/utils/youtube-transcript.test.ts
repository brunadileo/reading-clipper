import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
	buildTranscriptMarkdown, parseCaptionXml, parseJson3, pickCaptionTrack, pickFallbackTrack, readYouTubeTranscript,
} from './youtube-transcript';

const dir = join(process.cwd(), 'src', 'utils', 'fixtures', 'youtube');
// Shared with core (core/test/fixtures): real captured responses for one public video.
const player = JSON.parse(readFileSync(join(dir, 'youtube-player-manual-and-asr-track.json'), 'utf8'));
const json3Raw = readFileSync(join(dir, 'youtube-caption-json3.json'), 'utf8');
const VIDEO = 'n1cd1FhVAWY';

// The text core makes from the same json3 body (extractYouTube + fetchCaptionText), built independently here.
const expectedTranscript = JSON.parse(json3Raw).events
	.map((ev: any) => (ev.segs || []).map((s: any) => s.utf8 || '').join(''))
	.filter((t: string) => t.trim())
	.map((t: string) => t.replace(/\n/g, ' ').trim())
	.join('\n\n');
const expectedMarkdown = `## Description\n\n${player.videoDetails.shortDescription.trim()}\n\n## Transcript\n\n${expectedTranscript}`.replace(/\n{3,}/g, '\n\n').trim();

type Reply = { status?: number; json?: any; text?: string } | undefined;
function fakeYt(route: (url: string, init: RequestInit) => Reply) {
	const calls: Array<{ url: string; init: RequestInit; client?: string }> = [];
	const fn = (async (input: any, init: RequestInit = {}) => {
		const url = String(input);
		const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		calls.push({ url, init, client: body?.context?.client?.clientName });
		const r = route(url, init) ?? { status: 404 };
		const status = r.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => r.json,
			text: async () => r.text ?? '',
		} as Response;
	}) as typeof fetch;
	return { fn, calls };
}

const WATCH = '<html>..."visitorData":"VISITOR123"...</html>';
const isPlayer = (u: string) => u.includes('/youtubei/v1/player');
const isCaption = (u: string) => u.includes('/api/timedtext');
const longText = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
const json3Of = (text: string) => JSON.stringify({ events: [{ segs: [{ utf8: text }] }] });
const playerWith = (tracks: any[], extra: any = {}) => ({
	playabilityStatus: { status: 'OK' },
	captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
	videoDetails: { shortDescription: 'About it' },
	...extra,
});

describe('track choice', () => {
	it('core rule: the manual track in the original language beats the auto one', () => {
		const t = pickCaptionTrack(player.captions.playerCaptionsTracklistRenderer);
		expect(t?.languageCode).toBe('en');
		expect(t?.kind).not.toBe('asr');
	});
	it('core rule: asr in the original language when there is no manual one; manual elsewhere; null with none', () => {
		expect(pickCaptionTrack({ captionTracks: [{ languageCode: 'en', kind: 'asr', baseUrl: 'a' }], audioTracks: [{ defaultCaptionTrackIndex: 0 }] })?.kind).toBe('asr');
		expect(pickCaptionTrack({ captionTracks: [{ languageCode: 'es', kind: 'asr', baseUrl: 'a' }, { languageCode: 'fr', baseUrl: 'b' }] })?.languageCode).toBe('fr');
		expect(pickCaptionTrack({ captionTracks: [] })).toBeNull();
		expect(pickCaptionTrack(undefined)).toBeNull();
	});
	it('fallback rule: first en track, else the first track translated to en', () => {
		expect(pickFallbackTrack({ captionTracks: [{ languageCode: 'fr', baseUrl: 'f' }, { languageCode: 'en', baseUrl: 'e' }] })?.baseUrl).toBe('e');
		expect(pickFallbackTrack({ captionTracks: [{ languageCode: 'fr', baseUrl: 'f?x=1' }] })?.baseUrl).toBe('f?x=1&tlang=en');
		expect(pickFallbackTrack({ captionTracks: [] })).toBeNull();
	});
});

describe('caption bodies', () => {
	it('json3 of the shared fixture gives the same lines core makes', () => {
		expect(parseJson3(json3Raw)).toBe(expectedTranscript);
		expect(parseJson3(json3Raw)).toContain("Hey, it's Mark.");
	});
	it('json3 garbage gives empty', () => {
		expect(parseJson3('<xml/>')).toBe('');
		expect(parseJson3('{"events":[]}')).toBe('');
	});
	it('XML timedtext (<text>), with core entity handling', () => {
		expect(parseCaptionXml('<transcript><text start="0">It&#39;s &quot;fine&quot; &amp; ok</text><text start="1">Two</text></transcript>')).toBe('It\'s "fine" & ok\n\nTwo');
	});
	it('srv3 XML (<p><s>)', () => {
		const xml = '<timedtext><body><p t="0" d="900"><s>Hello</s><s t="100"> there</s></p><p t="1000" d="500"> </p><p t="2000" d="800"><s>Second &amp; last</s></p></body></timedtext>';
		expect(parseCaptionXml(xml)).toBe('Hello there\n\nSecond & last');
	});
	it('short or missing XML gives empty', () => {
		expect(parseCaptionXml('')).toBe('');
		expect(parseCaptionXml('<a/>')).toBe('');
	});
	it('builds Description then Transcript, and drops an empty description', () => {
		expect(buildTranscriptMarkdown('  About  ', 'Body')).toBe('## Description\n\nAbout\n\n## Transcript\n\nBody');
		expect(buildTranscriptMarkdown('', 'Body')).toBe('## Transcript\n\nBody');
	});
});

describe('readYouTubeTranscript', () => {
	it('VISIONOS route on the shared fixture: output equals the text core builds', async () => {
		const { fn, calls } = fakeYt((url) => {
			if (url.includes('/watch?v=')) return { text: WATCH };
			if (isPlayer(url)) return { json: player };
			if (isCaption(url)) return { text: json3Raw };
		});
		const r = await readYouTubeTranscript(fn, VIDEO);
		expect(r).toEqual({ text: expectedMarkdown, blocked: false });
		const p = calls.find((c) => isPlayer(c.url))!;
		expect(p.client).toBe('VISIONOS');
		expect(calls.every((c) => c.init.credentials === 'omit')).toBe(true);
		expect((p.init.headers as any)['X-Goog-Visitor-Id']).toBe('VISITOR123');
		expect(calls.find((c) => isCaption(c.url))!.url).toContain('&fmt=json3');
	});

	it('falls back to the XML body when json3 comes back empty', async () => {
		const xml = `<transcript>${Array.from({ length: 60 }, (_, i) => `<text start="${i}">word${i}</text>`).join('')}</transcript>`;
		const { fn, calls } = fakeYt((url) => {
			if (url.includes('/watch?v=')) return { text: WATCH };
			if (isPlayer(url)) return { json: player };
			if (isCaption(url)) return url.includes('fmt=json3') ? { text: '' } : { text: xml };
		});
		const r = await readYouTubeTranscript(fn, VIDEO);
		expect(r.text).toContain('word59');
		expect(calls.filter((c) => isCaption(c.url))).toHaveLength(2);
	});

	it('tries WEB, ANDROID, IOS after VISIONOS finds no captions, and stops at the first that has them', async () => {
		const order: string[] = [];
		const { fn } = fakeYt((url, init) => {
			if (url.includes('/watch?v=')) return { text: WATCH };
			if (isPlayer(url)) {
				const c = JSON.parse(String(init.body)).context.client.clientName;
				order.push(c);
				return c === 'ANDROID' ? { json: playerWith([{ languageCode: 'de', baseUrl: 'https://www.youtube.com/api/timedtext?v=x' }]) } : { json: playerWith([]) };
			}
			if (isCaption(url)) return { text: json3Of(longText) };
		});
		const r = await readYouTubeTranscript(fn, 'abcdefghijk');
		expect(order).toEqual(['VISIONOS', 'WEB', 'ANDROID']);
		expect(r.text).toContain('## Transcript');
	});

	it('the fallback client asks for an English translation when it has no en track', async () => {
		const captionUrls: string[] = [];
		const { fn } = fakeYt((url, init) => {
			if (url.includes('/watch?v=')) return { text: WATCH };
			if (isPlayer(url)) return JSON.parse(String(init.body)).context.client.clientName === 'WEB' ? { json: playerWith([{ languageCode: 'fr', baseUrl: 'https://www.youtube.com/api/timedtext?v=x' }]) } : { json: playerWith([]) };
			if (isCaption(url)) { captionUrls.push(url); return { text: json3Of(longText) }; }
		});
		await readYouTubeTranscript(fn, 'abcdefghijk');
		expect(captionUrls[0]).toContain('&tlang=en');
	});

	it('no captions on any client: null, not blocked', async () => {
		const { fn, calls } = fakeYt((url) => (url.includes('/watch?v=') ? { text: WATCH } : isPlayer(url) ? { json: playerWith([]) } : undefined));
		expect(await readYouTubeTranscript(fn, 'abcdefghijk')).toEqual({ text: null, blocked: false });
		expect(calls.filter((c) => isPlayer(c.url))).toHaveLength(4);
	});

	it('under 50 words: null, and the other clients are not tried', async () => {
		const { fn, calls } = fakeYt((url) => {
			if (url.includes('/watch?v=')) return { text: WATCH };
			if (isPlayer(url)) return { json: playerWith([{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=x' }]) };
			if (isCaption(url)) return { text: json3Of('just a few words here') };
		});
		expect(await readYouTubeTranscript(fn, 'abcdefghijk')).toEqual({ text: null, blocked: false });
		expect(calls.filter((c) => isPlayer(c.url))).toHaveLength(1);
	});

	it('429 on the player call: blocked, nothing more is asked', async () => {
		const { fn, calls } = fakeYt((url) => (url.includes('/watch?v=') ? { text: WATCH } : isPlayer(url) ? { status: 429 } : undefined));
		expect(await readYouTubeTranscript(fn, 'abcdefghijk')).toEqual({ text: null, blocked: true });
		expect(calls.filter((c) => isPlayer(c.url))).toHaveLength(1);
	});

	it('429 on the watch page: blocked before any player call', async () => {
		const { fn, calls } = fakeYt((url) => (url.includes('/watch?v=') ? { status: 429 } : undefined));
		expect(await readYouTubeTranscript(fn, 'abcdefghijk')).toEqual({ text: null, blocked: true });
		expect(calls).toHaveLength(1);
	});

	it('429 on the caption body: blocked', async () => {
		const { fn } = fakeYt((url) => {
			if (url.includes('/watch?v=')) return { text: WATCH };
			if (isPlayer(url)) return { json: player };
			if (isCaption(url)) return { status: 429 };
		});
		expect((await readYouTubeTranscript(fn, VIDEO)).blocked).toBe(true);
	});

	it('a "not a bot" refusal: blocked', async () => {
		const { fn, calls } = fakeYt((url) => (url.includes('/watch?v=') ? { text: WATCH } : isPlayer(url) ? { json: { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" } } } : undefined));
		expect(await readYouTubeTranscript(fn, 'abcdefghijk')).toEqual({ text: null, blocked: true });
		expect(calls.filter((c) => isPlayer(c.url))).toHaveLength(1);
	});

	it('a plain sign-in wall on one client moves on; a private video ends it without blocking', async () => {
		const login = fakeYt((url) => (url.includes('/watch?v=') ? { text: WATCH } : isPlayer(url) ? { json: { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in' } } } : undefined));
		expect(await readYouTubeTranscript(login.fn, 'abcdefghijk')).toEqual({ text: null, blocked: false });
		expect(login.calls.filter((c) => isPlayer(c.url))).toHaveLength(4);
		const priv = fakeYt((url) => (url.includes('/watch?v=') ? { text: WATCH } : isPlayer(url) ? { json: { playabilityStatus: { status: 'UNPLAYABLE', reason: 'Private video' } } } : undefined));
		expect(await readYouTubeTranscript(priv.fn, 'abcdefghijk')).toEqual({ text: null, blocked: false });
		expect(priv.calls.filter((c) => isPlayer(c.url))).toHaveLength(1);
	});

	it('timeouts, 5xx and 403 on the player call are transient, not a miss', async () => {
		for (const status of [500, 503, 403]) {
			const { fn, calls } = fakeYt((url) => (url.includes('/watch?v=') ? { text: WATCH } : isPlayer(url) ? { status } : undefined));
			expect(await readYouTubeTranscript(fn, 'abcdefghijk')).toEqual({ text: null, blocked: false, transient: true });
			expect(calls.filter((c) => isPlayer(c.url))).toHaveLength(4);
		}
		const timeout = (async (url: string) => {
			if (String(url).includes('/watch?v=')) return new Response(WATCH);
			throw new DOMException('timed out', 'TimeoutError');
		}) as unknown as typeof fetch;
		expect(await readYouTubeTranscript(timeout, 'abcdefghijk')).toEqual({ text: null, blocked: false, transient: true });
	});

	it('an empty caption body is transient; a later client with a definite answer cannot make it a miss', async () => {
		const { fn } = fakeYt((url) => {
			if (url.includes('/watch?v=')) return { text: WATCH };
			if (isPlayer(url)) return { json: player };
			if (isCaption(url)) return { text: '' };
		});
		expect(await readYouTubeTranscript(fn, VIDEO)).toEqual({ text: null, blocked: false, transient: true });
	});

	it('one failing client plus one that says "no captions" is a definite miss', async () => {
		let n = 0;
		const { fn } = fakeYt((url) => (url.includes('/watch?v=') ? { text: WATCH } : isPlayer(url) ? (n++ === 0 ? { status: 403 } : { json: playerWith([]) }) : undefined));
		expect(await readYouTubeTranscript(fn, 'abcdefghijk')).toEqual({ text: null, blocked: false });
	});

	it('definite misses are not transient', async () => {
		const none = fakeYt((url) => (url.includes('/watch?v=') ? { text: WATCH } : isPlayer(url) ? { json: playerWith([]) } : undefined));
		expect((await readYouTubeTranscript(none.fn, 'abcdefghijk')).transient).toBeUndefined();
	});

	it('refuses a caption URL that is not on youtube.com', async () => {
		const { fn, calls } = fakeYt((url) => {
			if (url.includes('/watch?v=')) return { text: WATCH };
			if (isPlayer(url)) return { json: playerWith([{ languageCode: 'en', baseUrl: 'https://evil.example/api/timedtext?v=x' }]) };
		});
		expect((await readYouTubeTranscript(fn, 'abcdefghijk')).text).toBeNull();
		expect(calls.some((c) => c.url.includes('evil.example'))).toBe(false);
	});

	it('network errors and bad ids never throw', async () => {
		const boom = (async () => { throw new Error('offline'); }) as typeof fetch;
		expect(await readYouTubeTranscript(boom, 'abcdefghijk')).toEqual({ text: null, blocked: false, transient: true });
		expect(await readYouTubeTranscript(boom, 'bad id!')).toEqual({ text: null, blocked: false });
	});
});
