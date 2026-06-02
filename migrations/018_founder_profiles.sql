-- 018: Founder profiles + data room
-- Founder profiles — persistent identity linked to Supabase auth
CREATE TABLE IF NOT EXISTS founder_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE REFERENCES auth.users(id),
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text,
  whatsapp text,
  company_name text,
  sector text,
  stage text DEFAULT 'idea', -- idea, mvp, revenue, growth
  city text DEFAULT 'Kampala',
  country text DEFAULT 'Uganda',
  bio text,
  avatar_url text,
  linkedin_url text,
  website_url text,
  investor_visible boolean DEFAULT false,
  data_room_shared boolean DEFAULT false,
  profile_complete boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Founder deliverables — data room artifacts per discipline
CREATE TABLE IF NOT EXISTS founder_deliverables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id uuid NOT NULL REFERENCES founder_profiles(id),
  discipline text NOT NULL,
  title text NOT NULL,
  description text,
  file_url text,
  file_type text,
  coach_id integer REFERENCES coaches(id),
  session_id integer,
  status text DEFAULT 'draft',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Link registrations to founder profiles
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS founder_id uuid REFERENCES founder_profiles(id);
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);

-- RLS
ALTER TABLE founder_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE founder_deliverables ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Founders read own profile" ON founder_profiles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Founders update own profile" ON founder_profiles FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "Auth full founder_profiles" ON founder_profiles FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Auth full founder_deliverables" ON founder_deliverables FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Anon insert founder_profiles" ON founder_profiles FOR INSERT TO anon WITH CHECK (true);
