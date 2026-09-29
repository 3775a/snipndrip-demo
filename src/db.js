/**
 * Postgres connection. Used when DATABASE_URL is set (Neon / Supabase / Render).
 * Without it, the app falls back to in-memory store.js.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

export const usingPostgres = Boolean(process.env.DATABASE_URL);

/** @type {import('pg').Pool | null} */
export let pool = null;

export async function initDb() {
  if (!usingPostgres) {
    console.log('No DATABASE_URL — using in-memory store');
    return false;
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  // Apply schema
  const schemaPath = path.join(__dirname, '..', 'schema-demo.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);

  // Seed if empty
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    await seedDemo(pool);
    console.log('Postgres seeded with demo data');
  } else {
    console.log('Postgres connected — existing data kept');
  }
  return true;
}

async function seedDemo(p) {
  await p.query(
    `INSERT INTO users (id, phone, full_name, emergency_contact_name, emergency_contact_phone, is_customer, is_stylist)
     VALUES
       ('u-customer', '+27821234567', 'Thandi Nkosi', 'Sipho Nkosi', '+27829876543', true, false),
       ('u-naledi', '+27821112222', 'Naledi Molefe', null, null, true, true)
     ON CONFLICT (id) DO NOTHING`
  );

  await p.query(
    `INSERT INTO stylist_profiles (user_id, headline, base_lat, base_lng, is_active, rating_avg, rating_count, max_travel_km)
     VALUES ('u-naledi', 'Braids & Locs specialist', -26.2041, 28.0473, true, 4.9, 128, 25)
     ON CONFLICT (user_id) DO NOTHING`
  );

  await p.query(
    `INSERT INTO stylist_services (id, stylist_id, name, duration_min, price_cents, category, is_active)
     VALUES
       ('svc-knotless', 'u-naledi', 'Knotless braids (medium)', 180, 89500, 'Braids & Locs', true),
       ('svc-box', 'u-naledi', 'Box braids', 210, 95000, 'Braids & Locs', true)
     ON CONFLICT (id) DO NOTHING`
  );

  // Seed booking + payouts matching receipt UI
  const serviceSub = 89500;
  const travel = 4500;
  const commission = Math.round((serviceSub * 1500) / 10000);
  const total = serviceSub + travel;

  await p.query(
    `INSERT INTO bookings (
       id, customer_id, stylist_id, service_id, service_name_snapshot, service_price_cents, duration_min,
       address_line1, address_suburb, address_city, address_lat, address_lng,
       scheduled_start_at, scheduled_end_at, travel_distance_km, travel_duration_min,
       travel_fee_cents, urgency_fee_cents, people_count, service_subtotal_cents,
       commission_rate_bps, commission_cents, subtotal_cents, total_cents, stylist_payout_cents,
       status, completed_at
     ) VALUES (
       'bk-seed-1', 'u-customer', 'u-naledi', 'svc-knotless', 'Knotless braids (medium)', 89500, 180,
       '12 Vilakazi St', 'Orlando West', 'Soweto', -26.2370, 27.9080,
       '2025-09-22T10:00:00+02:00', '2025-09-22T13:00:00+02:00', 8.5, 22,
       $1, 0, 1, $2, 1500, $3, $4, $4, $5, 'completed', '2025-09-22T13:15:00+02:00'
     ) ON CONFLICT (id) DO NOTHING`,
    [travel, serviceSub, commission, total, total - commission]
  );

  await p.query(
    `INSERT INTO payouts (
       id, stylist_id, booking_id, order_id, amount_cents, customer_paid_cents,
       service_or_product_cents, pass_through_cents, urgency_cents, commission_cents,
       commission_rate_bps, status, paid_at
     ) VALUES (
       'po-seed-1', 'u-naledi', 'bk-seed-1', null, $1, $2, $3, $4, 0, $5, 1500, 'paid', '2025-09-22T14:32:00+02:00'
     ) ON CONFLICT (id) DO NOTHING`,
    [total - commission, total, serviceSub, travel, commission]
  );

  await p.query(
    `INSERT INTO payouts (
       id, stylist_id, booking_id, order_id, amount_cents, customer_paid_cents,
       service_or_product_cents, pass_through_cents, urgency_cents, commission_cents,
       commission_rate_bps, status, paid_at, meta
     ) VALUES (
       'po-seed-shop', 'u-naledi', null, 'ord-4821', 34800, 38000, 32000, 6000, 0, 3200, 1000,
       'paid', '2025-09-23T09:10:00+02:00', '{"order_label":"Order #4821 · 3 items"}'::jsonb
     ) ON CONFLICT (id) DO NOTHING`
  );
}

export async function query(text, params) {
  if (!pool) throw new Error('db_not_connected');
  return pool.query(text, params);
}
