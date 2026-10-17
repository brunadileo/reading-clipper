import { describe, test, expect } from 'vitest';
import { makeDeps, readFeedInWindow } from './waiting-runner';

describe('waiting-runner makeDeps', () => {
	test('wires the feed window reader so a 403 can open it', async () => {
		const deps = await makeDeps();
		expect(deps.readFeedInWindow).toBe(readFeedInWindow);
	});
});
