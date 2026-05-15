-- Migration: 007_coaches_user_id.sql
-- Adds user_id column to coaches table for linking to Supabase Auth
-- Run in Supabase SQL Editor

-- Add user_id column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'coaches' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE coaches ADD COLUMN user_id uuid REFERENCES auth.users(id);
    CREATE INDEX idx_coaches_user_id ON coaches(user_id);
    COMMENT ON COLUMN coaches.user_id IS
      'Links to Supabase Auth user. Set when coach auth account is created on approval.';
  END IF;
END $$;
