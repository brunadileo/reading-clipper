import { describe, it, expect } from 'vitest';
import { acceptConnect, isPlausibleToken, parseConnectMessage, CONNECT_MESSAGE_TYPE } from './reading-token';

const GOOD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
const ID = 'ext-id-1';
const sender = (over: Record<string, unknown> = {}) => ({
	id: ID,
	tab: { id: 3 },
	frameId: 0,
	url: 'https://lazyreader.app/connect/clipper',
	...over,
});

describe('isPlausibleToken', () => {
	it('takes 16 to 256 characters without whitespace', () => {
		expect(isPlausibleToken(GOOD)).toBe(true);
		expect(isPlausibleToken('x'.repeat(16))).toBe(true);
		expect(isPlausibleToken('x'.repeat(256))).toBe(true);
	});
	it('refuses other shapes', () => {
		expect(isPlausibleToken('x'.repeat(15))).toBe(false);
		expect(isPlausibleToken('x'.repeat(257))).toBe(false);
		expect(isPlausibleToken('abc def ghi jkl mno pqr')).toBe(false);
		expect(isPlausibleToken(`${GOOD}\n`)).toBe(false);
		expect(isPlausibleToken(12345678901234567890)).toBe(false);
		expect(isPlausibleToken(null)).toBe(false);
		expect(isPlausibleToken(undefined)).toBe(false);
		expect(isPlausibleToken({})).toBe(false);
	});
});

describe('acceptConnect', () => {
	it('accepts the relay in a lazyreader.app top frame', () => {
		expect(acceptConnect(sender(), GOOD, ID)).toBe(true);
	});
	it('refuses a wrong origin', () => {
		expect(acceptConnect(sender({ url: 'https://evil.example/' }), GOOD, ID)).toBe(false);
		expect(acceptConnect(sender({ url: 'https://lazyreader.app.evil.example/' }), GOOD, ID)).toBe(false);
		expect(acceptConnect(sender({ url: 'http://lazyreader.app/' }), GOOD, ID)).toBe(false);
		expect(acceptConnect(sender({ url: undefined }), GOOD, ID)).toBe(false);
		expect(acceptConnect(sender({ url: 'not a url' }), GOOD, ID)).toBe(false);
	});
	it('refuses a subframe', () => {
		expect(acceptConnect(sender({ frameId: 4 }), GOOD, ID)).toBe(false);
		expect(acceptConnect(sender({ frameId: undefined }), GOOD, ID)).toBe(false);
	});
	it('refuses a sender with no tab (offscreen page, popup)', () => {
		expect(acceptConnect(sender({ tab: undefined }), GOOD, ID)).toBe(false);
	});
	it('refuses a foreign extension id', () => {
		expect(acceptConnect(sender({ id: 'other-ext' }), GOOD, ID)).toBe(false);
		expect(acceptConnect(sender({ id: undefined }), GOOD, ID)).toBe(false);
		expect(acceptConnect(undefined, GOOD, ID)).toBe(false);
	});
	it('refuses bad token shapes', () => {
		expect(acceptConnect(sender(), '', ID)).toBe(false);
		expect(acceptConnect(sender(), 'short', ID)).toBe(false);
		expect(acceptConnect(sender(), 'has some spaces in the token', ID)).toBe(false);
		expect(acceptConnect(sender(), 42, ID)).toBe(false);
		expect(acceptConnect(sender(), undefined, ID)).toBe(false);
	});
});

describe('parseConnectMessage (relay filter)', () => {
	const win = {};
	const msg = (over: Record<string, unknown> = {}) => ({
		origin: 'https://lazyreader.app',
		source: win,
		data: { type: CONNECT_MESSAGE_TYPE, token: GOOD },
		...over,
	});
	it('returns the token for the page itself', () => {
		expect(parseConnectMessage(msg(), win)).toBe(GOOD);
	});
	it('ignores a wrong origin', () => {
		expect(parseConnectMessage(msg({ origin: 'https://evil.example' }), win)).toBeNull();
		expect(parseConnectMessage(msg({ origin: 'null' }), win)).toBeNull();
	});
	it('ignores a foreign source window', () => {
		expect(parseConnectMessage(msg({ source: {} }), win)).toBeNull();
		expect(parseConnectMessage(msg({ source: null }), win)).toBeNull();
	});
	it('ignores a wrong type or missing data', () => {
		expect(parseConnectMessage(msg({ data: { type: 'lazyreader:finish-now', token: GOOD } }), win)).toBeNull();
		expect(parseConnectMessage(msg({ data: null }), win)).toBeNull();
		expect(parseConnectMessage(msg({ data: 'text' }), win)).toBeNull();
	});
	it('ignores a bad token', () => {
		expect(parseConnectMessage(msg({ data: { type: CONNECT_MESSAGE_TYPE, token: 'short' } }), win)).toBeNull();
		expect(parseConnectMessage(msg({ data: { type: CONNECT_MESSAGE_TYPE } }), win)).toBeNull();
	});
});
