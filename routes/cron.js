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
  enterBalanceGrace, getNextOpenCohortByDate, rollRegistrationForward,
  daysUntil,
} = require('../lib/db');
const crypto = require('crypto');
const {
  sendReminder14d, sendReminder7d, sendReminder96h,
  sendMovedNotification, sendForfeitNotification, sendAdminReport,
  sendMaterialsAccess, sendPaymentConfirmation, sendBalanceGraceChoice,
  sendFinancePaymentRecord,
  sendMonthlyNudge,
  sendHoldReminder, sendHoldLapsed,
  sendCoachMonthlyDigest,
} = require('../lib/emailer');
const { checkTransactionStatus } = require('../lib/iotec');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Auth: accept Vercel Cron token OR ADMIN_SECRET ────────────────────────────
function requireCron(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const cronToken  = authHeader.replace('Bearer ', '');
  const adminKey   = req.headers['x-admin-secret'] || '';

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
// Balance-delinquency pathway (locked policy):
//  Phase 1 — at T-48h, any deposit-paid / balance-unpaid founder has their seat
//    released and is emailed a CHOICE: roll everything paid to the next cohort, or
//    request a refund of what they paid ABOVE the non-refundable 10% deposit.
//  Phase 2 — when a founder's decision window lapses with no choice, the default
//    (locked) is to ROLL them forward to the next open cohort (forfeit only if
//    there is no next cohort). Money is never moved here — refunds are ops tasks.
router.get('/auto-move', requireCron, async (req, res) => {
  const log = [];
  const BASE = process.env.SITE_BASE || 'https://founderssprint.co';
  try {
    // Phase 1 — open the grace/choice window at T-48h.
    const cohorts = await getOpenCohorts();
    for (const cohort of cohorts) {
      if (daysUntil(cohort.start_date) !== 2) continue;
      const delinquent = await getDepositPaidUnpaidBalance(cohort.id);
      for (const reg of delinquent) {
        if (reg.balance_grace_token) continue;               // already in grace
        const grace = await enterBalanceGrace(reg);          // frees seat, sets token + 7-day deadline
        if (!grace) continue;
        const next      = await getNextOpenCohortByDate(cohort);
        const choiceUrl = `${BASE}/renew.html?token=${grace.token}`;
        await sendBalanceGraceChoice(reg, cohort, next, choiceUrl, grace.deadline);
        log.push(`Grace opened reg ${reg.id} (cohort ${cohort.id}); next=${next ? next.id : 'none'}`);
      }
    }

    // Phase 2 — resolve lapsed decision windows (default = roll forward).
    const nowIso = new Date().toISOString();
    const { data: expired, error } = await supabase
      .from('registrations')
      .select('*, cohort:cohorts!registrations_cohort_id_fkey(*)')
      .not('balance_grace_token', 'is', null)
      .is('balance_choice', null)
      .lt('balance_grace_deadline', nowIso)
      .eq('forfeited', false);
    if (error) throw error;
    for (const reg of (expired || [])) {
      const next = reg.cohort ? await getNextOpenCohortByDate(reg.cohort) : null;
      if (next) {
        const applied = await rollRegistrationForward(reg, next); // seat already freed; takes one in next
        if (applied) { await sendMovedNotification(reg, reg.cohort, next); log.push(`Auto-rolled reg ${reg.id} → cohort ${next.id} (grace lapsed)`); }
        else { log.push(`reg ${reg.id} already resolved — skipped`); }
      } else {
        // No next cohort — mark forfeited (seat already released, so no counter change).
        await supabase.from('registrations')
          .update({ forfeited: true, updated_at: nowIso })
          .eq('id', reg.id);
        await sendForfeitNotification(reg, reg.cohort || {});
        log.push(`Forfeited reg ${reg.id} (grace lapsed, no next cohort)`);
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
  const PORTAL_BASE = process.env.MATERIALS_PORTAL_URL || 'https://founderssprint.co/materials.html';

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

// ── GET /api/cron/reconcile ───────────────────────────────────────────────────
// Safety net for missed webhooks: poll ioTec for still-pending payment_requests and
// reconcile the DB, then forfeit registrations past their balance deadline.
// Idempotent vs the webhook (guards on status='pending' and field=false).
router.get('/reconcile', requireCron, async (req, res) => {
  const log = [];
  try {
    // 1) Reconcile pending payment_requests >10 min old that have a transaction id.
    // checkTransactionStatus (→ getTransaction) returns the verified ioTec status; we only
    // resolve on TERMINAL states and verify the amount before crediting (mirrors the webhook).
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: pending, error: pErr } = await supabase
      .from('payment_requests').select('*')
      .eq('status', 'pending').not('transaction_id', 'is', null)
      .lt('initiated_at', cutoff).limit(200);
    if (pErr) throw pErr;

    for (const pr of (pending || [])) {
      let tx;
      try { tx = await checkTransactionStatus(pr.transaction_id); }
      catch (e) { log.push(`status-check failed pr#${pr.id}: ${e.message}`); continue; }
      if (!tx.terminal) continue; // Pending / SentToVendor / … — leave pending

      let internal = tx.internal;
      if (internal === 'success' && Number(tx.amount) !== Number(pr.amount)) {
        log.push(`AMOUNT MISMATCH pr#${pr.id}: expected ${pr.amount} got ${tx.amount} — flagged, not credited`);
        internal = 'discrepancy';
      }

      await supabase.from('payment_requests')
        .update({ status: internal, iotec_response: { reconciled: true, status: tx.status },
                  resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', pr.id).eq('status', 'pending'); // no-op if a webhook resolved it first

      if (internal === 'success') {
        const field = pr.payment_type === 'deposit' ? 'deposit_paid' : 'balance_paid';
        const { data: reg, error: rErr } = await supabase
          .from('registrations').update({ [field]: true, updated_at: new Date().toISOString() })
          .eq('id', pr.registration_id).eq(field, false) // idempotent: only if webhook didn't already set it
          .select('*, cohorts!registrations_cohort_id_fkey(*)').maybeSingle();
        if (rErr) { log.push(`reg update failed pr#${pr.id}: ${rErr.message}`); continue; }
        if (reg) {
          await supabase.from('payment_events').insert({ registration_id: pr.registration_id,
            payment_type: pr.payment_type, amount: pr.amount, method: pr.method || 'mobile_money',
            reference: pr.transaction_id, note: 'ioTec reconciliation (missed webhook)' });
          try { await sendPaymentConfirmation(reg, reg.cohorts, pr.payment_type); } catch (_) {}
          try { await sendFinancePaymentRecord(reg, reg.cohorts, pr.payment_type, { method: pr.method, reference: pr.transaction_id }); } catch (_) {}
          log.push(`reconciled ${pr.payment_type} paid → reg#${pr.registration_id}`);
        } else {
          log.push(`pr#${pr.id} success but already marked (webhook beat us) — ok`);
        }
      } else {
        log.push(`pr#${pr.id} reconciled as ${internal}`);
      }
    }

    // 2) Forfeit registrations past the balance deadline (deposit kept, seat released)
    const { data: lapsed, error: lErr } = await supabase
      .from('registrations')
      .update({ forfeited: true, updated_at: new Date().toISOString() })
      .lt('balance_due_at', new Date().toISOString())
      .eq('balance_paid', false).eq('deposit_paid', true).eq('forfeited', false)
      .select('id, email, cohort_id');
    if (lErr) log.push(`forfeit sweep failed: ${lErr.message}`);
    else (lapsed || []).forEach(r => log.push(`forfeited reg#${r.id} (balance past deadline)`));

    console.log('[Cron/reconcile]', log);
    res.json({ ok: true, actions: log });
  } catch (err) {
    console.error('[Cron/reconcile] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cron/monthly-nudge ───────────────────────────────────────────────
// Near month-end (28th): remind founders whose company has NOT logged this month's
// check-in. One email per founder per month (deduped via founder_report_nudges).
// Ungated — every founder with a company reports, paid or not (Phase 0 decision D4).
router.get('/monthly-nudge', requireCron, async (req, res) => {
  const log = [];
  const BASE    = process.env.SITE_BASE || 'https://founderssprint.co';
  const dashUrl = `${BASE}/login-founder.html`;
  try {
    const now        = new Date();
    const monthKey   = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const monthLabel = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    // Active companies + their founder id
    const { data: comps, error: cErr } = await supabase
      .from('companies').select('id, founder_id, status');
    if (cErr) throw cErr;
    const active = (comps || []).filter(c => c.status !== 'archived' && c.founder_id);
    if (!active.length) return res.json({ ok: true, month: monthKey, actions: ['no active companies'] });

    // Companies that already reported this month
    const { data: reps, error: rErr } = await supabase
      .from('founder_monthly_reports').select('company_id').eq('period_month', monthKey);
    if (rErr) throw rErr;
    const reported = new Set((reps || []).map(r => r.company_id));

    // Founders (people) resolved from their profiles
    const fids = [...new Set(active.map(c => c.founder_id))];
    const { data: founders, error: fErr } = await supabase
      .from('founder_profiles').select('id, first_name, email, status').in('id', fids);
    if (fErr) throw fErr;
    const fmap = new Map((founders || []).map(f => [f.id, f]));

    // Founders with ≥1 company missing this month's report (one nudge per person)
    const toNudge = new Map();
    for (const c of active) {
      if (reported.has(c.id)) continue;
      const f = fmap.get(c.founder_id);
      if (!f || !f.email || f.status === 'deleted') continue;
      if (!toNudge.has(f.id)) toNudge.set(f.id, f);
    }

    for (const f of toNudge.values()) {
      // Dedupe: insert-guard makes this at-most-once per founder per month.
      const { error: insErr } = await supabase
        .from('founder_report_nudges').insert({ founder_id: f.id, period_month: monthKey });
      if (insErr) {
        if (insErr.code === '23505') log.push(`skip (already nudged) ${f.email}`);
        else log.push(`log-fail ${f.email}: ${insErr.message}`);
        continue;
      }
      const r = await sendMonthlyNudge(f, monthLabel, dashUrl);
      log.push(`nudge → ${f.email} ${r && r.ok ? '✓' : '✗'}`);
    }

    console.log('[Cron/monthly-nudge]', log);
    res.json({ ok: true, month: monthKey, nudged: log.length, actions: log });
  } catch (err) {
    console.error('[Cron/monthly-nudge] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cron/analytics-rollup ────────────────────────────────────────────
// Nightly: roll raw page_views into the compact page_views_daily rollup (today +
// yesterday in UTC, so late-arriving events are captured), then purge raw rows older
// than the detail window. The rollup is the permanent historical record; the raw table
// stays small and fast. Idempotent — a re-run rebuilds each day's rows.
router.get('/analytics-rollup', requireCron, async (req, res) => {
  const log = [];
  try {
    const RAW_RETENTION_DAYS = 90;
    const now = new Date();
    for (let i = 0; i <= 1; i++) {   // today + yesterday (UTC)
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      const day = d.toISOString().slice(0, 10);
      const { data, error } = await supabase.rpc('admin_rollup_page_views', { p_day: day });
      if (error) log.push(`rollup ${day} failed: ${error.message}`);
      else       log.push(`rolled up ${day}: ${data} rows`);
    }
    // Purge raw rows older than the detail window — history is preserved in the rollup.
    const cutoff = new Date(Date.now() - RAW_RETENTION_DAYS * 86400000).toISOString();
    const { error: delErr, count } = await supabase
      .from('page_views').delete({ count: 'exact' }).lt('created_at', cutoff);
    if (delErr) log.push(`purge failed: ${delErr.message}`);
    else        log.push(`purged ${count || 0} raw rows older than ${RAW_RETENTION_DAYS}d`);

    console.log('[Cron/analytics-rollup]', log);
    res.json({ ok: true, actions: log });
  } catch (err) {
    console.error('[Cron/analytics-rollup] Error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── Soft-hold sweep: two expiry reminders (~24h, ~3h) + lapsed release ────────
// Runs hourly. The seat itself auto-frees the moment hold_expires_at passes (the
// capacity count ignores expired holds), so this job only handles COMMUNICATION:
// nudge before release, and one "your hold lapsed, rebook" note after. All writes
// are guarded so concurrent/rerun invocations can never double-send.
router.get('/hold-sweep', requireCron, async (req, res) => {
  const now    = new Date();
  const nowIso = now.toISOString();
  const in24   = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
  const in3    = new Date(now.getTime() +  3 * 3600 * 1000).toISOString();
  const sel    = '*, cohorts!registrations_cohort_id_fkey(*)';
  const out    = { reminders_24h: 0, reminders_3h: 0, lapsed: 0, errors: [] };

  // Touch 2 (~3h): most urgent, processed first so a reg crossing both thresholds
  // in one run receives the FINAL notice (sets reminders_sent=2, so touch 1 skips it).
  try {
    const { data } = await supabase.from('registrations').select(sel)
      .eq('deposit_paid', false).eq('forfeited', false)
      .not('hold_expires_at', 'is', null)
      .gt('hold_expires_at', nowIso).lte('hold_expires_at', in3)
      .lt('hold_reminders_sent', 2);
    for (const r of (data || [])) {
      try {
        await sendHoldReminder(r, r.cohorts, 2);
        await supabase.from('registrations')
          .update({ hold_reminders_sent: 2, hold_reminded_at: nowIso })
          .eq('id', r.id).lt('hold_reminders_sent', 2);
        out.reminders_3h++;
      } catch (e) { out.errors.push('t2 ' + r.id + ': ' + e.message); }
    }
  } catch (e) { out.errors.push('t2 query: ' + e.message); }

  // Touch 1 (~24h): first nudge.
  try {
    const { data } = await supabase.from('registrations').select(sel)
      .eq('deposit_paid', false).eq('forfeited', false)
      .not('hold_expires_at', 'is', null)
      .gt('hold_expires_at', nowIso).lte('hold_expires_at', in24)
      .lt('hold_reminders_sent', 1);
    for (const r of (data || [])) {
      try {
        await sendHoldReminder(r, r.cohorts, 1);
        await supabase.from('registrations')
          .update({ hold_reminders_sent: 1, hold_reminded_at: nowIso })
          .eq('id', r.id).lt('hold_reminders_sent', 1);
        out.reminders_24h++;
      } catch (e) { out.errors.push('t1 ' + r.id + ': ' + e.message); }
    }
  } catch (e) { out.errors.push('t1 query: ' + e.message); }

  // Lapsed: hold window passed, still unpaid, not yet emailed. Seat is already free;
  // we keep the row as a re-bookable Interest lead (no forfeit, no delete).
  try {
    const { data } = await supabase.from('registrations').select(sel)
      .eq('deposit_paid', false).eq('forfeited', false)
      .not('hold_expires_at', 'is', null)
      .lte('hold_expires_at', nowIso)
      .is('hold_lapsed_at', null);
    for (const r of (data || [])) {
      try {
        await sendHoldLapsed(r, r.cohorts);
        await supabase.from('registrations')
          .update({ hold_lapsed_at: nowIso })
          .eq('id', r.id).is('hold_lapsed_at', null);
        out.lapsed++;
      } catch (e) { out.errors.push('lapse ' + r.id + ': ' + e.message); }
    }
  } catch (e) { out.errors.push('lapse query: ' + e.message); }

  return res.json({ ok: true, ...out, at: nowIso });
});

// ── GET /api/cron/coach-digest ────────────────────────────────────────────────
// Monthly founders' digest — platform summary + a per-coach section — to the founding
// coaches. Runs on the 1st for the PREVIOUS calendar month. Idempotent via digest_runs
// (re-runs skip unless ?force=1). coach_digest_data is granted to service_role only.
router.get('/coach-digest', requireCron, async (req, res) => {
  try {
    const now   = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)); // prev month start
    const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));      // this month start
    const periodStart = start.toISOString().slice(0, 10);
    const monthLabel  = start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    if (!req.query.force) {
      const { data: existing } = await supabase
        .from('digest_runs').select('id').eq('kind', 'coach_monthly').eq('period_start', periodStart).maybeSingle();
      if (existing) return res.json({ ok: true, skipped: 'already sent', period: periodStart });
    }

    const { data: digest, error } = await supabase.rpc('coach_digest_data', {
      p_start: start.toISOString(), p_end: end.toISOString(),
    });
    if (error) throw error;

    let sent = 0; const errors = [];
    for (const coach of (digest.coaches || [])) {
      if (!coach.email) continue;
      try { await sendCoachMonthlyDigest(coach, digest, monthLabel); sent++; }
      catch (e) { errors.push(`${coach.email}: ${e.message}`); }
    }
    await supabase.from('digest_runs')
      .upsert({ kind: 'coach_monthly', period_start: periodStart, recipients: sent, sent_at: new Date().toISOString() },
              { onConflict: 'kind,period_start' });

    return res.json({ ok: true, period: periodStart, month: monthLabel, sent, errors });
  } catch (err) {
    console.error('[Cron/coach-digest]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
