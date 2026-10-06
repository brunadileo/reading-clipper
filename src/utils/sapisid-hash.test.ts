import { describe, it, expect } from 'vitest';
import { buildAuthorization, readSapisid, sapisidHash, sha1Hex } from './sapisid-hash';

const jar = (cookies: Record<string, string>, calls: string[] = []) => ({
	async get({ name }: { url: string; name: string }) {
		calls.push(name);
		return name in cookies ? { value: cookies[name] } : null;
	},
});

describe('sapisid-hash', () => {
	it('sha1 of a known string', async () => {
		expect(await sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
	});
	it('builds "SAPISIDHASH <seconds>_<sha1(seconds SAPISID origin)>"', async () => {
		const header = await sapisidHash('SECRET', 'https://www.youtube.com', 1_700_000_123_999);
		expect(header).toBe(`SAPISIDHASH 1700000123_${await sha1Hex('1700000123 SECRET https://www.youtube.com')}`);
	});
	it('reads SAPISID, falls back to __Secure-3PAPISID, else null', async () => {
		expect(await readSapisid(jar({ SAPISID: 'a', '__Secure-3PAPISID': 'b' }))).toBe('a');
		const calls: string[] = [];
		expect(await readSapisid(jar({ '__Secure-3PAPISID': 'b' }, calls))).toBe('b');
		expect(calls).toEqual(['SAPISID', '__Secure-3PAPISID']);
		expect(await readSapisid(jar({}))).toBeNull();
		expect(await readSapisid(undefined)).toBeNull();
		expect(await readSapisid({ get: async () => { throw new Error('no permission'); } })).toBeNull();
	});
	it('no header without a cookie, and the header never contains the cookie value', async () => {
		expect(await buildAuthorization(jar({}), 1000)).toBeNull();
		const h = await buildAuthorization(jar({ SAPISID: 'TOPSECRETVALUE' }), 5000);
		expect(h).toMatch(/^SAPISIDHASH 5_[0-9a-f]{40}$/);
		expect(h).not.toContain('TOPSECRETVALUE');
	});
});
