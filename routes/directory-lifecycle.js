const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { sendDirectoryReminder, sendDirectoryExpired } = require('../lib/emailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Tier duration in months (for renewal extensions)
const TIER_DURATION = {
  basic:     null,  // free — no expiry
  verified:  3,
  featured:  3,
  corporate: 12,
};

// ── GET /api/cron/directory-lifecycle ─────────────────────────────────────────
// Runs daily. Handles three lifecycle events:
//   1. 14-day renewal reminder
//   2. 3-day urgent reminder
//   3. Auto-expire + expired notice
//
// Vercel cron: schedule "0 6 * * *" (daily at 6 AM UTC = 9 AM EAT)
router.get('/cron/directory-lifecycle', async (req, res) => {
  // Verify cron auth (Vercel cron header or admin secret)
  const cronAuth = req.headers['authorization'];
  const isVercelCron = cronAuth === `Bearer ${process.env.CRON_SECRET}`;
  const isAdmin = req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  if (!isVercelCron && !isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = { reminded14d: 0, reminded3d: 0, expired: 0, errors: [] };

  try {
    // ── 1. 14-day reminder ──────────────────────────────────────────────────
    // Active listings expiring within 14 days that haven't been reminded yet
    const fourteenDays = new Date(Date.now() + 14 * 86400000).toISOString();
    const { data: due14d } = await supabase
      .from('directory_providers')
      .select('id, company_name, contact_name, email, tier, expires_at')
      .eq('status', 'active')
      .lt('expires_at', fourteenDays)
      .is('reminder_14d_sent_at', null)
      .not('tier', 'eq', 'basic');  // basic listings don't expire

    for (const provider of (due14d || [])) {
      if (!provider.email) continue;
      try {
        await sendDirectoryReminder(provider, '14d');
        await supabase
          .from('directory_providers')
          .update({ reminder_14d_sent_at: new Date().toISOString() })
          .eq('id', provider.id);
        results.reminded14d++;
      } catch (err) {
        results.errors.push(`14d ${provider.company_name}: ${err.message}`);
      }
    }

    // ── 2. 3-day urgent reminder ────────────────────────────────────────────
    const threeDays = new Date(Date.now() + 3 * 86400000).toISOString();
    const { data: due3d } = await supabase
      .from('directory_providers')
      .select('id, company_name, contact_name, email, tier, expires_at')
      .eq('status', 'active')
      .lt('expires_at', threeDays)
      .is('reminder_3d_sent_at', null)
      .not('tier', 'eq', 'basic');

    for (const provider of (due3d || [])) {
      if (!provider.email) continue;
      try {
        await sendDirectoryReminder(provider, '3d');
        await supabase
          .from('directory_providers')
          .update({ reminder_3d_sent_at: new Date().toISOString() })
          .eq('id', provider.id);
        results.reminded3d++;
      } catch (err) {
        results.errors.push(`3d ${provider.company_name}: ${err.message}`);
      }
    }

    // ── 3. Auto-expire ──────────────────────────────────────────────────────
    // Active paid listings whose expires_at has passed
    const now = new Date().toISOString();
    const { data: expiredListings } = await supabase
      .from('directory_providers')
      .select('id, company_name, contact_name, email, tier, expires_at')
      .eq('status', 'active')
      .lt('expires_at', now)
      .not('tier', 'eq', 'basic');

    for (const provider of (expiredListings || [])) {
      try {
        // Update status to expired
        await supabase
          .from('directory_providers')
          .update({ status: 'expired', updated_at: now })
          .eq('id', provider.id);

        // Send expired notice with renewal link (if not already sent)
        if (provider.email && !provider.expired_notice_sent_at) {
          await sendDirectoryExpired(provider);
          await supabase
            .from('directory_providers')
            .update({ expired_notice_sent_at: now })
            .eq('id', provider.id);
        }
        results.expired++;
      } catch (err) {
        results.errors.push(`expire ${provider.company_name}: ${err.message}`);
      }
    }

    console.log('[Directory Lifecycle]', JSON.stringify(results));
    return res.json({ ok: true, ...results });

  } catch (err) {
    console.error('[Directory Lifecycle] Fatal:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/directory/renew ────────────────────────────────────────────────
// Called when a provider clicks "Renew" in their reminder email.
// Phase 1: generates a renewal record. Phase 2: triggers ioTec payment.
router.post('/directory/renew', async (req, res) => {
  const { providerId } = req.body;
  if (!providerId) return res.status(400).json({ error: 'Missing providerId' });

  const { data: provider, error } = await supabase
    .from('directory_providers')
    .select('*')
    .eq('id', providerId)
    .single();

  if (error || !provider) {
    return res.status(404).json({ error: 'Provider not found' });
  }

  const duration = TIER_DURATION[provider.tier];
  if (!duration) {
    return res.status(400).json({ error: 'Basic listings do not require renewal' });
  }

  // Calculate new expiry from today (not from old expiry — no gap penalty)
  const newExpiry = new Date();
  newExpiry.setMonth(newExpiry.getMonth() + duration);

  // TODO: When ioTec is connected, generate payment link here instead of auto-renewing
  // For now: auto-renew (manual payment confirmation via dashboard)
  const { error: updateErr } = await supabase
    .from('directory_providers')
    .update({
      status: 'active',
      expires_at: newExpiry.toISOString(),
      renewal_count: (provider.renewal_count || 0) + 1,
      last_payment_at: new Date().toISOString(),
      // Reset reminder flags for next cycle
      reminder_14d_sent_at: null,
      reminder_3d_sent_at: null,
      expired_notice_sent_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', providerId);

  if (updateErr) {
    return res.status(500).json({ error: 'Renewal failed: ' + updateErr.message });
  }

  return res.json({
    ok: true,
    message: `Listing renewed for ${duration} months`,
    new_expires_at: newExpiry.toISOString(),
  });
});

module.exports = router;
