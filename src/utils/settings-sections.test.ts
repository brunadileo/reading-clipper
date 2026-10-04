import { describe, expect, test } from 'vitest';
import { DEFAULT_SECTION, resolveSection } from './settings-sections';

describe('resolveSection', () => {
	test.each(['connection', 'sync', 'shortcuts', 'about'])('keeps %s', (name) => {
		expect(resolveSection(name)).toBe(name);
	});

	test.each(['general', 'reader', 'highlighter', 'interpreter', 'properties', 'templates'])(
		'old section %s lands on connection',
		(name) => {
			expect(resolveSection(name)).toBe('connection');
		}
	);

	test('a template id, an empty value and a missing value land on connection', () => {
		expect(resolveSection('1712345678901')).toBe('connection');
		expect(resolveSection('')).toBe('connection');
		expect(resolveSection(null)).toBe('connection');
		expect(resolveSection(undefined)).toBe('connection');
	});

	test('is case sensitive and never matches inherited object keys', () => {
		expect(resolveSection('Sync')).toBe(DEFAULT_SECTION);
		expect(resolveSection('constructor')).toBe(DEFAULT_SECTION);
	});
});
