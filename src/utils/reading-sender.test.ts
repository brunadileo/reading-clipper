import { describe, it, expect } from 'vitest';
import { buildReadingCaptureBody, fitReadingText, MAX_READING_TEXT_BYTES, READING_TEXT_CUT_NOTE } from './reading-sender';

describe('buildReadingCaptureBody', () => {
	it('maps title and site name, keeps url and lane as given', () => {
		const body = buildReadingCaptureBody({
			url: 'https://example.com/article',
			lane: 'read-now',
			title: 'My Article',
			siteName: 'Example Site',
			text: 'Some article body text.',
		});

		expect(body).toEqual({
			url: 'https://example.com/article',
			lane: 'read-now',
			title: 'My Article',
			site_name: 'Example Site',
			text: 'Some article body text.',
		});
	});

	it('drops the text key entirely when the body is empty', () => {
		const body = buildReadingCaptureBody({
			url: 'https://example.com/article',
			lane: 'read-later',
			title: 'My Article',
			siteName: 'Example Site',
			text: '',
		});

		expect(body).not.toHaveProperty('text');
	});

	it('drops the text key when the body is whitespace only', () => {
		const body = buildReadingCaptureBody({
			url: 'https://example.com/article',
			lane: 'file-it',
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
			lane: 'read-now',
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
		const text = 'word '.repeat(14000);
		const fitted = fitReadingText(text);
		expect(bytes(fitted)).toBeLessThanOrEqual(MAX_READING_TEXT_BYTES);
		expect(fitted.endsWith(READING_TEXT_CUT_NOTE)).toBe(true);
		expect(text.startsWith(fitted.slice(0, -READING_TEXT_CUT_NOTE.length))).toBe(true);
	});

	it('counts bytes, so accented and multi-byte text stays under the limit whole-character', () => {
		const text = 'ação 日本語 '.repeat(4000);
		const fitted = fitReadingText(text);
		expect(bytes(fitted)).toBeLessThanOrEqual(MAX_READING_TEXT_BYTES);
		expect(fitted).not.toContain('�');
	});

	it('cuts at a paragraph end when one is near the limit', () => {
		const paragraph = 'x'.repeat(999) + '\n\n';
		const fitted = fitReadingText(paragraph.repeat(30));
		const body = fitted.slice(0, -READING_TEXT_CUT_NOTE.length);
		expect(body.endsWith('x')).toBe(true);
		expect(body.length % 1001).toBe(999);
	});

	it('finds paragraph breaks that carry spaces, as defuddle writes them', () => {
		const paragraph = 'y'.repeat(997) + '  \n  \n';
		const fitted = fitReadingText(paragraph.repeat(30));
		const body = fitted.slice(0, -READING_TEXT_CUT_NOTE.length);
		expect(body.endsWith('y')).toBe(true);
	});

	it('buildReadingCaptureBody sends the cut text', () => {
		const body = buildReadingCaptureBody({
			url: 'https://example.com/long',
			lane: 'read-later',
			title: 'Long',
			siteName: 'Example',
			text: 'word '.repeat(14000),
		});
		expect(bytes(body.text!)).toBeLessThanOrEqual(MAX_READING_TEXT_BYTES);
	});
});
