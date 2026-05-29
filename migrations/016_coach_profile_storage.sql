-- Migration 016: Create coach-profiles storage bucket with public read access
-- Run in Supabase SQL Editor

-- Create the public bucket for coach profile photos
INSERT INTO storage.buckets (id, name, public)
VALUES ('coach-profiles', 'coach-profiles', true)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload their own coach photos
-- Path pattern: {coach_id}/photo.{ext}
CREATE POLICY "Authenticated users can upload coach photos"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'coach-profiles');

-- Allow authenticated users to update (upsert) their own coach photos
CREATE POLICY "Authenticated users can update coach photos"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'coach-profiles');

-- Public read access for all coach profile photos
CREATE POLICY "Public read access for coach profiles"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'coach-profiles');
