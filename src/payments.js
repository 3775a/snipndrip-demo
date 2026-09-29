/**
 * Payments — PayFast (real) + demo fallback.
 * Env:
 *   PAYFAST_MERCHANT_ID
 *   PAYFAST_MERCHANT_KEY
 *   PAYFAST_PASSPHRASE   (optional but recommended)
 *   PAYFAST_SANDBOX=true  (use sandbox host)
 *   PUBLIC_URL            (e.g. https://snipndrip-demo.onrender.com)
 */
import { createHash } from 'crypto';
import { usingPostgres, query } from './db.js';
import { payments, bookings, newId } from './store.js';

const BASE_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

function publicBase(reqHost) {
  if (BASE_URL) return BASE_URL;
  if (reqHost) {
    const host = String(reqHost).split(',')[0].trim();
    return host.startsWith('http') ? host : `https://${host}`;
  }
  return 'http://localhost:8787';
}

function payfastConfigured() {
  return Boolean(process.env.PAYFAST_MERCHANT_ID && process.env.PAYFAST_MERCHANT_KEY);
}

function payfastProcessUrl() {
  const sandbox = String(process.env.PAYFAST_SANDBOX || 'true').toLowerCase() !== 'false';
  return sandbox
    ? 'https://sandbox.payfast.co.za/eng/process'
    : 'https://www.payfast.co.za/eng/process';
}

/**
 * PayFast signature: alphabetical keys, url-encoded values, optional passphrase, MD5.
 * @see https://developers.payfast.co.za/docs#step_2_signature
 */
export function payfastSignature(data, passphrase) {
  const keys = Object.keys(data)
    .filter((k) => data[k] !== '' && data[k] != null && k !== 'signature')
    .sort();
  let str = keys
    .map((k) => `${k}=${encodeURIComponent(String(data[k]).trim()).replace(/%20/g, '+')}`)
    .join('&');
  if (passphrase) {
    str += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
  }
  return createHash('md5').update(str).digest('hex');
}

async function loadBooking(id) {
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [id]);
    return rows[0] || null;
  }
  return bookings.get(id) || null;
}

async function loadPayment(id) {
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM payments WHERE id = $1`, [id]);
    return rows[0] || null;
  }
  return payments.get(id) || null;
}

async function loadPaymentByProviderRef(ref) {
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT * FROM payments WHERE provider_ref = $1 OR id = $1 LIMIT 1`,
      [ref]
    );
    return rows[0] || null;
  }
  for (const p of payments.values()) {
    if (p.provider_ref === ref || p.id === ref) return p;
  }
  return null;
}

async function savePayment(row) {
  if (usingPostgres) {
    await query(
      `INSERT INTO payments (id, booking_id, user_id, provider, provider_ref, amount_cents, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.booking_id,
        row.user_id,
        row.provider,
        row.provider_ref,
        row.amount_cents,
        row.status || 'pending',
      ]
    );
  } else {
    payments.set(row.id, { ...row, created_at: new Date().toISOString() });
  }
}

/**
 * Create payment intent. Uses PayFast when credentials are set; else demo page.
 */
export async function createPaymentIntent(bookingId, body, reqHost) {
  const booking = await loadBooking(bookingId);
  if (!booking) {
    const err = new Error('booking_not_found');
    err.status = 404;
    throw err;
  }
  if (['cancelled_by_customer', 'cancelled_by_stylist', 'completed'].includes(booking.status)) {
    const err = new Error('booking_not_payable');
    err.status = 400;
    throw err;
  }

  let provider = (body.provider || 'payfast').toLowerCase();
  if (provider === 'card' || provider === 'ozow') {
    // Prefer PayFast when configured
    if (payfastConfigured()) provider = 'payfast';
  }

  const paymentId = newId('pay');
  const amountCents = Number(booking.total_cents);
  const base = publicBase(reqHost);

  // PayFast path
  if (provider === 'payfast' && payfastConfigured()) {
    const merchantId = process.env.PAYFAST_MERCHANT_ID;
    const merchantKey = process.env.PAYFAST_MERCHANT_KEY;
    const passphrase = process.env.PAYFAST_PASSPHRASE || '';

    const amountRands = (amountCents / 100).toFixed(2);
    const itemName = (booking.service_name_snapshot || 'SnipñDrip booking').slice(0, 100);

    const pfData = {
      merchant_id: merchantId,
      merchant_key: merchantKey,
      return_url: `${base}/pay/return.html?payment_id=${encodeURIComponent(paymentId)}`,
      cancel_url: `${base}/pay/cancel.html?payment_id=${encodeURIComponent(paymentId)}`,
      notify_url: `${base}/webhooks/payfast`,
      m_payment_id: paymentId,
      amount: amountRands,
      item_name: itemName,
    };

    const signature = payfastSignature(pfData, passphrase);
    pfData.signature = signature;

    await savePayment({
      id: paymentId,
      booking_id: bookingId,
      user_id: booking.customer_id,
      provider: 'payfast',
      provider_ref: paymentId, // m_payment_id; pf_payment_id arrives on ITN
      amount_cents: amountCents,
      status: 'pending',
    });

    // Client opens our auto-submit page (POST to PayFast)
    const payloadB64 = Buffer.from(
      JSON.stringify({ action: payfastProcessUrl(), fields: pfData }),
      'utf8'
    ).toString('base64url');
    const redirect_url = `${base}/pay/payfast.html#${payloadB64}`;

    return {
      payment_id: paymentId,
      provider: 'payfast',
      amount_cents: amountCents,
      status: 'pending',
      redirect_url,
      demo: false,
      process_url: payfastProcessUrl(),
      fields: pfData,
    };
  }

  // Demo fallback
  const providerRef = `demo-${paymentId}`;
  await savePayment({
    id: paymentId,
    booking_id: bookingId,
    user_id: booking.customer_id,
    provider: provider || 'demo',
    provider_ref: providerRef,
    amount_cents: amountCents,
    status: 'pending',
  });

  const redirect_url = `${base}/pay.html?payment_id=${encodeURIComponent(paymentId)}&booking_id=${encodeURIComponent(bookingId)}&amount=${amountCents}&provider=${encodeURIComponent(provider || 'demo')}`;

  return {
    payment_id: paymentId,
    provider: provider || 'demo',
    amount_cents: amountCents,
    status: 'pending',
    redirect_url,
    demo: true,
  };
}

export async function capturePayment(paymentId, body = {}) {
  const payment = await loadPayment(paymentId);
  if (!payment) {
    const err = new Error('payment_not_found');
    err.status = 404;
    throw err;
  }
  if (payment.status === 'captured') {
    return { payment, already: true };
  }
  if (body.fail) {
    if (usingPostgres) {
      await query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
    } else {
      payment.status = 'failed';
      payments.set(paymentId, payment);
    }
    const err = new Error('payment_failed');
    err.status = 402;
    throw err;
  }

  if (usingPostgres) {
    await query(
      `UPDATE payments SET status = 'captured', captured_at = now() WHERE id = $1`,
      [paymentId]
    );
    const { rows } = await query(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
    return { payment: rows[0], already: false };
  }

  payment.status = 'captured';
  payment.captured_at = new Date().toISOString();
  payments.set(paymentId, payment);
  return { payment, already: false };
}

/**
 * PayFast ITN (notify_url) handler.
 * body = parsed form fields from PayFast POST.
 */
export async function handlePayfastItn(body) {
  const passphrase = process.env.PAYFAST_PASSPHRASE || '';
  const receivedSig = String(body.signature || '');
  const expected = payfastSignature(body, passphrase);

  if (receivedSig.toLowerCase() !== expected.toLowerCase()) {
    console.warn('[payfast] bad signature', { receivedSig, expected });
    const err = new Error('invalid_signature');
    err.status = 400;
    throw err;
  }

  // Optional: confirm merchant_id matches
  if (
    process.env.PAYFAST_MERCHANT_ID &&
    String(body.merchant_id) !== String(process.env.PAYFAST_MERCHANT_ID)
  ) {
    const err = new Error('merchant_mismatch');
    err.status = 400;
    throw err;
  }

  const mPaymentId = body.m_payment_id;
  const payment = await loadPaymentByProviderRef(mPaymentId);
  if (!payment) {
    const err = new Error('payment_not_found');
    err.status = 404;
    throw err;
  }

  const amountExpected = (Number(payment.amount_cents) / 100).toFixed(2);
  if (body.amount_gross && String(body.amount_gross) !== amountExpected) {
    console.warn('[payfast] amount mismatch', body.amount_gross, amountExpected);
    const err = new Error('amount_mismatch');
    err.status = 400;
    throw err;
  }

  const status = String(body.payment_status || '').toUpperCase();
  if (status === 'COMPLETE') {
    if (usingPostgres) {
      await query(
        `UPDATE payments SET status = 'captured', captured_at = now(), provider_ref = COALESCE($2, provider_ref)
         WHERE id = $1`,
        [payment.id, body.pf_payment_id || mPaymentId]
      );
    } else {
      payment.status = 'captured';
      payment.captured_at = new Date().toISOString();
      if (body.pf_payment_id) payment.provider_ref = body.pf_payment_id;
      payments.set(payment.id, payment);
    }
    console.log('[payfast] captured', payment.id, body.pf_payment_id);
    return { ok: true, status: 'captured', payment_id: payment.id };
  }

  if (status === 'FAILED' || status === 'CANCELLED') {
    if (usingPostgres) {
      await query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [payment.id]);
    } else {
      payment.status = 'failed';
      payments.set(payment.id, payment);
    }
    return { ok: true, status: 'failed', payment_id: payment.id };
  }

  return { ok: true, status: status || 'ignored', payment_id: payment.id };
}

export async function getPayment(id) {
  const p = await loadPayment(id);
  if (!p) {
    const err = new Error('payment_not_found');
    err.status = 404;
    throw err;
  }
  return p;
}

export { payfastConfigured, payfastProcessUrl };
