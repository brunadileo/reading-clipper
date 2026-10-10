import { describe, expect, it } from 'vitest';
import { defuddleOptions } from './store-build';

describe('defuddleOptions (READ-48)', () => {
	it('turns off third-party fetches in the store build', () => {
		expect(defuddleOptions('https://x.com/a/status/1', true)).toEqual({ url: 'https://x.com/a/status/1', useAsync: false });
	});
	it('leaves the default build as it was', () => {
		expect(defuddleOptions('https://x.com/a/status/1', false)).toEqual({ url: 'https://x.com/a/status/1' });
	});
});
