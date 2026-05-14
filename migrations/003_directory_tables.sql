-- Migration: 003_directory_tables.sql
-- Founder's Sprint Resource Directory
-- Supabase project: https://ivedeivyotwevjxvcuoe.supabase.co
--
-- Pricing tiers:
--   cohort  = UGX 500,000 (~$135, 3-month listing)
--   annual  = UGX 1,500,000 (~$400, 12-month listing, featured partner badge)

-- =============================================================================
-- 1. directory_providers — active service-provider listings
-- =============================================================================
CREATE TABLE IF NOT EXISTS directory_providers (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    category      text        NOT NULL
                              CHECK (category IN ('legal','accounting','design','unbs','banking','insurance','ip','digital')),
    company_name  text        NOT NULL,
    description   text,
    contact_name  text,
    email         text,
    phone         text,
    website       text,
    logo_url      text,
    tier          text        NOT NULL DEFAULT 'cohort'
                              CHECK (tier IN ('cohort','annual')),
    price_ugx     integer     NOT NULL
                              CHECK (price_ugx IN (500000, 1500000)),
    position      integer     DEFAULT 1
                              CHECK (position IN (1, 2, 3)),
    status        text        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','expired','paused')),
    featured      boolean     DEFAULT false,
    starts_at     timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    created_at    timestamptz DEFAULT now(),
    updated_at    timestamptz DEFAULT now()
);

COMMENT ON TABLE directory_providers IS
    'Resource-directory listings for service providers. '
    'Pricing: cohort = UGX 500,000 (~$135, 3 months), annual = UGX 1,500,000 (~$400, 12 months, featured).';

-- Only one active provider per category+position slot
CREATE UNIQUE INDEX idx_providers_category_position_active
    ON directory_providers (category, position)
    WHERE status = 'active';

-- Fast lookup for the public directory page
CREATE INDEX idx_providers_category_status
    ON directory_providers (category, status);

-- =============================================================================
-- 2. directory_applications — inbound applications from prospective providers
-- =============================================================================
CREATE TABLE IF NOT EXISTS directory_applications (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name    text        NOT NULL,
    category        text        NOT NULL
                                CHECK (category IN ('legal','accounting','design','unbs','banking','insurance','ip','digital')),
    contact_name    text        NOT NULL,
    email           text        NOT NULL,
    phone           text,
    website         text,
    message         text,
    preferred_tier  text        DEFAULT 'cohort'
                                CHECK (preferred_tier IN ('cohort','annual')),
    status          text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','approved','rejected')),
    admin_notes     text,
    created_at      timestamptz DEFAULT now(),
    reviewed_at     timestamptz
);

-- Admin filtering by application status
CREATE INDEX idx_applications_status
    ON directory_applications (status);

-- =============================================================================
-- 3. Auto-update trigger for updated_at on directory_providers
-- =============================================================================
CREATE OR REPLACE FUNCTION update_directory_providers_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_directory_providers_updated_at
    BEFORE UPDATE ON directory_providers
    FOR EACH ROW
    EXECUTE FUNCTION update_directory_providers_updated_at();

-- =============================================================================
-- 4. Row-Level Security
-- =============================================================================

-- directory_providers --------------------------------------------------------
ALTER TABLE directory_providers ENABLE ROW LEVEL SECURITY;

-- Anyone can view active, non-expired providers
CREATE POLICY "Public can view active providers"
    ON directory_providers
    FOR SELECT
    TO anon
    USING (status = 'active' AND expires_at > now());

-- Authenticated users (admins) have full access
CREATE POLICY "Authenticated users have full access to providers"
    ON directory_providers
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- directory_applications -----------------------------------------------------
ALTER TABLE directory_applications ENABLE ROW LEVEL SECURITY;

-- Anyone can submit an application (public form)
CREATE POLICY "Public can submit applications"
    ON directory_applications
    FOR INSERT
    TO anon
    WITH CHECK (true);

-- Authenticated users (admins) have full access
CREATE POLICY "Authenticated users have full access to applications"
    ON directory_applications
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);
