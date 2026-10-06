// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ order: [] as string[], grant: true, lastRequest: undefined as any }));
vi.mock('../utils/browser-polyfill', () => ({
	default: {
		permissions: { request: vi.fn((arg: unknown) => { h.order.push('request'); h.lastRequest = arg; return Promise.resolve(h.grant); }) },
		runtime: { sendMessage: vi.fn(async (m: any) => { h.order.push(`send:${m.action}`); return { ok: true }; }) },
		storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) }, onChanged: { addListener: vi.fn() } },
	},
}));

vi.mock('../utils/offscreen-doc', () => ({ offscreenSupported: () => true }));

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
			+ ['substack', 'instagram', 'medium', 'youtube'].map((s) => `<div class="checkbox-container"><input type="checkbox" id="sync-${s}-toggle"/></div><button id="sync-${s}-older"></button><button id="sync-${s}-run" hidden></button><div id="sync-${s}-status"></div>`).join('');
		initializeSyncSettings();
	});
	const flip = async (service: string) => {
		const t = document.getElementById(`sync-${service}-toggle`) as HTMLInputElement;
		t.checked = true;
		t.dispatchEvent(new Event('change'));
		// Synchronous, before any await: the request must happen inside the click.
		expect(h.order[0]).toBe('request');
		expect(confirm).not.toHaveBeenCalled();
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
	it('Medium: request first, then its confirm', async () => {
		await flip('medium');
		expect(h.order.slice(0, 3)).toEqual(['request', 'confirm', 'send:syncSetEnabled']);
		expect(h.lastRequest).toEqual({ origins: ['https://medium.com/*', 'https://*.medium.com/*'] });
	});
	it('Substack has no confirm', async () => {
		await flip('substack');
		expect(h.order.slice(0, 2)).toEqual(['request', 'send:syncSetEnabled']);
	});
});

describe('switch-on request contents', () => {
	beforeEach(() => {
		h.order.length = 0;
		h.grant = true;
		(window as any).confirm = vi.fn(() => true);
		document.body.innerHTML = ['sync-frequency', 'sync-all-now'].map((id) => `<div id="${id}"></div>`).join('')
			+ ['youtube'].map((s) => `<div class="checkbox-container"><input type="checkbox" id="sync-${s}-toggle"/></div><button id="sync-${s}-older"></button><button id="sync-${s}-run" hidden></button><div id="sync-${s}-status"></div>`).join('');
		initializeSyncSettings();
	});
	it('YouTube asks for its origins and the cookies permission', async () => {
		const t = document.getElementById('sync-youtube-toggle') as HTMLInputElement;
		t.checked = true;
		t.dispatchEvent(new Event('change'));
		expect(h.order[0]).toBe('request');
		expect(h.lastRequest).toEqual({ origins: ['https://www.youtube.com/*'], permissions: ['cookies'] });
	});
});
