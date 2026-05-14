-- Migration: 006_user_roles.sql
-- Role-based access control for the authenticated hub
-- Run in Supabase SQL Editor

-- =============================================================================
-- 1. user_roles — maps Supabase Auth users to platform roles
-- =============================================================================
-- Roles: admin, coach, founder, investor, hub_partner
-- A user can have MULTIPLE roles (e.g., Teddy is both admin and coach)

CREATE TABLE IF NOT EXISTS user_roles (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL,     -- Supabase Auth user ID
    email       text        NOT NULL,     -- denormalized for easy lookup
    role        text        NOT NULL CHECK (role IN ('admin','coach','founder','investor','hub_partner')),
    granted_by  text,                     -- who granted this role
    granted_at  timestamptz DEFAULT now(),

    -- Each user can only have one entry per role
    UNIQUE (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_email ON user_roles(email);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);

COMMENT ON TABLE user_roles IS
    'Maps Supabase Auth users to platform roles. A user can hold multiple roles. '
    'Checked by Next.js middleware to gate route access.';

-- =============================================================================
-- 2. RLS policies
-- =============================================================================
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

-- Service role (API server) can do everything
CREATE POLICY "Service role full access on user_roles"
    ON user_roles FOR ALL
    USING (true) WITH CHECK (true);

-- Users can read their own roles (so the client can show the right nav)
CREATE POLICY "Users can read own roles"
    ON user_roles FOR SELECT
    USING (auth.uid() = user_id);

-- =============================================================================
-- 3. Seed founding team roles
-- =============================================================================
-- Teddy: admin + coach
-- Barry, Moses, Joseph, Patrick: coach
-- NOTE: Run AFTER create-coach-accounts.js so user IDs exist in auth.users
--
-- To seed, run this in SQL Editor after coach accounts are created:
--
-- INSERT INTO user_roles (user_id, email, role, granted_by) VALUES
--   ((SELECT id FROM auth.users WHERE email = 'tms.ruge@me.com'), 'tms.ruge@me.com', 'admin', 'system'),
--   ((SELECT id FROM auth.users WHERE email = 'tms.ruge@me.com'), 'tms.ruge@me.com', 'coach', 'system'),
--   ((SELECT id FROM auth.users WHERE email = 'bwojega@hivecolab.com'), 'bwojega@hivecolab.com', 'coach', 'system'),
--   ((SELECT id FROM auth.users WHERE email = 'mengwau@gmail.com'), 'mengwau@gmail.com', 'coach', 'system'),
--   ((SELECT id FROM auth.users WHERE email = 'joe.kalema@gmail.com'), 'joe.kalema@gmail.com', 'coach', 'system'),
--   ((SELECT id FROM auth.users WHERE email = 'patrick.ngolobe@aels.co.ug'), 'patrick.ngolobe@aels.co.ug', 'coach', 'system');

-- =============================================================================
-- 4. Helper function: get roles for current user (for client-side queries)
-- =============================================================================
CREATE OR REPLACE FUNCTION get_my_roles()
RETURNS text[] AS $$
  SELECT COALESCE(array_agg(role), '{}')
  FROM user_roles
  WHERE user_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION get_my_roles IS
    'Returns array of roles for the currently authenticated user. '
    'Called by the client to determine navigation and UI.';
