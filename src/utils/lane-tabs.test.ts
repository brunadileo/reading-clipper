// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderLaneTabs, syncLaneTabs } from './lane-tabs';

const LANES = [
	{ value: 'read-now', label: 'Read now' },
	{ value: 'read-later', label: 'Read later' },
	{ value: 'file-it', label: 'File it' }
];

let container: HTMLElement;
let select: HTMLSelectElement;
const tabs = () => Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'));

beforeEach(() => {
	document.body.innerHTML = '<div id="lane-tabs" role="radiogroup"></div><select id="vault-select"></select>';
	container = document.getElementById('lane-tabs') as HTMLElement;
	select = document.getElementById('vault-select') as HTMLSelectElement;
	LANES.forEach(l => select.add(new Option(l.label, l.value)));
	select.value = 'read-now';
	renderLaneTabs(container, select, LANES);
});

describe('lane tabs (READ-236)', () => {
	it('renders one radio per lane, the select value checked and in the tab order', () => {
		expect(tabs().map(t => t.textContent)).toEqual(['Read now', 'Read later', 'File it']);
		expect(tabs().map(t => t.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
		expect(tabs().map(t => t.tabIndex)).toEqual([0, -1, -1]);
	});

	it('a click writes the lane into #vault-select and fires change', () => {
		const onChange = vi.fn();
		select.addEventListener('change', onChange);
		tabs()[1].click();
		expect(select.value).toBe('read-later');
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(tabs()[1].getAttribute('aria-checked')).toBe('true');
		expect(tabs()[0].getAttribute('aria-checked')).toBe('false');
	});

	it('arrow keys move the choice, wrap around, and Home/End jump', () => {
		const press = (el: HTMLElement, key: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
		press(tabs()[0], 'ArrowRight');
		expect(select.value).toBe('read-later');
		press(tabs()[1], 'ArrowRight');
		expect(select.value).toBe('file-it');
		press(tabs()[2], 'ArrowRight');
		expect(select.value).toBe('read-now');
		press(tabs()[0], 'ArrowLeft');
		expect(select.value).toBe('file-it');
		press(tabs()[2], 'Home');
		expect(select.value).toBe('read-now');
		press(tabs()[0], 'End');
		expect(select.value).toBe('file-it');
		expect(document.activeElement).toBe(tabs()[2]);
	});

	it('follows a change made on the select, and syncLaneTabs follows a silent value set', () => {
		select.value = 'file-it';
		select.dispatchEvent(new Event('change'));
		expect(tabs()[2].getAttribute('aria-checked')).toBe('true');
		select.value = 'read-later';
		syncLaneTabs(container, select);
		expect(tabs()[1].getAttribute('aria-checked')).toBe('true');
		expect(tabs()[1].tabIndex).toBe(0);
	});
});
