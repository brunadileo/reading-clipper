// READ-38: the Authorization header YouTube's own web client sends on signed-in
// innertube calls ("SAPISIDHASH <time>_<sha1>"). The paging call of a Watch
// later list may refuse a cookie-only request without it.
//
// Privacy rules (plan choice 12): the SAPISID cookie is read here, in the
// background worker only, with the optional `cookies` permission. Only the
// derived header goes out, and only to youtube.com. The cookie and the header
// are never stored, logged, or sent to LazyReader.

export const YT_ORIGIN = 'https://www.youtube.com';

export interface CookieReader {
	get(details: { url: string; name: string }): Promise<{ value?: string } | null | undefined>;
}

/** Lowercase hex SHA-1 of a string. */
export async function sha1Hex(input: string, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
	const digest = await subtle.digest('SHA-1', new TextEncoder().encode(input));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** "SAPISIDHASH <seconds>_<sha1(seconds SAPISID origin)>". */
export async function sapisidHash(sapisid: string, origin: string, nowMs: number, subtle?: SubtleCrypto): Promise<string> {
	const ts = Math.floor(nowMs / 1000);
	return `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapisid} ${origin}`, subtle)}`;
}

/** The SAPISID cookie value, falling back to __Secure-3PAPISID. null when absent or unreadable. */
export async function readSapisid(cookies: CookieReader | undefined | null): Promise<string | null> {
	if (!cookies) return null;
	for (const name of ['SAPISID', '__Secure-3PAPISID']) {
		try {
			const c = await cookies.get({ url: YT_ORIGIN + '/', name });
			if (c && typeof c.value === 'string' && c.value) return c.value;
		} catch {
			// No permission or no cookie: try the next name.
		}
	}
	return null;
}

/** The header value for a signed-in call, or null when the cookie cannot be read. */
export async function buildAuthorization(cookies: CookieReader | undefined | null, nowMs: number, subtle?: SubtleCrypto): Promise<string | null> {
	const sapisid = await readSapisid(cookies);
	return sapisid ? sapisidHash(sapisid, YT_ORIGIN, nowMs, subtle) : null;
}
