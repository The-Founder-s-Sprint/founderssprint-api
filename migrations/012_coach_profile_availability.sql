-- Coach profile enhancements and availability scheduling
-- Applied via Supabase MCP on 2026-05-24

ALTER TABLE coaches ADD COLUMN IF NOT EXISTS headline TEXT;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS credentials TEXT;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
ALTER TABLE coaches ADD COLUMN IF NOT EXISTS website_url TEXT;

CREATE TABLE coach_availability (
  id          SERIAL PRIMARY KEY,
  coach_id    INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT valid_time_range CHECK (end_time > start_time),
  CONSTRAINT unique_slot UNIQUE (coach_id, day_of_week, start_time)
);

ALTER TABLE coach_availability ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Coaches manage own availability"
  ON coach_availability FOR ALL
  USING (
    coach_id IN (
      SELECT id FROM coaches WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Public read active availability"
  ON coach_availability FOR SELECT
  USING (is_active = true);

CREATE POLICY "Authenticated users manage all availability"
  ON coach_availability FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
