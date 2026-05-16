-- 008_sessions.sql
-- Coaching sessions with Google Meet integration
-- Run in Supabase SQL Editor: https://supabase.com/dashboard → SQL Editor → New Query

-- ── Sessions table ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id              BIGSERIAL PRIMARY KEY,
  coach_id        UUID NOT NULL REFERENCES auth.users(id),
  session_type    TEXT NOT NULL DEFAULT 'group' CHECK (session_type IN ('group', 'individual')),
  title           TEXT NOT NULL,
  description     TEXT,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 120,
  meet_link       TEXT,
  calendar_event_id TEXT,
  status          TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  cohort_id       BIGINT REFERENCES cohorts(id),
  notes           TEXT,
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Session attendees (founders attending each session) ──────────────────────
CREATE TABLE IF NOT EXISTS session_attendees (
  id          BIGSERIAL PRIMARY KEY,
  session_id  BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  name        TEXT,
  user_id     UUID REFERENCES auth.users(id),
  attended    BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, email)
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX idx_sessions_coach_id ON sessions(coach_id);
CREATE INDEX idx_sessions_scheduled_at ON sessions(scheduled_at);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_session_attendees_session_id ON session_attendees(session_id);
CREATE INDEX idx_session_attendees_email ON session_attendees(email);

-- ── RLS policies ─────────────────────────────────────────────────────────────
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_attendees ENABLE ROW LEVEL SECURITY;

-- Admins can do everything (via service_role key on the API)
-- Coaches can see their own sessions
CREATE POLICY "Coaches can view their own sessions"
  ON sessions FOR SELECT
  USING (coach_id = auth.uid());

-- Founders can see sessions they're attending
CREATE POLICY "Attendees can view their sessions"
  ON sessions FOR SELECT
  USING (
    id IN (
      SELECT session_id FROM session_attendees
      WHERE user_id = auth.uid()
    )
  );

-- Session attendees: viewable by the coach or the attendee
CREATE POLICY "Coaches can view attendees of their sessions"
  ON session_attendees FOR SELECT
  USING (
    session_id IN (
      SELECT id FROM sessions WHERE coach_id = auth.uid()
    )
  );

CREATE POLICY "Attendees can view their own attendance"
  ON session_attendees FOR SELECT
  USING (user_id = auth.uid());

-- ── Updated_at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_sessions_updated_at();
