import { describe, it, expect, afterEach } from 'vitest';
import { collectListPage } from './medium-collect';

type Zone = 'main' | 'side';
type Entry = [href: string, text: string, zone?: Zone];

// A tiny stand-in for the list page: links appear in batches as the page is "scrolled".
function fakePage(batches: Entry[][], over: { title?: string; path?: string; main?: boolean } = {}) {
	let shown = 1;
	const body: any = { parentElement: null, contains: () => true };
	const box = (): any => { const el: any = { parentElement: body, contains: (a: any) => a.parentElement === el }; return el; };
	const containers: Record<Zone, any> = { main: box(), side: box() };
	const anchors = () => batches.slice(0, shown).flat().map(([href, text, zone = 'main']) => ({
		getAttribute: () => href,
		textContent: text,
		zone,
		parentElement: containers[zone],
	}));
	const list = (arr: any[]) => ({ forEach: (fn: (a: any) => void) => arr.forEach(fn), [Symbol.iterator]: () => arr[Symbol.iterator](), length: arr.length });
	const mainEl = over.main === false ? null : { querySelectorAll: () => list(anchors().filter((a) => a.zone === 'main')) };
	(globalThis as any).document = {
		title: over.title ?? 'Reading list',
		documentElement: { scrollHeight: 1000 },
		querySelector: (sel: string) => (sel === 'main' ? mainEl : null),
		querySelectorAll: () => list(anchors()),
	};
	(globalThis as any).location = { href: 'https://medium.com/@testreader/list/reading-list', pathname: over.path ?? '/@testreader/list/reading-list' };
	(globalThis as any).window = { scrollTo: () => { shown = Math.min(batches.length, shown + 1); } };
}

afterEach(() => {
	delete (globalThis as any).document;
	delete (globalThis as any).location;
	delete (globalThis as any).window;
});

const id = (n: number) => (0x100000000000 + n).toString(16);
const link = (n: number, text = `Story ${n}`, zone: Zone = 'main'): Entry => [`/@someauthor/story-${n}-${id(n)}?source=list`, text, zone];

describe('collectListPage', () => {
	it('scrolls until no new links appear, skips known ids, strips queries, keeps the longest title', async () => {
		fakePage([[link(1, ''), link(1, 'Story one'), link(2)], [link(3)], [link(4)]]);
		const r = await collectListPage(100, [id(2)], Infinity, 0);
		expect(r.ended).toBe(true);
		expect(r.total).toBe(4);
		expect(r.posts.map((p) => p.postId)).toEqual([id(1), id(3), id(4)]);
		expect(r.posts[0]).toEqual({ postId: id(1), title: 'Story one', url: `https://medium.com/@someauthor/story-1-${id(1)}` });
	});
	it('stops as soon as it has the number asked for', async () => {
		fakePage([[link(1), link(2)], [link(3), link(4)], [link(5), link(6)]]);
		const r = await collectListPage(3, [], Infinity, 0);
		expect(r.posts).toHaveLength(3);
		expect(r.ended).toBe(false);
	});
	it('accepts /p/<id> links, ignores list, tag and other links', async () => {
		fakePage([[
			[`https://medium.com/p/${id(7)}`, 'Short link'],
			[`/@testreader/list/my-list-${id(8)}`, 'A list'],
			['/tag/ai', 'Tag'],
			['/@someauthor', 'Author'],
			['http://medium.com/@a/x-' + id(9), 'insecure'],
		]]);
		const r = await collectListPage(10, [], Infinity, 0);
		expect(r.posts.map((p) => p.postId)).toEqual([id(7)]);
	});
	it('reads only inside <main>: sidebar and recommended stories stay out', async () => {
		fakePage([[link(1), link(2), link(50, 'Recommended', 'side'), link(51, 'Also recommended', 'side')]]);
		const r = await collectListPage(100, [], Infinity, 0);
		expect(r.posts.map((p) => p.postId)).toEqual([id(1), id(2)]);
		expect(r.total).toBe(2);
	});
	it('without a <main> it uses the element that holds most of the post links', async () => {
		const mainLinks = Array.from({ length: 10 }, (_, i) => link(i + 1));
		fakePage([[...mainLinks, link(50, 'Recommended', 'side'), link(51, 'Also recommended', 'side')]], { main: false });
		const r = await collectListPage(100, [], Infinity, 0);
		expect(r.total).toBe(10);
		expect(r.posts.some((p) => p.postId === id(50))).toBe(false);
	});
	it('never collects more than the list count', async () => {
		fakePage([[link(1), link(2), link(3), link(4)]]);
		const r = await collectListPage(100, [], 3, 0);
		expect(r.total).toBe(3);
		expect(r.posts).toHaveLength(3);
	});
	it('gives up scrolling when the time budget is spent', async () => {
		fakePage([[link(1)], [link(2)], [link(3)], [link(4)], [link(5)]]);
		const r = await collectListPage(100, [], Infinity, 5, 12);
		expect(r.total).toBeLessThan(5);
		expect(r.ended).toBe(true);
	});
	it('reports a Cloudflare challenge or sign-in page as blocked', async () => {
		fakePage([[link(1)]], { title: 'Just a moment...' });
		expect((await collectListPage(10, [], Infinity, 0)).blocked).toBe(true);
		fakePage([[link(1)]], { path: '/m/signin' });
		expect((await collectListPage(10, [], Infinity, 0)).blocked).toBe(true);
	});
});
