/**
 * Phone OTP auth (SA E.164). Demo logs the code; wire SMS later.
 */
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { usingPostgres, query } from './db.js';
import { users, newId } from './store.js';

const AUTH_SECRET = process.env.AUTH_SECRET || process.env.QUOTE_SECRET || 'snipndrip-auth-dev-secret';
const OTP_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** @type {Map<string, { code: string, expires: number, attempts: number }>} */
const memoryOtps = new Map();

function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  let p = phone.trim().replace(/[\s\-()]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (p.startsWith('0') && p.length === 10) p = '+27' + p.slice(1); // SA local → E.164
  if (!p.startsWith('+')) p = '+' + p.replace(/^\+/, '');
  if (!/^\+[1-9]\d{7,14}$/.test(p)) return null;
  return p;
}

function issueToken(user) {
  const payload = {
    sub: user.id,
    phone: user.phone,
    name: user.full_name,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

async function findUserByPhone(phone) {
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM users WHERE phone = $1`, [phone]);
    return rows[0] || null;
  }
  for (const u of users.values()) {
    if (u.phone === phone) return u;
  }
  return null;
}

async function createUser(phone, fullName) {
  const id = newId('u');
  const user = {
    id,
    phone,
    full_name: fullName || 'SnipñDrip user',
    emergency_contact_name: null,
    emergency_contact_phone: null,
    is_customer: true,
    is_stylist: false,
  };
  if (usingPostgres) {
    await query(
      `INSERT INTO users (id, phone, full_name, is_customer, is_stylist)
       VALUES ($1, $2, $3, true, false)`,
      [id, phone, user.full_name]
    );
  } else {
    users.set(id, user);
  }
  return user;
}

async function saveOtp(phone, code, expires) {
  if (usingPostgres) {
    await query(
      `INSERT INTO otp_codes (phone, code, expires_at, attempts)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), 0)
       ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = to_timestamp($3 / 1000.0), attempts = 0`,
      [phone, code, expires]
    );
  } else {
    memoryOtps.set(phone, { code, expires, attempts: 0 });
  }
}

async function loadOtp(phone) {
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT code, (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires, attempts
       FROM otp_codes WHERE phone = $1`,
      [phone]
    );
    if (!rows[0]) return null;
    return {
      code: rows[0].code,
      expires: Number(rows[0].expires),
      attempts: rows[0].attempts,
    };
  }
  return memoryOtps.get(phone) || null;
}

async function bumpAttempts(phone, attempts) {
  if (usingPostgres) {
    await query(`UPDATE otp_codes SET attempts = $2 WHERE phone = $1`, [phone, attempts]);
  } else {
    const o = memoryOtps.get(phone);
    if (o) {
      o.attempts = attempts;
      memoryOtps.set(phone, o);
    }
  }
}

async function clearOtp(phone) {
  if (usingPostgres) {
    await query(`DELETE FROM otp_codes WHERE phone = $1`, [phone]);
  } else {
    memoryOtps.delete(phone);
  }
}

/** POST /auth/otp/request */
export async function requestOtp(body) {
  const phone = normalizePhone(body.phone);
  if (!phone) {
    const err = new Error('invalid_phone');
    err.status = 400;
    throw err;
  }

  const code = String(randomInt(100000, 999999));
  const expires = Date.now() + OTP_TTL_MS;
  await saveOtp(phone, code, expires);

  // Demo: log code. Production: sendSms(phone, `Your SnipñDrip code is ${code}`)
  console.log(`[otp] ${phone} → ${code}`);

  const res = {
    sent: true,
    phone,
    expires_in_sec: Math.floor(OTP_TTL_MS / 1000),
  };
  // Always return demo_code in this prototype so testers can sign in without SMS
  if (process.env.HIDE_DEMO_OTP !== '1') {
    res.demo_code = code;
  }
  return res;
}

/** POST /auth/otp/verify */
export async function verifyOtp(body) {
  const phone = normalizePhone(body.phone);
  const code = String(body.code || '').trim();
  if (!phone || !/^\d{6}$/.test(code)) {
    const err = new Error('invalid_request');
    err.status = 400;
    throw err;
  }

  const row = await loadOtp(phone);
  if (!row || Date.now() > row.expires) {
    const err = new Error('otp_expired');
    err.status = 400;
    throw err;
  }
  if (row.attempts >= 5) {
    const err = new Error('too_many_attempts');
    err.status = 429;
    throw err;
  }
  if (row.code !== code) {
    await bumpAttempts(phone, row.attempts + 1);
    const err = new Error('otp_incorrect');
    err.status = 400;
    throw err;
  }

  await clearOtp(phone);

  let user = await findUserByPhone(phone);
  if (!user) {
    user = await createUser(phone, body.full_name || null);
  }

  const token = issueToken(user);
  return {
    token,
    user: {
      id: user.id,
      phone: user.phone,
      full_name: user.full_name,
      is_customer: user.is_customer,
      is_stylist: user.is_stylist,
    },
  };
}

export async function getMe(userId) {
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
    return rows[0] || null;
  }
  return users.get(userId) || null;
}

export { normalizePhone };
