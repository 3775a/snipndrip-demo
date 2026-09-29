import { payouts, bookings } from './store.js';
import { usingPostgres, query } from './db.js';

function centsToRand(cents) {
  return (Number(cents) / 100).toFixed(2);
}

function formatPaidAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = d.getDate();
  const mon = months[d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${mon}, ${hh}:${mm}`;
}

function shapePayout(p, booking) {
  const kind = p.booking_id ? 'stylist' : 'shop';
  let meta = p.meta;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  meta = meta || {};

  let headline = '';
  if (booking) {
    headline = `${booking.service_name_snapshot} · Naledi M. · ${formatPaidAt(booking.completed_at || booking.scheduled_start_at)?.split(',')[0] || ''}`;
  } else if (meta.order_label) {
    headline = meta.order_label + (p.paid_at ? ` · ${formatPaidAt(p.paid_at).split(',')[0]}` : '');
  }

  return {
    id: p.id,
    kind,
    amount_cents: Number(p.amount_cents),
    commission_cents: Number(p.commission_cents),
    breakdown: {
      customer_paid_cents: Number(p.customer_paid_cents),
      service_or_product_cents: Number(p.service_or_product_cents),
      pass_through_cents: Number(p.pass_through_cents),
      urgency_cents: Number(p.urgency_cents),
      commission_cents: Number(p.commission_cents),
      commission_rate_bps: Number(p.commission_rate_bps),
    },
    status: p.status,
    paid_at: p.paid_at,
    paid_at_label: p.paid_at ? `Paid out ${formatPaidAt(p.paid_at)}` : 'Pending payout',
    headline,
    booking: booking
      ? {
          id: booking.id,
          service_name: booking.service_name_snapshot,
          scheduled_start_at: booking.scheduled_start_at,
          total_cents: Number(booking.total_cents),
        }
      : null,
    order: p.order_id ? { id: p.order_id, item_count: 3, label: meta.order_label } : null,
    display: {
      amount: `R${centsToRand(p.amount_cents)}`,
      customer_paid: `R${centsToRand(p.customer_paid_cents)}`,
      service: `R${centsToRand(p.service_or_product_cents)}`,
      pass_through: `R${centsToRand(p.pass_through_cents)}`,
      commission: `− R${centsToRand(p.commission_cents)}`,
      commission_pct: (Number(p.commission_rate_bps) / 100).toFixed(0),
      pass_through_label: kind === 'stylist' ? 'Travel fee' : 'Delivery fee',
      commissioned_label: kind === 'stylist' ? 'service' : 'products',
    },
  };
}

export async function getPayout(id) {
  if (usingPostgres) {
    const { rows } = await query(`SELECT * FROM payouts WHERE id = $1`, [id]);
    const p = rows[0];
    if (!p) {
      const err = new Error('payout_not_found');
      err.status = 404;
      throw err;
    }
    let booking = null;
    if (p.booking_id) {
      const b = await query(`SELECT * FROM bookings WHERE id = $1`, [p.booking_id]);
      booking = b.rows[0] || null;
    }
    return shapePayout(p, booking);
  }

  const p = payouts.get(id);
  if (!p) {
    const err = new Error('payout_not_found');
    err.status = 404;
    throw err;
  }
  const booking = p.booking_id ? bookings.get(p.booking_id) : null;
  return shapePayout(p, booking);
}

export async function listPayouts(stylistId) {
  if (usingPostgres) {
    const { rows } = await query(
      `SELECT * FROM payouts WHERE stylist_id = $1 ORDER BY COALESCE(paid_at, created_at) DESC`,
      [stylistId]
    );
    const out = [];
    for (const p of rows) {
      let booking = null;
      if (p.booking_id) {
        const b = await query(`SELECT * FROM bookings WHERE id = $1`, [p.booking_id]);
        booking = b.rows[0] || null;
      }
      out.push(shapePayout(p, booking));
    }
    return out;
  }

  const list = [];
  for (const p of payouts.values()) {
    if (stylistId && p.stylist_id !== stylistId) continue;
    list.push(shapePayout(p, p.booking_id ? bookings.get(p.booking_id) : null));
  }
  list.sort((a, b) => (b.paid_at || '').localeCompare(a.paid_at || ''));
  return list;
}
