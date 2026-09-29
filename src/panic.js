import { users, bookings, panicEvents, newId, logAudit } from './store.js';
import { usingPostgres, query } from './db.js';

async function sendSms(phone, message) {
  if (!phone) throw new Error('no_emergency_contact');
  console.log('[sms]', phone, message.slice(0, 80) + '…');
  return { ok: true };
}

async function pageOnCall({ eventId, userId, lat, lng, booking }) {
  console.log('[oncall]', { eventId, userId, lat, lng, bookingId: booking?.id });
  return { ok: true };
}

function trackingUrl(eventId) {
  return `https://snipndrip.app/safety/track/${eventId}`;
}

async function loadUser(userId) {
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
    return rows[0] || null;
  }
  return users.get(userId) || null;
}

async function loadBooking(bookingId) {
  if (!bookingId) return null;
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
    return rows[0] || null;
  }
  return bookings.get(bookingId) || null;
}

export async function triggerPanic(userId, lat, lng, bookingId) {
  const user = await loadUser(userId);
  if (!user) {
    const err = new Error('user_not_found');
    err.status = 404;
    throw err;
  }

  const booking = await loadBooking(bookingId);
  if (bookingId && !booking) {
    const err = new Error('booking_not_found');
    err.status = 404;
    throw err;
  }

  const eventId = newId('panic');
  const event = {
    id: eventId,
    user_id: userId,
    booking_id: bookingId || null,
    lat: Number(lat),
    lng: Number(lng),
    status: 'triggered',
    dispatched_sms: false,
    dispatched_oncall: false,
    triggered_at: new Date().toISOString(),
  };

  if (usingPostgres) {
    await query(
      `INSERT INTO panic_events (id, user_id, booking_id, lat, lng, status)
       VALUES ($1,$2,$3,$4,$5,'triggered')`,
      [eventId, userId, bookingId || null, event.lat, event.lng]
    );
  } else {
    panicEvents.set(eventId, event);
  }

  const results = await Promise.allSettled([
    sendSms(
      user.emergency_contact_phone,
      `SnipñDrip safety alert from ${user.full_name}. Live location: ${trackingUrl(eventId)}`
    ),
    pageOnCall({ eventId, userId, lat, lng, booking }),
    usingPostgres
      ? query(
          `INSERT INTO audit_log (actor_id, entity_type, entity_id, action) VALUES ($1,'panic',$2,'triggered')`,
          [userId, eventId]
        )
      : Promise.resolve(logAudit({ actor_id: userId, entity_type: 'panic', entity_id: eventId, action: 'triggered' })),
  ]);

  event.dispatched_sms = results[0].status === 'fulfilled';
  event.dispatched_oncall = results[1].status === 'fulfilled';

  if (usingPostgres) {
    await query(
      `UPDATE panic_events SET dispatched_sms = $2, dispatched_oncall = $3 WHERE id = $1`,
      [eventId, event.dispatched_sms, event.dispatched_oncall]
    );
  } else {
    panicEvents.set(eventId, event);
  }

  if (!event.dispatched_sms && !event.dispatched_oncall) {
    const err = new Error('dispatch_failed');
    err.status = 503;
    err.code = 'dispatch_failed';
    throw err;
  }

  const dispatched_to = [];
  if (event.dispatched_sms) dispatched_to.push('emergency_contact');
  if (event.dispatched_oncall) dispatched_to.push('safety_team');

  return { event, dispatched_to };
}
