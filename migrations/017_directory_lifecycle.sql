-- 017: Directory provider lifecycle tracking columns
-- Supports auto-expire, auto-remind, auto-relist automation

ALTER TABLE directory_providers
  ADD COLUMN IF NOT EXISTS reminder_14d_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_3d_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS expired_notice_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_payment_at timestamptz;

-- Tier duration mapping (used by renewal logic)
COMMENT ON TABLE directory_providers IS 'Tier durations: basic=free/unlimited, verified=3mo, featured=3mo, corporate=12mo';
