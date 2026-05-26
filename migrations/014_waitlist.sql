-- 014_waitlist.sql
-- Waitlist signups from the pre-launch landing page

CREATE TABLE IF NOT EXISTS waitlist (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT,
  email      TEXT NOT NULL UNIQUE,
  phone      TEXT,
  business   TEXT,
  source     TEXT DEFAULT 'website',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for admin queries
CREATE INDEX IF NOT EXISTS idx_waitlist_created ON waitlist (created_at DESC);

-- RLS: admin-only access
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;

-- Allow inserts from the API (service role bypasses RLS)
-- Admin can read all rows
CREATE POLICY "Admin read waitlist"
  ON waitlist FOR SELECT
  USING (
    (auth.jwt() ->> 'role') = 'admin'
    OR current_setting('role', true) = 'service_role'
  );
