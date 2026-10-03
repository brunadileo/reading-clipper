import { beforeEach, describe, expect, it } from 'vitest';
import { ensureOffscreen, releaseOffscreen } from './offscreen-doc';

let open = false;
const calls: string[] = [];
(globalThis as any).chrome = {
	runtime: {
		getManifest: () => ({ permissions: ['offscreen'] }),
		getContexts: async () => (open ? [{}] : []),
	},
	offscreen: {
		createDocument: async () => { calls.push('create'); open = true; },
		closeDocument: async () => { calls.push('close'); open = false; },
	},
};

beforeEach(() => {
	open = false;
	calls.length = 0;
});

describe('shared offscreen document', () => {
	it('stays open while another job still uses it', async () => {
		await ensureOffscreen('finish');
		await ensureOffscreen('token');
		await releaseOffscreen('token');
		expect(open).toBe(true);
		await releaseOffscreen('finish');
		expect(open).toBe(false);
		expect(calls).toEqual(['create', 'close']);
	});

	it('a release queued before an ensure does not close the new user out', async () => {
		await ensureOffscreen('finish');
		const closing = releaseOffscreen('finish');
		const opening = ensureOffscreen('token');
		await Promise.all([closing, opening]);
		expect(open).toBe(true);
		await releaseOffscreen('token');
	});
});
