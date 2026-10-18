// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { linkTextOf, findLinkTextByUrl, selectionInsideAnchor } from './list-link-text';

beforeEach(() => { document.body.innerHTML = ''; });

describe('linkTextOf', () => {
	it('null and undefined give empty', () => {
		expect(linkTextOf(null)).toBe('');
		expect(linkTextOf(undefined)).toBe('');
	});
	it('collapses whitespace', () => {
		document.body.innerHTML = '<a id="a" href="https://a.com">  karakeep-app/\n   karakeep </a>';
		expect(linkTextOf(document.getElementById('a'))).toBe('karakeep-app/ karakeep');
	});
	it('falls back to image alt, then aria-label (EC-10)', () => {
		document.body.innerHTML = '<a id="a" href="x"><img alt="Logo"></a><a id="b" href="x" aria-label="Home"><img></a><a id="c" href="x"><img></a>';
		expect(linkTextOf(document.getElementById('a'))).toBe('Logo');
		expect(linkTextOf(document.getElementById('b'))).toBe('Home');
		expect(linkTextOf(document.getElementById('c'))).toBe('');
	});
	it('keeps unicode and script text as text, capped at 300', () => {
		document.body.innerHTML = `<a id="a" href="x">Café &lt;script&gt;</a><a id="b" href="x">${'x'.repeat(900)}</a>`;
		expect(linkTextOf(document.getElementById('a'))).toBe('Café <script>');
		expect(linkTextOf(document.getElementById('b')).length).toBe(300);
	});
});

describe('findLinkTextByUrl', () => {
	it('finds the first anchor with that address and text', () => {
		document.body.innerHTML = '<a href="https://a.com/x"><img></a><a href="https://a.com/x">Second</a><a href="https://b.com">Other</a>';
		expect(findLinkTextByUrl(document, 'https://a.com/x')).toBe('Second');
	});
	it('empty when there is no match, no url or a wrong type', () => {
		document.body.innerHTML = '<a href="https://a.com/x">A</a>';
		expect(findLinkTextByUrl(document, 'https://nope.com')).toBe('');
		expect(findLinkTextByUrl(document, '')).toBe('');
		expect(findLinkTextByUrl(document, undefined as any)).toBe('');
	});
});

describe('selectionInsideAnchor', () => {
	const select = (node: Node, from: number, to: number) => {
		const r = document.createRange();
		r.setStart(node, from);
		r.setEnd(node, to);
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		sel.addRange(r);
		return sel;
	};
	it('takes a selection inside the link', () => {
		document.body.innerHTML = '<p id="p">Elsewhere</p><a id="a" href="https://a.com">Link title here</a>';
		const a = document.getElementById('a')!;
		expect(selectionInsideAnchor(select(a.firstChild!, 0, 10), a)).toBe('Link title');
	});
	it('ignores a selection elsewhere on the page', () => {
		document.body.innerHTML = '<p id="p">Elsewhere</p><a id="a" href="https://a.com">Link</a>';
		const p = document.getElementById('p')!;
		expect(selectionInsideAnchor(select(p.firstChild!, 0, 5), document.getElementById('a'))).toBe('');
	});
	it('ignores a selection that only starts inside the link', () => {
		document.body.innerHTML = '<div id="d"><a id="a" href="https://a.com">Link</a> and more</div>';
		const d = document.getElementById('d')!;
		expect(selectionInsideAnchor(select(d, 0, 2), document.getElementById('a'))).toBe('');
	});
	it('empty for no selection, no anchor or null', () => {
		document.body.innerHTML = '<a id="a" href="x">L</a>';
		window.getSelection()!.removeAllRanges();
		expect(selectionInsideAnchor(window.getSelection(), document.getElementById('a'))).toBe('');
		expect(selectionInsideAnchor(null, document.getElementById('a'))).toBe('');
		expect(selectionInsideAnchor(window.getSelection(), null)).toBe('');
	});
});
