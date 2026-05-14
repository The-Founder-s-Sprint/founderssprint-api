-- Migration: 004_coach_applications.sql
-- Coach application pipeline for The Founder's Sprint
-- Run in Supabase SQL Editor

-- =============================================================================
-- 1. coach_applications — stores all incoming coach applications
-- =============================================================================
CREATE TABLE IF NOT EXISTS coach_applications (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    status          text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','approved','rejected')),

    -- § 1  Personal identity
    first_name      text        NOT NULL,
    last_name       text        NOT NULL,
    email           text        NOT NULL,
    country_code    text        DEFAULT '+256',
    phone           text,

    -- § 2  Area of expertise (constellation position)
    taxonomy_l1     text        NOT NULL,
    taxonomy_l2     text[],     -- array of selected L2 sub-categories
    taxonomy_l3     text[],     -- array of selected L3 specialties
    assigned_day    text,       -- auto-derived from L1

    -- § 3  Public coach profile
    profile_photo_path  text,   -- Supabase Storage path in coach-profiles bucket
    headline        text,
    bio             text,
    geographies     text,
    linkedin_url    text,
    twitter_url     text,
    instagram_url   text,
    website_url     text,

    -- § 4  Credentials & experience
    current_role    text,
    experience      text,
    notable_clients text,
    cv_path         text,       -- Supabase Storage path in coach-documents bucket

    -- § 5  Coaching preferences
    session_types   text[],     -- e.g. ['group_cohort', 'individual_1on1']
    time_slots      text[],     -- e.g. ['08_10', '13_15', '15_17']
    has_existing_materials  text,
    coaching_philosophy     text,

    -- § 6  Payment information
    mobile_money_provider   text,
    mobile_money_number     text,
    bank_name       text,
    bank_branch     text,
    account_name    text,
    account_number  text,
    swift_code      text,
    tax_status      text,
    company_name    text,

    -- § 7  Statutory & verification
    id_type         text,
    id_document_path text,      -- Supabase Storage path in coach-documents bucket
    tin             text,

    -- § 8  Agreements
    agree_terms     text[],     -- e.g. ['code_of_conduct', 'payment_terms', 'content_license', 'data_consent']

    -- Admin fields
    reviewed_by     text,
    reviewed_at     timestamptz,
    rejection_reason text,
    admin_notes     text,

    -- Timestamps
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now()
);

-- Indexes for admin queries
CREATE INDEX IF NOT EXISTS idx_coach_applications_status ON coach_applications(status);
CREATE INDEX IF NOT EXISTS idx_coach_applications_email ON coach_applications(email);
CREATE INDEX IF NOT EXISTS idx_coach_applications_created ON coach_applications(created_at DESC);

COMMENT ON TABLE coach_applications IS
    'Coach onboarding applications. Status: pending → approved/rejected. '
    'Approved applications create a row in the coaches table.';

-- =============================================================================
-- 2. RLS policies
-- =============================================================================
ALTER TABLE coach_applications ENABLE ROW LEVEL SECURITY;

-- Service role (API server) can do everything
CREATE POLICY "Service role full access on coach_applications"
    ON coach_applications
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- =============================================================================
-- 3. Updated_at trigger
-- =============================================================================
CREATE OR REPLACE FUNCTION update_coach_applications_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER coach_applications_updated_at
    BEFORE UPDATE ON coach_applications
    FOR EACH ROW
    EXECUTE FUNCTION update_coach_applications_updated_at();
