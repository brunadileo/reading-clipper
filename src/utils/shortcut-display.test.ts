import { describe, expect, test } from 'vitest';
import { shortcutKeys, SHORTCUT_ORDER, SHORTCUT_ROWS } from './shortcut-display';

describe('shortcutKeys', () => {
	test('splits Mac glyphs one key each', () => {
		expect(shortcutKeys('⇧⌘O')).toEqual(['⇧', '⌘', 'O']);
	});
	test('splits plus-separated names', () => {
		expect(shortcutKeys('Ctrl+Shift+O')).toEqual(['Ctrl', 'Shift', 'O']);
	});
	test('keeps a lone plus key', () => {
		expect(shortcutKeys('+')).toEqual(['+']);
	});
	test('empty or missing gives no keys', () => {
		expect(shortcutKeys('')).toEqual([]);
		expect(shortcutKeys(null)).toEqual([]);
	});
});

test('only the open and quick-save commands are listed', () => {
	expect(SHORTCUT_ORDER).toEqual(['_execute_action', 'quick_clip']);
	expect(Object.keys(SHORTCUT_ROWS).sort()).toEqual(['_execute_action', 'quick_clip']);
});
