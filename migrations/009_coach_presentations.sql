-- 009_coach_presentations.sql
-- Coach curriculum presentations — standalone HTML files linked to coach profiles
-- Run in Supabase SQL Editor: https://supabase.com/dashboard → SQL Editor → New Query

-- ── Coach presentations table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_presentations (
  id              BIGSERIAL PRIMARY KEY,
  coach_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  taxonomy_l1     TEXT NOT NULL,                    -- e.g. "Marketing & Branding"
  session_code    TEXT,                             -- e.g. "L2-1-1" or "L3-1-1-1"
  file_path       TEXT NOT NULL,                    -- relative path: /presentations/L2-1-1-understanding-your-market.html
  description     TEXT,
  duration_minutes INTEGER DEFAULT 120,
  sort_order      INTEGER DEFAULT 0,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX idx_coach_presentations_coach_id ON coach_presentations(coach_id);
CREATE INDEX idx_coach_presentations_taxonomy ON coach_presentations(taxonomy_l1);
CREATE INDEX idx_coach_presentations_active ON coach_presentations(is_active) WHERE is_active = TRUE;

-- ── RLS policies ─────────────────────────────────────────────────────────────
ALTER TABLE coach_presentations ENABLE ROW LEVEL SECURITY;

-- Coaches can view their own presentations
CREATE POLICY "Coaches can view their own presentations"
  ON coach_presentations FOR SELECT
  USING (coach_id = auth.uid());

-- Founders can view active presentations (for curriculum access)
CREATE POLICY "Authenticated users can view active presentations"
  ON coach_presentations FOR SELECT
  USING (is_active = TRUE);

-- All write operations happen via service_role key on the API (admin only)

-- ── Updated_at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_coach_presentations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER coach_presentations_updated_at
  BEFORE UPDATE ON coach_presentations
  FOR EACH ROW
  EXECUTE FUNCTION update_coach_presentations_updated_at();
