/**
 * Server-side quote computation + HMAC-style token.
 * Money is always integer cents. Commission only on service subtotal.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { services, stylistProfiles } from './store.js';
import { usingPostgres, query } from './db.js';

const QUOTE_SECRET = process.env.QUOTE_SECRET || 'snipndrip-dev-quote-secret-change-me';
const QUOTE_TTL_MS = 10 * 60 * 1000;
const COMMISSION_BPS = 1500;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function travelFeeFromKm(km) {
  if (km < 2) return 0;
  const fee = Math.round(2500 + (km - 2) * 500);
  return Math.min(15000, Math.max(2500, fee));
}

async function loadService(service_id) {
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT id, stylist_id, name, duration_min, price_cents, category, is_active
       FROM stylist_services WHERE id = $1`,
      [service_id]
    );
    return rows[0] || null;
  }
  return services.get(service_id) || null;
}

async function loadProfile(stylist_id) {
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT user_id, headline, base_lat, base_lng, is_active, rating_avg, rating_count, max_travel_km
       FROM stylist_profiles WHERE user_id = $1`,
      [stylist_id]
    );
    return rows[0] || null;
  }
  return stylistProfiles.get(stylist_id) || null;
}

export async function computeQuote({ stylist_id, service_id, address, people_count = 1, urgent = false }) {
  const svc = await loadService(service_id);
  if (!svc || svc.stylist_id !== stylist_id) {
    const err = new Error('service_not_found');
    err.status = 404;
    throw err;
  }
  const profile = await loadProfile(stylist_id);
  if (!profile || !profile.is_active) {
    const err = new Error('stylist_unavailable');
    err.status = 400;
    throw err;
  }

  const people = Math.max(1, Math.min(10, Number(people_count) || 1));
  const lat = Number(address.lat);
  const lng = Number(address.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const err = new Error('invalid_address');
    err.status = 400;
    throw err;
  }

  const km = Math.round(haversineKm(profile.base_lat, profile.base_lng, lat, lng) * 10) / 10;
  if (profile.max_travel_km && km > Number(profile.max_travel_km)) {
    const err = new Error('outside_travel_radius');
    err.status = 400;
    throw err;
  }

  const travel_duration_min = Math.max(8, Math.round(km * 2.8 + 6));
  const travel_fee_cents = travelFeeFromKm(km);
  const urgency_fee_cents = urgent ? 10000 : 0;
  const service_subtotal_cents = svc.price_cents * people;
  const commission_cents = Math.round((service_subtotal_cents * COMMISSION_BPS) / 10000);
  const total_cents = service_subtotal_cents + travel_fee_cents + urgency_fee_cents;

  return {
    stylist_id,
    service_id,
    service_name: svc.name,
    service_price_cents: svc.price_cents,
    duration_min: svc.duration_min,
    people_count: people,
    urgent: !!urgent,
    address: {
      line1: address.line1 || address.text || '',
      suburb: address.suburb || null,
      city: address.city || 'Johannesburg',
      lat,
      lng,
    },
    travel_distance_km: km,
    travel_duration_min,
    travel_fee_cents,
    urgency_fee_cents,
    service_subtotal_cents,
    commission_rate_bps: COMMISSION_BPS,
    commission_cents,
    total_cents,
    stylist_payout_cents: total_cents - commission_cents,
    estimated_start: null,
    estimated_end: null,
  };
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signPayload(payloadObj) {
  const body = b64url(JSON.stringify(payloadObj));
  const sig = createHmac('sha256', QUOTE_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function issueQuoteToken(quote) {
  const exp = Date.now() + QUOTE_TTL_MS;
  const payload = {
    stylist_id: quote.stylist_id,
    service_id: quote.service_id,
    people_count: quote.people_count,
    urgent: quote.urgent,
    address: quote.address,
    travel_fee_cents: quote.travel_fee_cents,
    urgency_fee_cents: quote.urgency_fee_cents,
    service_subtotal_cents: quote.service_subtotal_cents,
    commission_cents: quote.commission_cents,
    total_cents: quote.total_cents,
    stylist_payout_cents: quote.stylist_payout_cents,
    travel_distance_km: quote.travel_distance_km,
    travel_duration_min: quote.travel_duration_min,
    service_price_cents: quote.service_price_cents,
    duration_min: quote.duration_min,
    service_name: quote.service_name,
    exp,
  };
  return signPayload(payload);
}

export function verifyQuoteToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    const err = new Error('invalid_quote_token');
    err.status = 400;
    throw err;
  }
  const [body, sig] = token.split('.');
  const expected = createHmac('sha256', QUOTE_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const err = new Error('invalid_quote_token');
    err.status = 400;
    throw err;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  } catch {
    const err = new Error('invalid_quote_token');
    err.status = 400;
    throw err;
  }
  if (!payload.exp || Date.now() > payload.exp) {
    const err = new Error('quote_expired');
    err.status = 400;
    throw err;
  }
  return payload;
}

export function pricesMatch(claimed, truth) {
  const keys = [
    'travel_fee_cents',
    'urgency_fee_cents',
    'service_subtotal_cents',
    'commission_cents',
    'total_cents',
    'stylist_payout_cents',
  ];
  return keys.every((k) => claimed[k] === truth[k]);
}
