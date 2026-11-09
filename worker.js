// Compatibility relay: takes an anonymous report from a TV app and passes it to GitHub as a
// repository_dispatch event, where a workflow adds it to COMPATIBILITY.md. The GitHub token lives
// here as a secret, so no app carries one.
//
// Limits, to stay on Cloudflare's free plan and keep out junk: posts from one address are rate
// limited (the RATE_LIMIT binding), one report per address, app and version is accepted every 30
// days, accepted reports a day are capped (the DAILY_CAP variable), bodies are small and every
// field is checked against a fixed pattern. The numbers are set in wrangler.toml, which is not
// committed (see wrangler.example.toml).
// Addresses are never stored: only a salted hash, which expires after 30 days.
// On the free plan, going over Cloudflare's own limits makes requests fail; it never bills.

const APPS = {
  localvoice: 'haywirephoenix/webos-localvoice',
  tailscale: 'haywirephoenix/webos-tailscale',
};
const SEEN_FOR = 30 * 24 * 3600;
const MAX_BODY = 2048;

const PATTERNS = {
  model: /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/,
  webos: /^\d{1,2}(\.\d{1,3}){0,3}$/,
  firmware: /^[0-9A-Za-z._-]{1,24}$/,
  version: /^\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  answer: /^[a-z][a-z_]{0,23}$/,
};
const MAX_ANSWERS = 12;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// The report as sent to GitHub, or a reason it was refused.
export function check(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { error: 'not a report' };
  if (!Object.prototype.hasOwnProperty.call(APPS, r.app)) return { error: 'unknown app' };
  for (const key of ['model', 'webos', 'version']) {
    if (typeof r[key] !== 'string' || !PATTERNS[key].test(r[key])) return { error: 'bad ' + key };
  }
  if (r.firmware !== undefined && (typeof r.firmware !== 'string' || !PATTERNS.firmware.test(r.firmware))) {
    return { error: 'bad firmware' };
  }
  const a = r.answers;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { error: 'bad answers' };
  const keys = Object.keys(a);
  if (!keys.length || keys.length > MAX_ANSWERS) return { error: 'bad answers' };
  const answers = {};
  for (const k of keys) {
    if (!PATTERNS.answer.test(k) || typeof a[k] !== 'boolean') return { error: 'bad answers' };
    answers[k] = a[k];
  }
  const report = { app: r.app, model: r.model.toUpperCase(), webos: r.webos, version: r.version, answers };
  if (r.firmware) report.firmware = r.firmware;
  return { report };
}

async function hash(salt, text) {
  const bytes = new TextEncoder().encode(salt + '|' + text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/report') {
      return reply(404, { error: 'not found' });
    }
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.RATE_LIMIT.limit({ key: ip });
    if (!success) return reply(429, { error: 'too many requests' });

    const length = Number(request.headers.get('Content-Length') || 0);
    if (length > MAX_BODY) return reply(413, { error: 'too large' });
    const text = await request.text();
    if (text.length > MAX_BODY) return reply(413, { error: 'too large' });
    let body;
    try { body = JSON.parse(text); } catch (e) { return reply(400, { error: 'not JSON' }); }
    const { report, error } = check(body);
    if (error) return reply(400, { error });

    const seenKey = 'seen:' + await hash(env.SALT, [ip, report.app, report.version].join('|'));
    if (await env.KV.get(seenKey)) return reply(409, { error: 'already reported' });
    const dayKey = 'day:' + new Date().toISOString().slice(0, 10);
    const today = Number(await env.KV.get(dayKey)) || 0;
    const cap = Number(env.DAILY_CAP);
    if (!(cap > 0) || today >= cap) return reply(503, { error: 'daily limit reached, try tomorrow' });

    const sent = await fetch('https://api.github.com/repos/' + APPS[report.app] + '/dispatches', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.GITHUB_TOKEN,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'webos-compat-relay',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ event_type: 'compat-report', client_payload: report }),
    });
    if (sent.status !== 204) return reply(502, { error: 'GitHub refused the report' });

    await env.KV.put(seenKey, '1', { expirationTtl: SEEN_FOR });
    await env.KV.put(dayKey, String(today + 1), { expirationTtl: 2 * 24 * 3600 });
    return reply(200, { ok: true });
  },
};
