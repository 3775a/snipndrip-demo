/**
 * In-memory store shaped like snipndrip-schema.sql.
 * Swap for Postgres later — handlers only talk to this interface.
 */

import { randomUUID } from 'crypto';

const now = () => new Date().toISOString();

// Demo seed data (cents)
export const users = new Map([
  ['u-customer', {
    id: 'u-customer',
    phone: '+27821234567',
    full_name: 'Thandi Nkosi',
    emergency_contact_name: 'Sipho Nkosi',
    emergency_contact_phone: '+27829876543',
    is_customer: true,
    is_stylist: false,
  }],
  ['u-naledi', {
    id: 'u-naledi',
    phone: '+27821112222',
    full_name: 'Naledi Molefe',
    emergency_contact_name: null,
    emergency_contact_phone: null,
    is_customer: true,
    is_stylist: true,
  }],
]);

export const stylistProfiles = new Map([
  ['u-naledi', {
    user_id: 'u-naledi',
    headline: 'Braids & Locs specialist',
    base_lat: -26.2041,
    base_lng: 28.0473,
    is_active: true,
    rating_avg: 4.9,
    rating_count: 128,
    max_travel_km: 25,
  }],
]);

export const services = new Map([
  ['svc-knotless', {
    id: 'svc-knotless',
    stylist_id: 'u-naledi',
    name: 'Knotless braids (medium)',
    duration_min: 180,
    price_cents: 89500, // R895.00
    category: 'Braids & Locs',
    is_active: true,
  }],
  ['svc-box', {
    id: 'svc-box',
    stylist_id: 'u-naledi',
    name: 'Box braids',
    duration_min: 210,
    price_cents: 95000,
    category: 'Braids & Locs',
    is_active: true,
  }],
]);

export const bookings = new Map();
export const payments = new Map();
export const payouts = new Map();
export const panicEvents = new Map();
export const auditLog = [];

// Pre-seed one completed booking + paid payout (matches receipt UI)
(function seed() {
  const bookingId = 'bk-seed-1';
  const payoutId = 'po-seed-1';
  const serviceSub = 89500;
  const travel = 4500;
  const urgency = 0;
  const commission = Math.round(serviceSub * 1500 / 10000); // 15%
  const total = serviceSub + travel + urgency;
  const stylistPayout = total - commission;

  bookings.set(bookingId, {
    id: bookingId,
    customer_id: 'u-customer',
    stylist_id: 'u-naledi',
    service_id: 'svc-knotless',
    service_name_snapshot: 'Knotless braids (medium)',
    service_price_cents: 89500,
    duration_min: 180,
    address_line1: '12 Vilakazi St',
    address_suburb: 'Orlando West',
    address_city: 'Soweto',
    address_lat: -26.2370,
    address_lng: 27.9080,
    scheduled_start_at: '2025-09-22T10:00:00+02:00',
    scheduled_end_at: '2025-09-22T13:00:00+02:00',
    travel_distance_km: 8.5,
    travel_duration_min: 22,
    travel_fee_cents: travel,
    urgency_fee_cents: urgency,
    people_count: 1,
    service_subtotal_cents: serviceSub,
    commission_rate_bps: 1500,
    commission_cents: commission,
    subtotal_cents: total,
    total_cents: total,
    stylist_payout_cents: stylistPayout,
    status: 'completed',
    completed_at: '2025-09-22T13:15:00+02:00',
    created_at: '2025-09-20T09:00:00+02:00',
    updated_at: '2025-09-22T13:15:00+02:00',
  });

  payouts.set(payoutId, {
    id: payoutId,
    stylist_id: 'u-naledi',
    booking_id: bookingId,
    order_id: null,
    amount_cents: stylistPayout,
    customer_paid_cents: total,
    service_or_product_cents: serviceSub,
    pass_through_cents: travel,
    urgency_cents: urgency,
    commission_cents: commission,
    commission_rate_bps: 1500,
    status: 'paid',
    paid_at: '2025-09-22T14:32:00+02:00',
    created_at: '2025-09-22T13:20:00+02:00',
  });

  // Shop sample payout
  const shopPayoutId = 'po-seed-shop';
  payouts.set(shopPayoutId, {
    id: shopPayoutId,
    stylist_id: 'u-naledi',
    booking_id: null,
    order_id: 'ord-4821',
    amount_cents: 34800,
    customer_paid_cents: 38000,
    service_or_product_cents: 32000,
    pass_through_cents: 6000,
    urgency_cents: 0,
    commission_cents: 3200,
    commission_rate_bps: 1000,
    status: 'paid',
    paid_at: '2025-09-23T09:10:00+02:00',
    created_at: '2025-09-22T18:00:00+02:00',
    meta: { order_label: 'Order #4821 · 3 items' },
  });
})();

export function newId(prefix = '') {
  const id = randomUUID();
  return prefix ? `${prefix}-${id}` : id;
}

export function logAudit(entry) {
  auditLog.push({ ...entry, at: now() });
}
