/**
 * SnipñDrip demo API + static UI
 * Serves public/index.html and the JSON API on one port.
 * Set DATABASE_URL to use Postgres (Neon / Supabase).
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeQuote, issueQuoteToken } from './quote.js';
import { createBooking, completeBooking, getBooking } from './bookings.js';
import { getPayout, listPayouts } from './payouts.js';
import { triggerPanic } from './panic.js';
import { initDb, usingPostgres } from './db.js';
import { requestOtp, verifyOtp, verifyToken, getMe } from './auth.js';
import { createPaymentIntent, capturePayment, getPayment, handlePayfastItn } from './payments.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 8787;
const DEMO_USER = 'u-customer';
const DEMO_STYLIST = 'u-naledi';


function readFormBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const out = {};
      for (const part of raw.split('&')) {
        if (!part) continue;
        const [k, v = ''] = part.split('=');
        out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent((v || '').replace(/\+/g, ' '));
      }
      resolve(out);
    });
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid_json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Snipndrip-Role',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, 'index.html'), (err2, html) => {
        if (err2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(data);
  });
}

function userFrom(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const payload = verifyToken(auth.slice(7).trim());
    if (payload?.sub) return payload.sub;
  }
  if ((req.headers['x-snipndrip-role'] || '').toLowerCase() === 'stylist') return DEMO_STYLIST;
  return DEMO_USER;
}

async function handleApi(req, res, pathName, method) {
  if (method === 'GET' && pathName === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'snipndrip-api',
      storage: usingPostgres ? 'postgres' : 'memory',
    });
  }

  // ── Auth (phone OTP) ───────────────────────────────────────────────
  if (method === 'POST' && pathName === '/auth/otp/request') {
    const body = await readBody(req);
    return sendJson(res, 200, await requestOtp(body));
  }
  if (method === 'POST' && pathName === '/auth/otp/verify') {
    const body = await readBody(req);
    return sendJson(res, 200, await verifyOtp(body));
  }
  if (method === 'GET' && pathName === '/me') {
    const uid = userFrom(req);
    const user = await getMe(uid);
    if (!user) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, {
      user: {
        id: user.id,
        phone: user.phone,
        full_name: user.full_name,
        is_customer: user.is_customer,
        is_stylist: user.is_stylist,
      },
    });
  }
  if (method === 'POST' && pathName === '/auth/logout') {
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && pathName === '/bookings/quote') {
    const body = await readBody(req);
    const address =
      body.address ||
      (body.lat != null
        ? { lat: body.lat, lng: body.lng, line1: body.line1, city: body.city, suburb: body.suburb }
        : null);
    const quote = await computeQuote({
      stylist_id: body.stylist_id,
      service_id: body.service_id,
      address,
      people_count: body.people_count,
      urgent: body.urgent,
    });
    return sendJson(res, 200, { ...quote, quote_token: issueQuoteToken(quote) });
  }

  if (method === 'POST' && pathName === '/bookings') {
    const body = await readBody(req);
    const result = await createBooking(userFrom(req), body);
    return sendJson(res, 201, result);
  }

  if (method === 'GET' && pathName.startsWith('/bookings/')) {
    const id = pathName.slice('/bookings/'.length);
    if (!id.includes('/')) {
      const b = await getBooking(id);
      if (!b) return sendJson(res, 404, { error: 'booking_not_found' });
      return sendJson(res, 200, { booking: b });
    }
  }

  if (method === 'POST' && /^\/bookings\/[^/]+\/complete$/.test(pathName)) {
    const id = pathName.split('/')[2];
    const b = await completeBooking(id, DEMO_STYLIST);
    return sendJson(res, 200, { booking: b });
  }

  if (method === 'GET' && pathName === '/payouts') {
    return sendJson(res, 200, { items: await listPayouts(DEMO_STYLIST) });
  }

  if (method === 'GET' && pathName.startsWith('/payouts/')) {
    return sendJson(res, 200, await getPayout(pathName.slice('/payouts/'.length)));
  }

  // ── Payments ───────────────────────────────────────────────────────
  if (method === 'POST' && /^\/bookings\/[^/]+\/payment\/intent$/.test(pathName)) {
    const id = pathName.split('/')[2];
    const body = await readBody(req);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return sendJson(res, 200, await createPaymentIntent(id, body, host));
  }
  if (method === 'POST' && /^\/payments\/[^/]+\/capture$/.test(pathName)) {
    const id = pathName.split('/')[2];
    const body = await readBody(req);
    return sendJson(res, 200, await capturePayment(id, body));
  }
  if (method === 'GET' && pathName.startsWith('/payments/')) {
    const id = pathName.slice('/payments/'.length);
    if (!id.includes('/')) {
      return sendJson(res, 200, await getPayment(id));
    }
  }

  // PayFast ITN (server-to-server notify)
  if (method === 'POST' && pathName === '/webhooks/payfast') {
    const body = await readFormBody(req);
    const result = await handlePayfastItn(body);
    // PayFast expects plain OK
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    console.log('[payfast itn]', result);
    return true;
  }

  if (method === 'POST' && pathName === '/panic') {
    const body = await readBody(req);
    if (body.lat == null || body.lng == null) {
      return sendJson(res, 400, { error: 'lat_lng_required' });
    }
    const { event, dispatched_to } = await triggerPanic(
      userFrom(req),
      body.lat,
      body.lng,
      body.booking_id || null
    );
    return sendJson(res, 201, {
      event_id: event.id,
      dispatched_to,
      status: event.status,
    });
  }

  return false;
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Snipndrip-Role',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathName = url.pathname;
  const method = req.method || 'GET';

  try {
    const apiHandled = await handleApi(req, res, pathName, method);
    if (apiHandled === false) {
      serveStatic(req, res, pathName);
    }
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message, code: e.code || e.message });
  }
}

async function main() {
  await initDb();
  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      console.error(e);
      sendJson(res, 500, { error: 'internal' });
    });
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SnipñDrip demo on http://localhost:${PORT}`);
    console.log(`Storage: ${usingPostgres ? 'postgres' : 'memory'}`);
  });
}

main().catch((e) => {
  console.error('Failed to start', e);
  process.exit(1);
});
