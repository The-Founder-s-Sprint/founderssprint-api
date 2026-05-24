-- Migration: 010_coach_applications_extended.sql
-- Extends coach_applications with fields from the updated onboarding form
-- Run in Supabase SQL Editor

-- § 1 Extended personal info
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS nationality text;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS timezone text;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS languages text;

-- § 2 Sector focus (multi-select)
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS sectors text[];

-- § 6 Extended compliance fields
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS id_number text;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS tin_number text;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS tin_country text;

-- § Payment fields: mobile_money_provider & mobile_money_number already exist
-- but some forms collect payment info differently. Add bank fields if missing:
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS mobile_money_provider text;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS mobile_money_number text;

-- Founder addendum (for founding team members only)
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS equity_pct text;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS vesting_schedule text;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS founder_role text;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS founder_day text;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS founder_tier text;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS founder_agree text[];

-- Multi-coach approval tracking (if not already present from votes system)
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS required_approvals int DEFAULT 4;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS approval_votes int DEFAULT 0;
ALTER TABLE coach_applications ADD COLUMN IF NOT EXISTS rejection_votes int DEFAULT 0;

COMMENT ON COLUMN coach_applications.display_name IS 'Preferred display name on the platform (e.g. "Coach Barry")';
COMMENT ON COLUMN coach_applications.nationality IS 'Coach nationality';
COMMENT ON COLUMN coach_applications.location IS 'Current city/country';
COMMENT ON COLUMN coach_applications.sectors IS 'Industry sectors the coach covers (multi-select)';
COMMENT ON COLUMN coach_applications.founder_agree IS 'Founder addendum agreement checkboxes (founding team only)';
