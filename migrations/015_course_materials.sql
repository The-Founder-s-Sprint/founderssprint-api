-- 015_course_materials.sql
-- Course materials — the content management layer for the curriculum.
-- Extends beyond coach_presentations (which links files to coaches) by adding
-- curriculum structure, content lifecycle, and delivery controls.
--
-- Run in Supabase SQL Editor: https://supabase.com/dashboard → SQL Editor → New Query

-- ── Course materials table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS course_materials (
  id              BIGSERIAL PRIMARY KEY,

  -- Who owns this module
  coach_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Content identity
  title           TEXT NOT NULL,
  description     TEXT,
  discipline      TEXT NOT NULL,                      -- "Marketing & Branding", "Financial Modelling", etc.
  module_type     TEXT NOT NULL DEFAULT 'lesson',      -- lesson | exercise | framework | worksheet | case_study

  -- Curriculum structure
  week_number     INTEGER CHECK (week_number BETWEEN 1 AND 5),  -- NULL = not assigned to a cohort week
  session_code    TEXT,                               -- e.g. "W1-S1", "L2-1-1"
  sort_order      INTEGER DEFAULT 0,
  duration_minutes INTEGER DEFAULT 120,

  -- Content source & delivery
  file_path       TEXT,                               -- path to HTML module (e.g. /modules/week-1.html)
  source_url      TEXT,                               -- Google Slides or other source link
  format          TEXT NOT NULL DEFAULT 'html_native', -- html_native | google_slides | converted

  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'draft',       -- draft | in_review | published
  access_type     TEXT NOT NULL DEFAULT 'both',        -- cohort | session | both

  -- Flags
  is_active       BOOLEAN DEFAULT TRUE,

  -- Timestamps
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX idx_course_materials_coach_id   ON course_materials(coach_id);
CREATE INDEX idx_course_materials_discipline ON course_materials(discipline);
CREATE INDEX idx_course_materials_week       ON course_materials(week_number) WHERE week_number IS NOT NULL;
CREATE INDEX idx_course_materials_status     ON course_materials(status);
CREATE INDEX idx_course_materials_active     ON course_materials(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_course_materials_access     ON course_materials(access_type);

-- ── RLS policies ────────────────────────────────────────────────────────────
ALTER TABLE course_materials ENABLE ROW LEVEL SECURITY;

-- Coaches can view their own materials (any status)
CREATE POLICY "Coaches view own materials"
  ON course_materials FOR SELECT
  USING (coach_id = auth.uid());

-- Founders can view published, active materials
CREATE POLICY "Authenticated users view published materials"
  ON course_materials FOR SELECT
  USING (is_active = TRUE AND status = 'published');

-- All write operations happen via service_role key on the API (admin only)

-- ── Updated_at trigger ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_course_materials_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER course_materials_updated_at
  BEFORE UPDATE ON course_materials
  FOR EACH ROW
  EXECUTE FUNCTION update_course_materials_updated_at();
