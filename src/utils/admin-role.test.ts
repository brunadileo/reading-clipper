import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchIsAdmin } from './admin-role';

const URL = 'https://lazyreader.app/api/capture';
const reply = (status: number, body: any, bad = false) =>
	vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => { if (bad) throw new Error('not json'); return body; } }) as any) as any;

afterEach(() => vi.restoreAllMocks());

describe('fetchIsAdmin', () => {
	it('is true for role admin, plain or wrapped in data', async () => {
		expect(await fetchIsAdmin(URL, 't', reply(200, { role: 'admin' }))).toBe(true);
		expect(await fetchIsAdmin(URL, 't', reply(200, { data: { role: 'admin' } }))).toBe(true);
	});
	it('sends the token to getMyProfile', async () => {
		const f = reply(200, { role: 'user' });
		expect(await fetchIsAdmin(URL, 'tok', f)).toBe(false);
		expect(f.mock.calls[0][0]).toBe('https://lazyreader.app/api/getMyProfile');
		expect(f.mock.calls[0][1].headers['x-reader-token']).toBe('tok');
	});
	it('fails closed on every odd input', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await fetchIsAdmin(URL, '', reply(200, { role: 'admin' }))).toBe(false);
		expect(await fetchIsAdmin('not a url', 't', reply(200, { role: 'admin' }))).toBe(false);
		expect(await fetchIsAdmin('', 't', reply(200, { role: 'admin' }))).toBe(false);
		expect(await fetchIsAdmin(URL, 't', reply(401, { role: 'admin' }))).toBe(false);
		expect(await fetchIsAdmin(URL, 't', reply(200, null))).toBe(false);
		expect(await fetchIsAdmin(URL, 't', reply(200, { role: 'ADMIN' }))).toBe(false);
		expect(await fetchIsAdmin(URL, 't', reply(200, { role: ['admin'] }))).toBe(false);
		expect(await fetchIsAdmin(URL, 't', reply(200, {}, true))).toBe(false);
		expect(await fetchIsAdmin(URL, 't', vi.fn(async () => { throw new Error('offline'); }) as any)).toBe(false);
	});
	it('logs a failure instead of swallowing it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await fetchIsAdmin(URL, 't', vi.fn(async () => { throw new Error('offline'); }) as any);
		await fetchIsAdmin(URL, 't', reply(500, {}));
		expect(warn).toHaveBeenCalledTimes(2);
	});
});
