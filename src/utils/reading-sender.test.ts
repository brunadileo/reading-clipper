import { describe, it, expect, vi } from 'vitest';
import { buildReadingCaptureBody, captureWithToken, postCapture, fitReadingText, MAX_READING_TEXT_BYTES, READING_TEXT_CUT_NOTE } from './reading-sender';

describe('buildReadingCaptureBody', () => {
	it('maps title and site name, keeps url as given', () => {
		const body = buildReadingCaptureBody({
			url: 'https://example.com/article',
			title: 'My Article',
			siteName: 'Example Site',
			text: 'Some article body text.',
		});

		expect(body).toEqual({
			url: 'https://example.com/article',
			title: 'My Article',
			site_name: 'Example Site',
			text: 'Some article body text.',
		});
	});

	it('drops the text key entirely when the body is empty', () => {
		const body = buildReadingCaptureBody({
			url: 'https://example.com/article',
			title: 'My Article',
			siteName: 'Example Site',
			text: '',
		});

		expect(body).not.toHaveProperty('text');
	});

	it('drops the text key when the body is whitespace only', () => {
		const body = buildReadingCaptureBody({
			url: 'https://example.com/article',
			title: 'My Article',
			siteName: 'Example Site',
			text: '   \n\t  ',
		});

		expect(body).not.toHaveProperty('text');
	});

	it('keeps an article that opens with a --- rule whole', () => {
		const text = '---\nOpening section.\n\n---\n\nThe rest of the article.';

		const body = buildReadingCaptureBody({
			url: 'https://example.com/article',
			title: 'My Article',
			siteName: 'Example Site',
			text,
		});

		expect(body.text).toBe(text);
	});
});

describe('fitReadingText', () => {
	const bytes = (s: string) => new TextEncoder().encode(s).length;

	it('leaves text under the limit untouched', () => {
		const text = 'Short article.';
		expect(fitReadingText(text)).toBe(text);
	});

	it('cuts a long article to the limit and adds the note', () => {
		const text = 'word '.repeat(Math.ceil(MAX_READING_TEXT_BYTES / 5) + 1000);
		const fitted = fitReadingText(text);
		expect(bytes(fitted)).toBeLessThanOrEqual(MAX_READING_TEXT_BYTES);
		expect(fitted.endsWith(READING_TEXT_CUT_NOTE)).toBe(true);
		expect(text.startsWith(fitted.slice(0, -READING_TEXT_CUT_NOTE.length))).toBe(true);
	});

	it('counts bytes, so accented and multi-byte text stays under the limit whole-character', () => {
		const text = 'ação 日本語 '.repeat(Math.ceil(MAX_READING_TEXT_BYTES / 5));
		const fitted = fitReadingText(text);
		expect(bytes(fitted)).toBeLessThanOrEqual(MAX_READING_TEXT_BYTES);
		expect(fitted).not.toContain('�');
	});

	it('cuts at a paragraph end when one is near the limit', () => {
		const paragraph = 'x'.repeat(999) + '\n\n';
		const fitted = fitReadingText(paragraph.repeat(Math.ceil(MAX_READING_TEXT_BYTES / 1000) + 5));
		const body = fitted.slice(0, -READING_TEXT_CUT_NOTE.length);
		expect(body.endsWith('x')).toBe(true);
		expect(body.length % 1001).toBe(999);
	});

	it('finds paragraph breaks that carry spaces, as defuddle writes them', () => {
		const paragraph = 'y'.repeat(997) + '  \n  \n';
		const fitted = fitReadingText(paragraph.repeat(Math.ceil(MAX_READING_TEXT_BYTES / 1000) + 5));
		const body = fitted.slice(0, -READING_TEXT_CUT_NOTE.length);
		expect(body.endsWith('y')).toBe(true);
	});

	it('buildReadingCaptureBody sends the cut text', () => {
		const body = buildReadingCaptureBody({
			url: 'https://example.com/long',
			title: 'Long',
			siteName: 'Example',
			text: 'word '.repeat(Math.ceil(MAX_READING_TEXT_BYTES / 5) + 1000),
		});
		expect(bytes(body.text!)).toBeLessThanOrEqual(MAX_READING_TEXT_BYTES);
	});
});

describe('source and postCapture', () => {
	it('adds source only when given', () => {
		const base = { url: 'https://a.test/p/x', title: 'T', siteName: 'S', text: 'body' };
		expect(buildReadingCaptureBody(base)).not.toHaveProperty('source');
		expect(buildReadingCaptureBody({ ...base, source: 'substack' }).source).toBe('substack');
	});

	it('adds via only when given, and popup and sync bodies carry the right channel (READ-200)', () => {
		const base = { url: 'https://a.test/p/x', title: 'T', siteName: 'S', text: 'body' };
		expect(buildReadingCaptureBody(base)).not.toHaveProperty('via');
		const popup = buildReadingCaptureBody({ ...base, via: 'chrome-clipper' });
		expect(popup.via).toBe('chrome-clipper');
		expect(popup).not.toHaveProperty('source');
		// The sync bodies keep source for a server that predates via.
		for (const service of ['substack', 'instagram'] as const) {
			const sync = buildReadingCaptureBody({ ...base, source: service, via: `${service}-saved` });
			expect(sync.source).toBe(service);
			expect(sync.via).toBe(`${service}-saved`);
		}
	});

	it('posts with the token header and returns status and data', async () => {
		let seen: any;
		const fetchFn = (async (url: string, init: any) => {
			seen = { url, init };
			return { ok: true, status: 200, json: async () => ({ id: 'abc', created: true }) } as any;
		}) as any;
		const r = await postCapture({ url: 'https://a.test', title: '', site_name: '' }, 'https://cap.test/capture', 'secret-token', fetchFn);
		expect(r).toMatchObject({ ok: true, status: 200, data: { id: 'abc' } });
		expect(seen.init.headers['x-reader-token']).toBe('secret-token');
		expect(await postCapture({ url: 'u', title: '', site_name: '' }, 'https://cap.test', '')).toMatchObject({ ok: false, status: 401 });
	});
});

describe('captureWithToken (no silent reconnect)', () => {
	const body = { url: 'https://example.com/a', title: 'T', site_name: 'example.com' };
	// Anything that could open a tab or read a session would go through these.
	const tabsCreate = vi.fn();
	(globalThis as any).chrome = { tabs: { create: tabsCreate }, scripting: { executeScript: vi.fn() } };

	it('no token: not-connected, no request, no tab', async () => {
		const fetchFn = vi.fn();
		const r = await captureWithToken(body, 'https://lazyreader.app/api/capture', undefined, fetchFn as any);
		expect(r).toEqual({ ok: false, status: 401, error: 'not-connected' });
		expect(fetchFn).not.toHaveBeenCalled();
		expect(tabsCreate).not.toHaveBeenCalled();
	});
	it('a 401 from the server: not-connected after exactly one request, no tab', async () => {
		const fetchFn = vi.fn(async () => new Response('{"error":"Unauthorized"}', { status: 401 }));
		const r = await captureWithToken(body, 'https://lazyreader.app/api/capture', 'a1b2c3d4e5f60718293a4b5c', fetchFn as any);
		expect(r).toEqual({ ok: false, status: 401, error: 'not-connected' });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(tabsCreate).not.toHaveBeenCalled();
	});
	it('a good save passes through', async () => {
		const fetchFn = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }));
		const r = await captureWithToken(body, 'https://lazyreader.app/api/capture', 'a1b2c3d4e5f60718293a4b5c', fetchFn as any);
		expect(r.ok).toBe(true);
	});
});
