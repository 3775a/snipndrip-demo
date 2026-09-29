import { bookings, payments, payouts, services, newId, logAudit } from './store.js';
import { computeQuote, verifyQuoteToken, pricesMatch } from './quote.js';
import { usingPostgres, query } from './db.js';

export async function createBooking(customerId, body) {
  const claimed = verifyQuoteToken(body.quote_token);

  const truth = await computeQuote({
    stylist_id: body.stylist_id || claimed.stylist_id,
    service_id: body.service_id || claimed.service_id,
    address: body.address || claimed.address,
    people_count: body.people_count ?? claimed.people_count,
    urgent: body.urgent ?? claimed.urgent,
  });

  if (!pricesMatch(claimed, truth)) {
    const err = new Error('quote_mismatch');
    err.status = 400;
    throw err;
  }

  const start = body.scheduled_start_at
    ? new Date(body.scheduled_start_at)
    : new Date(Date.now() + 2 * 60 * 60 * 1000);
  if (Number.isNaN(start.getTime())) {
    const err = new Error('invalid_scheduled_start');
    err.status = 400;
    throw err;
  }
  const end = new Date(start.getTime() + truth.duration_min * 60 * 1000);
  const bookingId = newId('bk');
  const paymentId = newId('pay');
  const payoutId = newId('po');

  const booking = {
    id: bookingId,
    customer_id: customerId,
    stylist_id: truth.stylist_id,
    service_id: truth.service_id,
    service_name_snapshot: truth.service_name,
    service_price_cents: truth.service_price_cents,
    duration_min: truth.duration_min,
    address_line1: truth.address.line1,
    address_suburb: truth.address.suburb,
    address_city: truth.address.city,
    address_lat: truth.address.lat,
    address_lng: truth.address.lng,
    scheduled_start_at: start.toISOString(),
    scheduled_end_at: end.toISOString(),
    travel_distance_km: truth.travel_distance_km,
    travel_duration_min: truth.travel_duration_min,
    travel_fee_cents: truth.travel_fee_cents,
    urgency_fee_cents: truth.urgency_fee_cents,
    people_count: truth.people_count,
    service_subtotal_cents: truth.service_subtotal_cents,
    commission_rate_bps: truth.commission_rate_bps,
    commission_cents: truth.commission_cents,
    subtotal_cents: truth.total_cents,
    total_cents: truth.total_cents,
    stylist_payout_cents: truth.stylist_payout_cents,
    status: 'pending',
    notes: body.notes || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (usingPostgres) {
    await query(
      `INSERT INTO bookings (
        id, customer_id, stylist_id, service_id, service_name_snapshot, service_price_cents, duration_min,
        address_line1, address_suburb, address_city, address_lat, address_lng,
        scheduled_start_at, scheduled_end_at, travel_distance_km, travel_duration_min,
        travel_fee_cents, urgency_fee_cents, people_count, service_subtotal_cents,
        commission_rate_bps, commission_cents, subtotal_cents, total_cents, stylist_payout_cents,
        status, notes
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
      )`,
      [
        booking.id, booking.customer_id, booking.stylist_id, booking.service_id,
        booking.service_name_snapshot, booking.service_price_cents, booking.duration_min,
        booking.address_line1, booking.address_suburb, booking.address_city,
        booking.address_lat, booking.address_lng, booking.scheduled_start_at, booking.scheduled_end_at,
        booking.travel_distance_km, booking.travel_duration_min, booking.travel_fee_cents,
        booking.urgency_fee_cents, booking.people_count, booking.service_subtotal_cents,
        booking.commission_rate_bps, booking.commission_cents, booking.subtotal_cents,
        booking.total_cents, booking.stylist_payout_cents, booking.status, booking.notes,
      ]
    );
    await query(
      `INSERT INTO payments (id, booking_id, user_id, provider, provider_ref, amount_cents, status, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,'captured', now())`,
      [paymentId, bookingId, customerId, body.provider || 'ozow', `demo-${paymentId}`, truth.total_cents]
    );
    await query(
      `INSERT INTO payouts (
        id, stylist_id, booking_id, amount_cents, customer_paid_cents, service_or_product_cents,
        pass_through_cents, urgency_cents, commission_cents, commission_rate_bps, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,
      [
        payoutId, truth.stylist_id, bookingId, truth.stylist_payout_cents, truth.total_cents,
        truth.service_subtotal_cents, truth.travel_fee_cents, truth.urgency_fee_cents,
        truth.commission_cents, truth.commission_rate_bps,
      ]
    );
    await query(
      `INSERT INTO audit_log (actor_id, entity_type, entity_id, action) VALUES ($1,'booking',$2,'created')`,
      [customerId, bookingId]
    );
  } else {
    bookings.set(bookingId, booking);
    payments.set(paymentId, {
      id: paymentId, booking_id: bookingId, user_id: customerId,
      provider: body.provider || 'ozow', provider_ref: `demo-${paymentId}`,
      amount_cents: truth.total_cents, status: 'captured', captured_at: new Date().toISOString(),
    });
    payouts.set(payoutId, {
      id: payoutId, stylist_id: truth.stylist_id, booking_id: bookingId, order_id: null,
      amount_cents: truth.stylist_payout_cents, customer_paid_cents: truth.total_cents,
      service_or_product_cents: truth.service_subtotal_cents, pass_through_cents: truth.travel_fee_cents,
      urgency_cents: truth.urgency_fee_cents, commission_cents: truth.commission_cents,
      commission_rate_bps: truth.commission_rate_bps, status: 'pending', paid_at: null,
      created_at: new Date().toISOString(),
    });
    logAudit({ actor_id: customerId, entity_type: 'booking', entity_id: bookingId, action: 'created' });
  }

  return { booking, payment_id: paymentId, payout_id: payoutId };
}

export async function completeBooking(bookingId, actorId) {
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
    const b = rows[0];
    if (!b) {
      const err = new Error('booking_not_found');
      err.status = 404;
      throw err;
    }
    if (b.stylist_id !== actorId) {
      const err = new Error('forbidden');
      err.status = 403;
      throw err;
    }
    await query(
      `UPDATE bookings SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1`,
      [bookingId]
    );
    await query(
      `UPDATE payouts SET status = 'paid', paid_at = now() WHERE booking_id = $1 AND status = 'pending'`,
      [bookingId]
    );
    await query(
      `INSERT INTO audit_log (actor_id, entity_type, entity_id, action) VALUES ($1,'booking',$2,'completed')`,
      [actorId, bookingId]
    );
    const { rows: again } = await query(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
    return again[0];
  }

  const b = bookings.get(bookingId);
  if (!b) {
    const err = new Error('booking_not_found');
    err.status = 404;
    throw err;
  }
  if (b.stylist_id !== actorId) {
    const err = new Error('forbidden');
    err.status = 403;
    throw err;
  }
  b.status = 'completed';
  b.completed_at = new Date().toISOString();
  b.updated_at = b.completed_at;
  bookings.set(bookingId, b);
  for (const [id, p] of payouts) {
    if (p.booking_id === bookingId && p.status === 'pending') {
      p.status = 'paid';
      p.paid_at = new Date().toISOString();
      payouts.set(id, p);
    }
  }
  logAudit({ actor_id: actorId, entity_type: 'booking', entity_id: bookingId, action: 'completed' });
  return b;
}

export async function getBooking(id) {
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [id]);
    return rows[0] || null;
  }
  return bookings.get(id) || null;
}
