import { describe, it, expect } from 'vitest';
import { buildReadingCaptureBody, stripLeadingFrontmatter } from './reading-sender';

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

	it('strips a leading frontmatter block out of the text before sending', () => {
		const withFrontmatter = '---\ntitle: "My Article"\nsite: "Example Site"\n---\nThe actual article body.';

		const body = buildReadingCaptureBody({
			url: 'https://example.com/article',
			lane: 'read-now',
			title: 'My Article',
			siteName: 'Example Site',
			text: withFrontmatter,
		});

		expect(body.text).toBe('The actual article body.');
		expect(body.text).not.toContain('---');
		expect(body.text).not.toContain('title:');
	});
});

describe('stripLeadingFrontmatter', () => {
	it('removes a leading --- delimited block', () => {
		expect(stripLeadingFrontmatter('---\nfoo: bar\n---\nBody.')).toBe('Body.');
	});

	it('leaves text with no frontmatter untouched', () => {
		expect(stripLeadingFrontmatter('Just body text.')).toBe('Just body text.');
	});

	it('does not strip a --- that appears mid-document', () => {
		const text = 'Intro.\n\n---\n\nMore text.';
		expect(stripLeadingFrontmatter(text)).toBe(text);
	});
});
