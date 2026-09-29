-- SnipñDrip demo schema (no PostGIS required)
-- Money is integer cents.

CREATE TABLE IF NOT EXISTS users (
  id                      text PRIMARY KEY,
  phone                   text UNIQUE NOT NULL,
  full_name               text NOT NULL,
  emergency_contact_name  text,
  emergency_contact_phone text,
  is_customer             boolean NOT NULL DEFAULT true,
  is_stylist              boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stylist_profiles (
  user_id       text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline      text NOT NULL,
  base_lat      double precision NOT NULL,
  base_lng      double precision NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  rating_avg    numeric(2,1) NOT NULL DEFAULT 0,
  rating_count  int NOT NULL DEFAULT 0,
  max_travel_km numeric(5,1) DEFAULT 25
);

CREATE TABLE IF NOT EXISTS stylist_services (
  id            text PRIMARY KEY,
  stylist_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  duration_min  int NOT NULL,
  price_cents   int NOT NULL,
  category      text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS bookings (
  id                      text PRIMARY KEY,
  customer_id             text NOT NULL REFERENCES users(id),
  stylist_id              text NOT NULL REFERENCES users(id),
  service_id              text NOT NULL REFERENCES stylist_services(id),
  service_name_snapshot   text NOT NULL,
  service_price_cents     int NOT NULL,
  duration_min            int NOT NULL,
  address_line1           text NOT NULL,
  address_suburb          text,
  address_city            text NOT NULL,
  address_lat             double precision NOT NULL,
  address_lng             double precision NOT NULL,
  scheduled_start_at      timestamptz NOT NULL,
  scheduled_end_at        timestamptz NOT NULL,
  travel_distance_km      numeric(5,1) NOT NULL,
  travel_duration_min     int NOT NULL,
  travel_fee_cents        int NOT NULL,
  urgency_fee_cents       int NOT NULL DEFAULT 0,
  people_count            int NOT NULL DEFAULT 1,
  service_subtotal_cents  int NOT NULL,
  commission_rate_bps     int NOT NULL DEFAULT 1500,
  commission_cents        int NOT NULL,
  subtotal_cents          int NOT NULL,
  total_cents             int NOT NULL,
  stylist_payout_cents    int NOT NULL,
  status                  text NOT NULL DEFAULT 'pending',
  notes                   text,
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id            text PRIMARY KEY,
  booking_id    text REFERENCES bookings(id),
  user_id       text NOT NULL REFERENCES users(id),
  provider      text NOT NULL,
  provider_ref  text NOT NULL,
  amount_cents  int NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  captured_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payouts (
  id                        text PRIMARY KEY,
  stylist_id                text NOT NULL REFERENCES users(id),
  booking_id                text REFERENCES bookings(id),
  order_id                  text,
  amount_cents              int NOT NULL,
  customer_paid_cents       int NOT NULL,
  service_or_product_cents  int NOT NULL,
  pass_through_cents        int NOT NULL DEFAULT 0,
  urgency_cents             int NOT NULL DEFAULT 0,
  commission_cents          int NOT NULL,
  commission_rate_bps       int NOT NULL,
  status                    text NOT NULL DEFAULT 'pending',
  paid_at                   timestamptz,
  meta                      jsonb,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS panic_events (
  id                 text PRIMARY KEY,
  user_id            text NOT NULL REFERENCES users(id),
  booking_id         text,
  lat                double precision NOT NULL,
  lng                double precision NOT NULL,
  status             text NOT NULL DEFAULT 'triggered',
  dispatched_sms     boolean NOT NULL DEFAULT false,
  dispatched_oncall  boolean NOT NULL DEFAULT false,
  triggered_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  actor_id     text,
  entity_type  text,
  entity_id    text,
  action       text,
  at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payouts_stylist ON payouts (stylist_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_panic_user ON panic_events (user_id, triggered_at DESC);

CREATE TABLE IF NOT EXISTS otp_codes (
  phone       text PRIMARY KEY,
  code        text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0
);
