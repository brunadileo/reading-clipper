// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ order: [] as string[], grant: true }));
vi.mock('../utils/browser-polyfill', () => ({
	default: {
		permissions: { request: vi.fn(() => { h.order.push('request'); return Promise.resolve(h.grant); }) },
		runtime: { sendMessage: vi.fn(async (m: any) => { h.order.push(`send:${m.action}`); return { ok: true }; }) },
		storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) }, onChanged: { addListener: vi.fn() } },
	},
}));

import { initializeSyncSettings, switchOnQuestion } from './sync-settings';

describe('switch-on cost question', () => {
	it('is asked for Medium, Instagram and a never-run YouTube, not for Substack', () => {
		expect(switchOnQuestion('medium', false)).toContain('Turn Medium on?');
		expect(switchOnQuestion('instagram', false)).toContain('Turn Instagram on?');
		expect(switchOnQuestion('youtube', true)).toContain('Turn YouTube on?');
		expect(switchOnQuestion('youtube', false)).toBeNull();
		expect(switchOnQuestion('substack', true)).toBeNull();
	});
});

describe('switch-on order (READ-250 choice 3)', () => {
	let confirm: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		h.order.length = 0;
		h.grant = true;
		confirm = vi.fn(() => { h.order.push('confirm'); return true; });
		vi.stubGlobal('confirm', confirm);
		(window as any).confirm = confirm;
		document.body.innerHTML = ['sync-frequency', 'sync-all-now'].map((id) => `<div id="${id}"></div>`).join('')
			+ ['substack', 'instagram'].map((s) => `<div class="checkbox-container"><input type="checkbox" id="sync-${s}-toggle"/></div><button id="sync-${s}-older"></button><button id="sync-${s}-run" hidden></button><div id="sync-${s}-status"></div>`).join('');
		initializeSyncSettings();
	});
	const flip = async (service: string) => {
		const t = document.getElementById(`sync-${service}-toggle`) as HTMLInputElement;
		t.checked = true;
		t.dispatchEvent(new Event('change'));
		await new Promise((r) => setTimeout(r, 0));
		return t;
	};

	it('asks Chrome for access first, in the click, then shows the confirm', async () => {
		await flip('instagram');
		expect(h.order.slice(0, 3)).toEqual(['request', 'confirm', 'send:syncSetEnabled']);
	});
	it('a declined confirm switches back off without enabling', async () => {
		confirm.mockImplementation(() => { h.order.push('confirm'); return false; });
		const t = await flip('instagram');
		expect(h.order).toEqual(['request', 'confirm']);
		expect(t.checked).toBe(false);
	});
	it('a refused permission shows no confirm and stays off', async () => {
		h.grant = false;
		const t = await flip('instagram');
		expect(h.order).toEqual(['request']);
		expect(t.checked).toBe(false);
	});
	it('Substack has no confirm', async () => {
		await flip('substack');
		expect(h.order.slice(0, 2)).toEqual(['request', 'send:syncSetEnabled']);
	});
});
