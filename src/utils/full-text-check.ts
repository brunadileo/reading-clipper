// READ-181: the clipper's copy of the server's "is this the whole article"
// check. It only decides whether to try the minimized-window fallback; the
// server is the one judge of "members only". Phrases are ported from
// lazyreader scripts/extract-local.py validate_text and widened (plan choice 1).
import { PREVIEW_NOTE } from './substack-sync';
import { countWords } from './sync-core';

export type FullTextCheck = { ok: true } | { ok: false; reason: 'wall' | 'teaser' | 'empty' };

const WALL_PREFIXES = [
	'just a moment', 'enable javascript', 'log in to continue', 'sign in to continue',
	'verify you are human', 'access denied',
];
const END_WALL = /(subscribe|sign in|join medium|become a member) to (continue reading|read (the full|the rest of this|this) (article|story))/i;
const PHRASES = [
	'create an account to read the full story',
	'available to medium members only',
	'this post is for paid subscribers',
	'upgrade to paid',
	'subscribe to keep reading',
];

export function checkFullText(text: string): FullTextCheck {
	const t = (text ?? '').trim();
	if (!t) return { ok: false, reason: 'empty' };
	if (t.endsWith(PREVIEW_NOTE.trim())) return { ok: false, reason: 'teaser' };
	const words = countWords(t);
	const head = t.slice(0, 600).toLowerCase();
	const tail = t.slice(-500).toLowerCase();
	if (words < 400 && WALL_PREFIXES.some((p) => head.startsWith(p))) return { ok: false, reason: 'wall' };
	if (END_WALL.test(t.slice(-500))) return { ok: false, reason: 'wall' };
	if (PHRASES.some((p) => head.includes(p) || tail.includes(p))) return { ok: false, reason: 'wall' };
	return { ok: true };
}

/**
 * The better of two texts: more words among those that pass the check, else
 * the longer one. Returns '' when both are empty.
 */
export function pickBestText(a: string, b: string): string {
	const aOk = checkFullText(a).ok;
	const bOk = checkFullText(b).ok;
	if (aOk && bOk) return countWords(a) >= countWords(b) ? a : b;
	if (aOk) return a;
	if (bOk) return b;
	return countWords(a) >= countWords(b) ? a : b;
}

/** https only; no localhost, private or link-local address, credentials or bare hostnames. */
export function isSafeFetchUrl(raw: string): boolean {
	let u: URL;
	try { u = new URL(raw); } catch { return false; }
	if (u.protocol !== 'https:') return false;
	if (u.username || u.password) return false;
	const h = u.hostname.toLowerCase();
	if (!h || h.startsWith('[') || !h.includes('.')) return false;
	if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return false;
	const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
	}
	return true;
}
