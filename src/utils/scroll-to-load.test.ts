import { describe, test, expect } from 'vitest';
import { isLazyHost, pickScrollers } from './scroll-to-load';

function fakeDoc(opts: { inner?: any; notion?: any }) {
	const root = { scrollHeight: 5000, clientHeight: 800, scrollTop: 0 };
	const scope = { querySelectorAll: () => (opts.inner ? [opts.inner] : []) };
	const doc: any = {
		scrollingElement: root,
		querySelector: (sel: string) => (sel === '.notion-scroller' ? opts.notion || null : sel === 'main' ? scope : null),
		body: scope,
	};
	return { doc: doc as Document, root };
}

describe('isLazyHost', () => {
	test('matches notion hosts only', () => {
		expect(isLazyHost('notion.so')).toBe(true);
		expect(isLazyHost('www.notion.so')).toBe(true);
		expect(isLazyHost('team.notion.site')).toBe(true);
		expect(isLazyHost('example.com')).toBe(false);
		expect(isLazyHost('notion.so.evil.com')).toBe(false);
	});
});

describe('pickScrollers', () => {
	test('normal article with only the root scroller is skipped', () => {
		const { doc } = fakeDoc({});
		expect(pickScrollers(doc, 'example.com')).toEqual([]);
	});

	test('lazy host scrolls the root', () => {
		const { doc, root } = fakeDoc({});
		expect(pickScrollers(doc, 'www.notion.so')).toEqual([root]);
	});

	test('inner .notion-scroller is scrolled on any host, root excluded off lazy hosts', () => {
		const notion = { scrollHeight: 9000, clientHeight: 700, scrollTop: 0 };
		const { doc, root } = fakeDoc({ notion });
		expect(pickScrollers(doc, 'example.com')).toEqual([notion]);
		expect(pickScrollers(doc, 'x.notion.site')).toEqual([root, notion]);
	});

	test('inner overflow scroller is picked on a normal host', () => {
		(globalThis as any).getComputedStyle = () => ({ overflowY: 'auto' });
		const inner = { scrollHeight: 4000, clientHeight: 600, scrollTop: 0 };
		const { doc } = fakeDoc({ inner });
		expect(pickScrollers(doc, 'app.example.com')).toEqual([inner]);
		delete (globalThis as any).getComputedStyle;
	});
});
