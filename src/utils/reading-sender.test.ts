import { describe, it, expect } from 'vitest';
import { buildReadingCaptureBody } from './reading-sender';

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
