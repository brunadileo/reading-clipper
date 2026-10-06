// READ-36: runs INSIDE a Medium list page (chrome.scripting.executeScript with
// func + args), so it must stay self-contained: no imports, no outer helpers.
// It scrolls the page so Medium's own JS loads the next items, and reads post
// ids, titles and links from the rendered links. The DOM is [assumed], so it
// leans on no data-testid: any link whose path ends in -<12 hex> or /p/<12 hex>
// counts, but only inside <main> (or, without one, the element holding most of
// those links), so sidebar and recommended stories stay out. It sends no
// request of its own and never clicks anything.
export interface CollectedList {
	posts: Array<{ postId: string; title: string; url: string }>;
	total: number;
	ended: boolean;
	blocked?: boolean;
}

export async function collectListPage(wantNew: number, knownPostIds: string[], maxTotal = Infinity, stepMs = 1200, budgetMs = 90_000): Promise<CollectedList> {
	const known = new Set(knownPostIds);
	const seen = new Map<string, { postId: string; title: string; url: string }>();
	const title = (document.title || '').trim().toLowerCase();
	if (title.startsWith('just a moment') || /^\/(m\/)?signin/.test(location.pathname)) {
		return { posts: [], total: 0, ended: true, blocked: true };
	}

	const parse = (a: any) => {
		let u: URL;
		try { u = new URL(a.getAttribute('href') || '', location.href); } catch { return null; }
		if (u.protocol !== 'https:') return null;
		const path = u.pathname.replace(/\/+$/, '');
		if (/\/list\//.test(path) || /\/(tag|topic|m|me|plans|membership)(\/|$)/.test(path)) return null;
		const m = path.match(/-([0-9a-f]{12})$/i) || path.match(/\/p\/([0-9a-f]{12})$/i);
		if (!m) return null;
		return { postId: m[1].toLowerCase(), url: `${u.origin}${path}`, text: (a.textContent || '').replace(/\s+/g, ' ').trim() };
	};

	// The anchors of the list itself: inside <main>, else inside the ancestor that holds most post links.
	const listAnchors = (): any[] => {
		const main = document.querySelector('main');
		if (main) return Array.from(main.querySelectorAll('a[href]') as ArrayLike<any>);
		const all: any[] = [];
		document.querySelectorAll('a[href]').forEach((a: any) => { if (parse(a)) all.push(a); });
		if (all.length === 0) return [];
		const counts = new Map<any, number>();
		for (const a of all) for (let el = a.parentElement; el; el = el.parentElement) counts.set(el, (counts.get(el) || 0) + 1);
		let best: any = null;
		let bestDepth = -1;
		counts.forEach((n, el) => {
			if (n < all.length * 0.6) return;
			let d = 0;
			for (let p = el; p; p = p.parentElement) d++;
			if (d > bestDepth) { best = el; bestDepth = d; }
		});
		return best ? all.filter((a) => best.contains ? best.contains(a) : true) : all;
	};

	const scan = () => {
		for (const a of listAnchors()) {
			const p = parse(a);
			if (!p) continue;
			const prev = seen.get(p.postId);
			if (!prev) {
				if (seen.size >= maxTotal) continue;
				seen.set(p.postId, { postId: p.postId, title: p.text, url: p.url });
			} else if (p.text.length > prev.title.length) prev.title = p.text; // the first link is often the card image (no text)
		}
	};
	const fresh = () => [...seen.values()].filter((p) => !known.has(p.postId));

	const startedAt = Date.now();
	let stalled = 0;
	let last = -1;
	for (;;) {
		scan();
		if (fresh().length >= wantNew || seen.size >= maxTotal) break;
		if (seen.size === last) stalled++; else stalled = 0;
		last = seen.size;
		if (stalled >= 3 || Date.now() - startedAt > budgetMs) break;
		window.scrollTo(0, document.documentElement.scrollHeight);
		await new Promise((r) => setTimeout(r, stepMs));
	}
	scan();
	const posts = fresh().slice(0, wantNew);
	return { posts, total: seen.size, ended: fresh().length < wantNew };
}
