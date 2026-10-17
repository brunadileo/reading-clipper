// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import Defuddle from 'defuddle';
import { defuddleOptions } from './store-build';

describe('defuddleOptions (READ-48)', () => {
	it('turns off third-party fetches in the store build', () => {
		expect(defuddleOptions('https://x.com/a/status/1', true)).toEqual({ url: 'https://x.com/a/status/1', useAsync: false });
	});
	it('leaves the default build as it was', () => {
		expect(defuddleOptions('https://x.com/a/status/1', false)).toEqual({ url: 'https://x.com/a/status/1' });
	});
});

describe('defuddleOptions on YouTube (READ-359)', () => {
	it.each([
		'https://www.youtube.com/watch?v=abc',
		'https://m.youtube.com/watch?v=abc',
		'https://youtube.com/shorts/abc',
	])('keeps async extraction on in the store build for %s', (url) => {
		expect(defuddleOptions(url, true)).toEqual({ url });
	});
	it.each([
		'https://x.com/a/status/1',
		'https://www.bilibili.com/video/BV1',
		'https://notyoutube.com/watch?v=abc',
		'https://youtube.com.evil.example/watch?v=abc',
		'https://evil.example/?u=https://www.youtube.com/watch?v=abc',
		'https://www.youtube.com@evil.example/watch?v=abc',
		'not a url',
		'',
	])('keeps useAsync false in the store build for %s', (url) => {
		expect(defuddleOptions(url, true)).toEqual({ url, useAsync: false });
	});
	it('does not throw on a URL that does not parse', () => {
		expect(() => defuddleOptions('::::', true)).not.toThrow();
	});
});

describe('real Defuddle with store options (READ-359)', () => {
	const videoId = 'abc12345678';
	const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
	const captionUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`;
	const xml = '<?xml version="1.0"?><transcript><text start="0.5" dur="2">Hello and welcome to the zebra lecture.</text><text start="3" dur="2">Today we talk about stripes.</text></transcript>';

	function watchDoc(): Document {
		const player = JSON.stringify({
			videoDetails: { videoId },
			captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: captionUrl, languageCode: 'en' }] } },
		});
		const html = `<html><head><title>Zebras</title></head><body><script>var ytInitialPlayerResponse = ${player};</script></body></html>`;
		return new DOMParser().parseFromString(html, 'text/html');
	}
	function makeStub() {
		const calls: string[] = [];
		const stub = async (input: unknown) => {
			const u = String(input);
			calls.push(u);
			if (u.startsWith(captionUrl)) return { ok: true, text: async () => xml, json: async () => ({}) };
			return { ok: false, text: async () => '', json: async () => ({}) };
		};
		return { stub: stub as unknown as typeof fetch, calls };
	}

	it('reads the transcript from www.youtube.com only', async () => {
		const { stub, calls } = makeStub();
		const result = await new Defuddle(watchDoc(), { ...defuddleOptions(watchUrl, true), fetch: stub }).parseAsync();
		expect(result.content).toContain('zebra lecture');
		expect(result.content).toContain('stripes');
		expect(calls.length).toBeGreaterThan(0);
		for (const u of calls) expect(u.startsWith('https://www.youtube.com/')).toBe(true);
	});

	it('makes no fetch on an x.com status page with an empty body', async () => {
		const { stub, calls } = makeStub();
		const doc = new DOMParser().parseFromString('<html><head></head><body></body></html>', 'text/html');
		await new Defuddle(doc, { ...defuddleOptions('https://x.com/a/status/1', true), fetch: stub }).parseAsync();
		expect(calls).toEqual([]);
	});
});
