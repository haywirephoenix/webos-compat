// Run with: node test.mjs
// Checks the relay's report validation and its limits against fake Cloudflare bindings.
import assert from 'node:assert';
import worker, { check } from './worker.js';

const good = { app: 'localvoice', model: 'oled55bx6lb', webos: '5.4.3', firmware: '04.40.75',
  version: '0.4.5', answers: { starts: true, words: false } };

assert.deepStrictEqual(check(good).report, { ...good, model: 'OLED55BX6LB' });
assert.ok(check({ ...good, app: 'other' }).error);
assert.ok(check({ ...good, model: '<script>' }).error);
assert.ok(check({ ...good, webos: '5.4.3; rm -rf' }).error);
assert.ok(check({ ...good, version: '1' }).error);
assert.ok(check({ ...good, answers: { starts: 'yes' } }).error);
assert.ok(check({ ...good, answers: { 'Bad Key': true } }).error);
assert.ok(check({ ...good, answers: {} }).error);
assert.ok(check({ ...good, answers: Object.fromEntries([...Array(13)].map((_, i) => ['q' + 'abcdefghijklm'[i], true])) }).error);
assert.ok(check([]).error);
const noFirmware = { ...good };
delete noFirmware.firmware;
assert.ok(check(noFirmware).report);

// The whole request, with GitHub and Cloudflare faked.
const store = new Map();
let allowed = true, dispatched = [];
const env = {
  SALT: 'salt', GITHUB_TOKEN: 'token', DAILY_CAP: '3',
  RATE_LIMIT: { limit: async () => ({ success: allowed }) },
  KV: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } },
};
globalThis.fetch = async (url, init) => { dispatched.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); };
const post = (body, ip = '1.2.3.4') => worker.fetch(new Request('https://relay/report', {
  method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' } }), env);

assert.strictEqual((await post(good)).status, 200);
assert.strictEqual(dispatched[0].url, 'https://api.github.com/repos/haywirephoenix/webos-localvoice/dispatches');
assert.strictEqual(dispatched[0].body.event_type, 'compat-report');
assert.ok(![...store.keys()].some((k) => k.includes('1.2.3.4')), 'the address is stored only hashed');
assert.strictEqual((await post(good)).status, 409, 'same address and version twice');
assert.strictEqual((await post({ ...good, version: '0.4.6' })).status, 200, 'a new version may report again');
assert.strictEqual((await post(good, '5.6.7.8')).status, 200, 'another address');
assert.strictEqual((await post({ ...good, model: 'x' }, '9.9.9.9')).status, 400);
allowed = false;
assert.strictEqual((await post(good, '8.8.8.8')).status, 429);
allowed = true;
store.set('day:' + new Date().toISOString().slice(0, 10), '3');
assert.strictEqual((await post(good, '7.7.7.7')).status, 503, 'daily cap');
const big = await worker.fetch(new Request('https://relay/report', { method: 'POST', body: 'x'.repeat(3000) }), env);
assert.strictEqual(big.status, 413);
assert.strictEqual((await worker.fetch(new Request('https://relay/report', { method: 'OPTIONS' }), env)).status, 204);
assert.strictEqual((await worker.fetch(new Request('https://relay/'), env)).status, 404);
console.log('relay: all passed');
