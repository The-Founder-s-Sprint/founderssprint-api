-- New product tiers: single, pick3, cohort, vip1on1
-- Replaces old: group, oneOnOne, vip
-- Applied via Supabase MCP on 2026-05-24

-- Deactivate old track pricing
UPDATE track_pricing SET is_active = false WHERE track_key IN ('group', 'oneOnOne', 'vip');

-- Insert new track pricing
INSERT INTO track_pricing (track_key, label, full_fee, deposit_pct, sort_order) VALUES
  ('single',  '1-on-1 Session',  500000,  10, 1),
  ('pick3',   'Pick 3 Bundle',  1000000,  10, 2),
  ('cohort',  'Full Cohort',    2500000,  10, 3),
  ('vip1on1', 'VIP 1-on-1',     5000000,  10, 4)
ON CONFLICT (track_key) DO UPDATE SET
  label      = EXCLUDED.label,
  full_fee   = EXCLUDED.full_fee,
  deposit_pct = EXCLUDED.deposit_pct,
  sort_order  = EXCLUDED.sort_order,
  is_active   = true,
  updated_at  = now();

-- Add capacity counter columns for new tracks on cohorts table
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS single_taken INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS single_max INTEGER NOT NULL DEFAULT 50;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS pick3_taken INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS pick3_max INTEGER NOT NULL DEFAULT 30;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS cohort_taken INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS cohort_max INTEGER NOT NULL DEFAULT 20;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS vip1on1_taken INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cohorts ADD COLUMN IF NOT EXISTS vip1on1_max INTEGER NOT NULL DEFAULT 5;
