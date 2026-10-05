import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/browser-polyfill', () => ({ default: { tabs: { create: vi.fn() }, storage: { onChanged: { addListener: vi.fn() } } } }));
vi.mock('../utils/storage-utils', () => ({
	DEFAULT_READING_CAPTURE_URL: 'https://lazyreader.app/api/capture',
	loadReadingSettings: async () => ({ token: '', captureUrl: '' }),
	saveReadingSettings: async () => {},
}));

import { describeConnection } from './connection-settings';

describe('describeConnection', () => {
	it('connected: status and a way to open Lazy Reader', () => {
		const v = describeConnection('a1b2c3d4e5f60718293a4b5c');
		expect(v.connected).toBe(true);
		expect(v.title).toBe('Connected to Lazy Reader');
		expect(v.action).toBe('Open Lazy Reader');
	});
	it('not connected: Sign in with Lazy Reader and the Connect this browser hint', () => {
		for (const token of ['', '   ']) {
			const v = describeConnection(token);
			expect(v.connected).toBe(false);
			expect(v.title).toBe('Not connected');
			expect(v.action).toBe('Sign in with Lazy Reader');
			expect(v.hint).toBe('Opens lazyreader.app. Press Connect this browser there.');
		}
	});
});
