-- Track pricing table — replaces hardcoded TRACKS in db.js
-- Applied via Supabase MCP on 2026-05-24

CREATE TABLE track_pricing (
  id          SERIAL PRIMARY KEY,
  track_key   TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  full_fee    INTEGER NOT NULL,
  deposit_pct INTEGER NOT NULL DEFAULT 10,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO track_pricing (track_key, label, full_fee, deposit_pct, sort_order) VALUES
  ('group',    'Group Sprint',     500000,  10, 1),
  ('oneOnOne', '1-on-1 Intensive', 1500000, 10, 2),
  ('vip',      'VIP All-Access',   5000000, 10, 3);

ALTER TABLE track_pricing ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read pricing"
  ON track_pricing FOR SELECT
  USING (true);

CREATE OR REPLACE FUNCTION update_track_pricing_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER track_pricing_updated
  BEFORE UPDATE ON track_pricing
  FOR EACH ROW
  EXECUTE FUNCTION update_track_pricing_timestamp();
