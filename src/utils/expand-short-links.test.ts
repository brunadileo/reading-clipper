// @vitest-environment jsdom
import { describe, test, expect } from 'vitest';
import { expandShortenedLinks, expandedLink, isXHost } from './expand-short-links';

// The anchors of the long post behind item 4a5ba369 (read in a logged-in Chrome, 2026-10-11).
const POST = `<div>
<p>1. <a href="http://github.com/imputnet/cobalt">github.com/imputnet/cobalt</a></p>
<p>3. <a href="http://github.com/AmruthPillai/Reactive-Resume" class="x-link">github.com/AmruthPillai/R…</a></p>
<p>4. <a href="http://github.com/dgtlmoon/changedetection.io" class="x-link">github.com/dgtlmoon/chang…</a></p>
<p>5. <a href="http://github.com/Suwayomi/Suwayomi-Server">github.com/Suwayomi/Suway<span>…</span></a></p>
</div>`;

describe('expandedLink', () => {
	test('a display form cut with an ellipsis becomes the href', () => {
		expect(expandedLink('github.com/AmruthPillai/R…', 'http://github.com/AmruthPillai/Reactive-Resume')).toBe('http://github.com/AmruthPillai/Reactive-Resume');
		expect(expandedLink('github.com/a/b...', 'https://www.github.com/a/bcd')).toBe('https://www.github.com/a/bcd');
	});
	test('a whole link, other text, or text that is not the start of the href is left alone', () => {
		expect(expandedLink('github.com/imputnet/cobalt', 'http://github.com/imputnet/cobalt')).toBeNull();
		expect(expandedLink('Read more…', 'http://github.com/a/b')).toBeNull();
		expect(expandedLink('github.com/other/r…', 'http://github.com/a/b')).toBeNull();
		expect(expandedLink('…', 'http://github.com/a/b')).toBeNull();
		expect(expandedLink('github.com/a/b…', '/relative/path')).toBeNull();
		expect(expandedLink('github.com/a/b…', 'javascript:alert(1)')).toBeNull();
	});
});

describe('expandShortenedLinks', () => {
	test('on x.com every cut link shows its full address, and the undo puts the page back', () => {
		document.body.innerHTML = POST;
		const before = document.body.innerHTML;
		const undo = expandShortenedLinks(document, 'https://x.com/sentient_agency/status/2098719224252514744');
		const text = document.body.textContent || '';
		expect(text).toContain('http://github.com/AmruthPillai/Reactive-Resume');
		expect(text).toContain('http://github.com/dgtlmoon/changedetection.io');
		expect(text).toContain('http://github.com/Suwayomi/Suwayomi-Server');
		expect(text).not.toContain('…');
		expect(text).toContain('github.com/imputnet/cobalt');
		undo();
		expect(document.body.innerHTML).toBe(before);
	});
	test('on any other site nothing changes', () => {
		document.body.innerHTML = POST;
		const before = document.body.innerHTML;
		expandShortenedLinks(document, 'https://example.com/post')();
		expect(document.body.innerHTML).toBe(before);
		expandShortenedLinks(document, 'https://example.com/post');
		expect(document.body.innerHTML).toBe(before);
	});
	test('isXHost', () => {
		expect(isXHost('https://x.com/a')).toBe(true);
		expect(isXHost('https://mobile.twitter.com/a')).toBe(true);
		expect(isXHost('https://notx.com/a')).toBe(false);
		expect(isXHost('not a url')).toBe(false);
	});
});
