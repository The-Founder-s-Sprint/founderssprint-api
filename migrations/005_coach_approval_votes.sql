-- Migration: 005_coach_approval_votes.sql
-- Multi-coach peer approval system for The Founder's Sprint
-- Run in Supabase SQL Editor

-- =============================================================================
-- 1. coach_approval_votes — individual review votes on coach applications
-- =============================================================================
CREATE TABLE IF NOT EXISTS coach_approval_votes (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id  uuid        NOT NULL REFERENCES coach_applications(id) ON DELETE CASCADE,
    reviewer_email  text        NOT NULL,       -- email of the reviewing coach
    reviewer_name   text,                       -- display name for UI
    vote            text        NOT NULL CHECK (vote IN ('approve','reject')),
    rejection_reason text,                      -- only when vote = 'reject'
    notes           text,                       -- internal notes
    created_at      timestamptz DEFAULT now(),

    -- Each coach can only vote once per application
    UNIQUE (application_id, reviewer_email)
);

CREATE INDEX IF NOT EXISTS idx_approval_votes_app ON coach_approval_votes(application_id);
CREATE INDEX IF NOT EXISTS idx_approval_votes_reviewer ON coach_approval_votes(reviewer_email);

COMMENT ON TABLE coach_approval_votes IS
    'Individual coach votes on applications. All non-applicant founding coaches '
    'must approve before status flips. A single rejection blocks approval.';

-- =============================================================================
-- 2. Add approval tracking columns to coach_applications
-- =============================================================================
ALTER TABLE coach_applications
    ADD COLUMN IF NOT EXISTS required_approvals  int DEFAULT 4,
    ADD COLUMN IF NOT EXISTS approval_votes      int DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rejection_votes     int DEFAULT 0;

COMMENT ON COLUMN coach_applications.required_approvals IS
    'Number of approvals needed. Default 4 for founding coaches (all others must approve).';
COMMENT ON COLUMN coach_applications.approval_votes IS
    'Current count of approve votes. Auto-updated by API on each vote.';
COMMENT ON COLUMN coach_applications.rejection_votes IS
    'Current count of reject votes. Any rejection blocks the application.';

-- =============================================================================
-- 3. RLS policies for coach_approval_votes
-- =============================================================================
ALTER TABLE coach_approval_votes ENABLE ROW LEVEL SECURITY;

-- Service role (API server) can do everything
CREATE POLICY "Service role full access on coach_approval_votes"
    ON coach_approval_votes
    FOR ALL
    USING (true)
    WITH CHECK (true);
