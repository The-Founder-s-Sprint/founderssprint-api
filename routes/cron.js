/**
 * Cron endpoints — called by Vercel Cron on a schedule (vercel.json).
 * Schedule (UTC):  04:00 = auto-move/forfeit,  05:00 = reminders + admin report
 * Both = 07:00–08:00 EAT (East Africa Time, UTC+3).
 *
 * Vercel sends Authorization: Bearer <CRON_SECRET> with each cron request.
 * Regular callers are also accepted if ADMIN_SECRET matches x-admin-secret.
 */

const express = require('express');
const router  = express.Router();
const {
  getOpenCohorts, getRegistrationsForCohort,
  getDepositPaidUnpaidBalance, getUnpaidDepositForCohort,
  getNextOpenCohort, moveRegistration, forfeitRegistration,
  daysUntil,
} = require('../lib/db');
const crypto = require('crypto');
const {
  sendReminder14d, sendReminder7d, sendReminder96h,
  sendMovedNotification, sendForfeitNotification, sendAdminReport,
  sendMaterialsAccess,
} = require('../lib/emailer');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Auth: accept Vercel Cron token OR ADMIN_SECRET ────────────────────────────
function requireCron(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const cronToken  = authHeader.replace('Bearer ', '');
  const adminKey   = req.headers['x-admin-secret'] || req.query.secret || '';

  const validCron  = process.env.CRON_SECRET && cronToken === process.env.CRON_SECRET;
  const validAdmin = process.env.ADMIN_SECRET && adminKey === process.env.ADMIN_SECRET;

  if (!validCron && !validAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ── GET /api/cron/reminders ───────────────────────────────────────────────────
// Sends T-14d, T-7d, T-96h balance reminders + 96h admin report
router.get('/reminders', requireCron, async (req, res) => {
  const log = [];
  try {
    const cohorts = await getOpenCohorts();

    for (const cohort of cohorts) {
      const days = daysUntil(cohort.start_date);

      // Founders with deposit paid, balance still due
      if ([14, 7, 4].includes(days)) {
        const paidDeposit = await getDepositPaidUnpaidBalance(cohort.id);
        for (const reg of paidDeposit) {
          if (days === 14) {
            await sendReminder14d(reg, cohort);
            log.push(`T-14d → ${reg.email} (cohort ${cohort.id})`);
          } else if (days === 7) {
            await sendReminder7d(reg, cohort);
            log.push(`T-7d  → ${reg.email} (cohort ${cohort.id})`);
          } else if (days === 4) {
            await sendReminder96h(reg, cohort);
            log.push(`T-96h → ${reg.email} (cohort ${cohort.id})`);
          }
        }
      }

      // Admin report at T-4 days (96h before cohort start)
      if (days === 4) {
        const allRegs = await getRegistrationsForCohort(cohort.id);
        await sendAdminReport(cohort, allRegs);
        log.push(`Admin report sent for cohort ${cohort.id}`);
      }
    }

    console.log('[Cron/reminders]', log);
    res.json({ ok: true, actions: log });
  } catch (err) {
    console.error('[Cron/reminders] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cron/auto-move ───────────────────────────────────────────────────
// At T-48h: move founders who paid deposit but not balance → next cohort.
// Forfeit anyone with no deposit and no next cohort.
router.get('/auto-move', requireCron, async (req, res) => {
  const log = [];
  try {
    const cohorts = await getOpenCohorts();

    for (const cohort of cohorts) {
      const days = daysUntil(cohort.start_date);
      if (days !== 2) continue;

      // Unpaid deposit founders → move (or forfeit if no next cohort)
      const unpaid = await getUnpaidDepositForCohort(cohort.id);
      for (const reg of unpaid) {
        const next = await getNextOpenCohort(cohort.id);
        if (next) {
          await moveRegistration(reg.id, next.id);
          await sendMovedNotification(reg, cohort, next);
          log.push(`Moved reg ${reg.id}: cohort ${cohort.id} → ${next.id}`);
        } else {
          await forfeitRegistration(reg.id);
          await sendForfeitNotification(reg, cohort);
          log.push(`Forfeited reg ${reg.id} (no next cohort)`);
        }
      }
    }

    console.log('[Cron/auto-move]', log);
    res.json({ ok: true, actions: log });
  } catch (err) {
    console.error('[Cron/auto-move] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cron/send-materials ──────────────────────────────────────────────
// At T-2 days: generate access tokens for fully-paid founders and email
// a portal link. Tokens expire at end_date of the cohort (end of 5-week course).
// Idempotent: skips founders who already have a token for this cohort.
router.get('/send-materials', requireCron, async (req, res) => {
  const log = [];
  const PORTAL_BASE = process.env.MATERIALS_PORTAL_URL || 'https://tmsruge.com/materials.html';

  try {
    const cohorts = await getOpenCohorts();

    for (const cohort of cohorts) {
      const days = daysUntil(cohort.start_date);
      if (days !== 2) continue;  // 48 hours before start

      if (!cohort.end_date) {
        log.push(`Skipped cohort ${cohort.id}: no end_date set`);
        continue;
      }

      // Get fully-paid, non-forfeited registrations
      const { data: regs, error: regErr } = await supabase
        .from('registrations')
        .select('*')
        .eq('cohort_id', cohort.id)
        .eq('deposit_paid', true)
        .eq('balance_paid', true)
        .eq('forfeited', false);
      if (regErr) throw regErr;

      for (const reg of (regs || [])) {
        // Check if token already exists (idempotent)
        const { data: existing } = await supabase
          .from('access_tokens')
          .select('id')
          .eq('registration_id', reg.id)
          .eq('cohort_id', cohort.id)
          .limit(1);

        if (existing && existing.length > 0) {
          log.push(`Token already exists for reg ${reg.id}, skipping`);
          continue;
        }

        // Generate a secure random token
        const token = crypto.randomBytes(32).toString('hex');

        // Expiry = end of the last day of the course (23:59:59 EAT)
        const expiresAt = new Date(cohort.end_date + 'T23:59:59+03:00');

        // Store token
        const { error: insertErr } = await supabase
          .from('access_tokens')
          .insert({
            registration_id: reg.id,
            cohort_id:       cohort.id,
            token,
            expires_at:      expiresAt.toISOString(),
          });
        if (insertErr) {
          log.push(`Failed to create token for reg ${reg.id}: ${insertErr.message}`);
          continue;
        }

        // Build portal URL
        const portalUrl = `${PORTAL_BASE}?token=${token}`;

        // Send email
        const emailResult = await sendMaterialsAccess(reg, cohort, portalUrl, expiresAt);
        log.push(`Materials link → ${reg.email} (reg ${reg.id}, cohort ${cohort.id}) ${emailResult.ok ? '✓' : '✗'}`);
      }
    }

    console.log('[Cron/send-materials]', log);
    res.json({ ok: true, actions: log });
  } catch (err) {
    console.error('[Cron/send-materials] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
