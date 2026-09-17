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
  sendSessionReminder,
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
        // Honour the REGISTRATION's own deadline, not just the cohort start date.
        // balance_due_at is normally (cohort start 10:00 EAT − 48h), but it can be
        // extended by agreement — and when it is, opening a grace window early tells
        // a founder they've missed a deadline they haven't, and frees their seat.
        // This bit Tomide (reg 64): deadline extended to 30 Sep, grace opened 5 Sep.
        if (reg.balance_due_at && new Date(reg.balance_due_at) > new Date()) {
          log.push(`reg ${reg.id} skipped — balance not due until ${reg.balance_due_at}`);
          continue;
        }
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
      // Never roll or forfeit someone who has since PAID. A stale grace token must
      // not outrank the fact that the money arrived.
      .eq('balance_paid', false)
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
          const { data: evt } = await supabase.from('payment_events').insert({ registration_id: pr.registration_id,
            payment_type: pr.payment_type, amount: pr.amount, method: pr.method || 'mobile_money',
            reference: pr.transaction_id, note: 'ioTec reconciliation (missed webhook)' })
            .select('id').single();
          // Settle, then issue the numbered documents, then email — the
          // confirmation attaches the receipt, so it has to exist first.
          try {
            const { error: sErr } = await supabase.rpc('settle_registration_payment',
              { p_reg_id: pr.registration_id, p_payment_type: pr.payment_type });
            if (sErr) log.push(`settlement failed reg#${pr.registration_id}: ${sErr.message}`);
          } catch (e) { log.push(`settlement threw reg#${pr.registration_id}: ${e.message}`); }
          let docs = null;
          try {
            const { data, error: dErr } = await supabase.rpc('issue_payment_documents', { p_payment_event_id: evt && evt.id });
            if (dErr) log.push(`document issue failed reg#${pr.registration_id}: ${dErr.message}`);
            else docs = data;
          } catch (e) { log.push(`document issue threw reg#${pr.registration_id}: ${e.message}`); }
          try { await sendPaymentConfirmation(reg, reg.cohorts, pr.payment_type); } catch (_) {}
          try { await sendFinancePaymentRecord(reg, reg.cohorts, pr.payment_type, { method: pr.method, reference: pr.transaction_id, receipt: docs && docs.receipt }); } catch (_) {}
          log.push(`reconciled ${pr.payment_type} paid → reg#${pr.registration_id}`
            + (docs && docs.receipt ? ` (${docs.receipt})` : ''));
        } else {
          log.push(`pr#${pr.id} success but already marked (webhook beat us) — ok`);
        }
      } else {
        log.push(`pr#${pr.id} reconciled as ${internal}`);
      }
    }

    // 1b) Repair pass: any payment that never got its numbered documents.
    // This is the safety net behind all three payment paths — if the RPC failed
    // at payment time (DB hiccup, deploy mid-flight), the money is still credited
    // and the document is minted here on the next tick. Idempotent per event, so
    // it can only ever fill gaps, never duplicate. Anti-join runs in the DB.
    try {
      const { data: unissued, error: uErr } = await supabase.rpc('unissued_payment_events', { p_limit: 100 });
      if (uErr) log.push(`unissued lookup failed: ${uErr.message}`);
      else for (const e of (unissued || [])) {
        const { data: d, error: dErr } = await supabase.rpc('issue_payment_documents', { p_payment_event_id: e.payment_event_id });
        // Log document numbers and ids only — never names or emails.
        if (dErr) log.push(`document issue failed event#${e.payment_event_id}: ${dErr.message}`);
        else log.push(`issued ${d && d.receipt} for event#${e.payment_event_id} (reg#${e.registration_id})`
          + (d && d.bill_to_pending ? ' — bill-to incomplete, withheld from founder' : ''));
      }
    } catch (e) { log.push(`document repair pass threw: ${e.message}`); }

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

// ── GET /api/cron/session-reminders ──────────────────────────────────────────
// One email per session, ~72h before it starts, to the founders AND the coach.
//
// Cohort sessions are created SILENTLY (no Google invitation blast), so this is
// the notification people actually receive. Runs hourly; each session is reminded
// exactly once (reminder_sent_at), so a re-run or an overlapping cron cannot
// double-send. Sessions already inside the window when generated still get one
// reminder on the next run rather than being skipped.
router.get('/session-reminders', requireCron, async (req, res) => {
  const WINDOW_H = Number(req.query.hours) || 72;
  const now = new Date();
  const cutoff = new Date(now.getTime() + WINDOW_H * 3600 * 1000);

  try {
    const { data: due, error } = await supabase
      .from('sessions')
      .select('id, title, scheduled_at, duration_minutes, meet_link, coach_id, cohort_id')
      .eq('status', 'scheduled')
      .is('reminder_sent_at', null)
      .gt('scheduled_at', now.toISOString())
      .lte('scheduled_at', cutoff.toISOString())
      .order('scheduled_at', { ascending: true });
    if (error) throw new Error(error.message);

    if (!due || !due.length) return res.json({ ok: true, reminded: 0, note: 'nothing due' });

    let sent = 0, failed = 0;
    for (const s of due) {
      const hoursAway = (new Date(s.scheduled_at) - now) / 3600000;

      // Attendees recorded on the session, plus the coach.
      const { data: atts } = await supabase.from('session_attendees')
        .select('email, name').eq('session_id', s.id);
      // sessions.coach_id is the coach's auth UUID (coaches.user_id), NOT coaches.id.
      const { data: coach } = await supabase.from('coaches')
        .select('email, first_name').eq('user_id', s.coach_id).maybeSingle();

      const targets = [
        ...(atts || []).map(a => ({ to: a.email, name: a.name, isCoach: false })),
        ...(coach && coach.email ? [{ to: coach.email, name: coach.first_name, isCoach: true }] : []),
      ].filter(t => t.to);

      let anySent = false;
      for (const t of targets) {
        try {
          await sendSessionReminder({ ...t, session: s, meetLink: s.meet_link, hoursAway });
          anySent = true; sent++;
        } catch (e) {
          failed++;
          console.error('[cron/session-reminders]', s.id, t.to, e.message);
        }
      }

      // Only mark done if at least one went out, so a total failure retries next hour
      // instead of silently swallowing the whole session's notification.
      if (anySent) {
        await supabase.from('sessions')
          .update({ reminder_sent_at: new Date().toISOString() }).eq('id', s.id);
      }
    }

    return res.json({ ok: failed === 0, sessions: due.length, emails_sent: sent, failed });
  } catch (err) {
    console.error('[cron/session-reminders]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

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

// ── GET /api/cron/session-attendance ─────────────────────────────────────────
// Reads Google Meet conference records for sessions that have finished and
// records who joined. This is the evidence a session was DELIVERED — not that a
// founder completed the material, which stays the coach's judgement on the L3.
//
// Runs after sessions end (hourly is plenty). Only touches rows the coach hasn't
// already marked: a human who was in the call outranks an API guessing from a
// display name.
//
// Unmatched participants are REPORTED, never guessed onto a founder. A wrong
// attendance record is worse than a missing one, because it becomes evidence of
// a delivery that may not have happened.
router.get('/session-attendance', requireCron, async (req, res) => {
  const log = [], unmatched = [];
  const hours = Number(req.query.hours) || 48;
  const since = new Date(Date.now() - hours * 3600 * 1000);

  try {
    const { attendanceForMeeting, matchToRoster } = require('../lib/google-meet');

    // Finished, not cancelled, has a Meet link. Bounded window so this can't
    // walk the whole table as the cohort count grows.
    const { data: due, error } = await supabase
      .from('sessions')
      .select('id, title, scheduled_at, duration_minutes, meet_link, organiser_email, status')
      .eq('status', 'scheduled')
      .not('meet_link', 'is', null)
      .gte('scheduled_at', since.toISOString())
      .lt('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(100);
    if (error) throw new Error(error.message);
    if (!due || !due.length) return res.json({ ok: true, checked: 0, note: 'no finished sessions in window' });

    for (const s of due) {
      // Give the conference time to close before reading it.
      const endsAt = new Date(s.scheduled_at).getTime() + (s.duration_minutes || 120) * 60000;
      if (Date.now() < endsAt + 10 * 60000) { log.push(`session ${s.id} still running — skipped`); continue; }

      const { data: roster } = await supabase.from('session_attendees')
        .select('email, name, attended, attendance_source').eq('session_id', s.id);
      if (!roster || !roster.length) { log.push(`session ${s.id} has no roster — skipped`); continue; }

      let result;
      try {
        result = await attendanceForMeeting(s.meet_link, s.organiser_email, s.scheduled_at);
      } catch (e) {
        log.push(`session ${s.id} Meet read failed: ${e.message}`);
        continue;
      }
      if (!result.participants.length) { log.push(`session ${s.id} — no participants recorded`); continue; }

      for (const p of result.participants) {
        const hit = matchToRoster(p.displayName, roster);
        if (!hit) {
          // Someone in the call we can't place. Worth a human's eyes, not a guess.
          unmatched.push({ session_id: s.id, displayName: p.displayName, kind: p.kind, minutes: p.minutes });
          continue;
        }
        // A coach who marked this already was in the room — don't overwrite them.
        if (hit.attendance_source === 'coach' || hit.attendance_source === 'admin') continue;

        const { data: r, error: rErr } = await supabase.rpc('record_session_attendance', {
          p_session_id: s.id, p_email: hit.email, p_attended: true,
          p_minutes: p.minutes, p_first_joined: p.firstJoined, p_last_left: p.lastLeft,
          p_join_count: p.joinCount, p_source: 'meet_api',
        });
        // supabase.rpc() RESOLVES with { error } — check it, don't rely on catch.
        if (rErr) log.push(`session ${s.id} ${hit.email}: ${rErr.message}`);
        else if (r && r.ok === false) log.push(`session ${s.id} ${hit.email}: ${r.reason}`);
        else log.push(`session ${s.id}: ${hit.email} joined${p.minutes ? ` (${p.minutes}m)` : ''}`);
      }
    }

    console.log('[Cron/session-attendance]', { actions: log.length, unmatched: unmatched.length });
    return res.json({ ok: true, checked: due.length, actions: log, unmatched });
  } catch (err) {
    console.error('[Cron/session-attendance]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cron/verify-meet-links ──────────────────────────────────────────
// Reads every upcoming session's event back from Google and compares it with
// what we stored. We write meet_link once at creation and never look again, so
// any edit made in the Google UI — a manual reschedule, a delete-and-recreate —
// silently forks our copy from the room that actually exists. The symptom is a
// coach and a founder sitting in two different empty calls.
//
// Reports by default. Pass ?fix=1 to write Google's link back into sessions:
// Google owns the room, we only hold a pointer to it, so on a disagreement the
// calendar is right and we are stale.
//
// Also checks the guest list, since a link that matches is no use if the
// founder was never invited to the event carrying it.
router.get('/verify-meet-links', requireCron, async (req, res) => {
  try {
    const { getEvent } = require('../lib/google-calendar');
    const fix   = req.query.fix === '1';
    const days  = Number(req.query.days) || 60;
    const until = new Date(Date.now() + days * 86400000).toISOString();

    const { data: sessions, error } = await supabase
      .from('sessions')
      .select('id, title, scheduled_at, meet_link, calendar_event_id, organiser_email, cohort_id, status')
      .not('calendar_event_id', 'is', null)
      .neq('status', 'cancelled')
      .gt('scheduled_at', new Date().toISOString())
      .lt('scheduled_at', until)
      .order('scheduled_at')
      .limit(300);
    if (error) throw new Error(error.message);

    const out = { checked: 0, ok: 0, mismatched: [], missing: [], uninvited: [], errors: [], fixed: 0 };

    for (const s of (sessions || [])) {
      out.checked++;
      let ev;
      try { ev = await getEvent(s.calendar_event_id, s.organiser_email); }
      catch (e) { out.errors.push({ session: s.id, error: e.message }); continue; }

      if (ev.missing || ev.status === 'cancelled') {
        // The event our link points at is gone. Founders hold invites that lead
        // nowhere; this needs a human, not an automatic re-create.
        out.missing.push({ session: s.id, title: s.title, at: s.scheduled_at });
        continue;
      }

      const stored = String(s.meet_link || '').trim().toLowerCase();
      const live   = String(ev.meetLink || '').trim().toLowerCase();

      if (live && stored !== live) {
        out.mismatched.push({
          session: s.id, title: s.title, at: s.scheduled_at,
          stored: s.meet_link, google: ev.meetLink, organiser: ev.organiser,
        });
        if (fix) {
          const { error: uErr } = await supabase.from('sessions')
            .update({ meet_link: ev.meetLink }).eq('id', s.id);
          if (uErr) out.errors.push({ session: s.id, error: 'update failed: ' + uErr.message });
          else out.fixed++;
        }
      } else if (live) {
        out.ok++;
      }

      // Everyone we think is attending should be on the Google guest list.
      const { data: roster } = await supabase
        .from('session_attendees').select('email').eq('session_id', s.id);
      const invited = new Set(ev.attendees || []);
      const absent = (roster || [])
        .map(r => String(r.email || '').trim().toLowerCase())
        .filter(e => e && !invited.has(e));
      if (absent.length) out.uninvited.push({ session: s.id, title: s.title, emails: absent });
    }

    console.log('[Cron/verify-meet-links]', {
      checked: out.checked, ok: out.ok, mismatched: out.mismatched.length,
      missing: out.missing.length, uninvited: out.uninvited.length, fixed: out.fixed,
    });
    return res.json({ ok: true, fix_applied: fix, ...out });
  } catch (err) {
    console.error('[Cron/verify-meet-links]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cron/seat-founders ──────────────────────────────────────────────
// Repair pass for cohort seating. Payment-time seating can fail — Google down,
// a founder who paid before the schedule was generated, a registration claimed
// by a login only later. Every one of those failures is SILENT: the founder
// simply never gets an invite and nobody finds out until the class starts.
//
// Idempotent per registration, so running it hourly costs nothing when there is
// nothing to do.
router.get('/seat-founders', requireCron, async (req, res) => {
  try {
    const { seatFounderForRegistration } = require('../lib/cohort-seating');
    const dryRun = req.query.dry === '1';

    // Paid cohort seats whose cohort still has sessions ahead of it.
    const { data: regs, error } = await supabase
      .from('registrations')
      .select('id, email, cohort_id')
      .eq('track', 'cohort')
      .eq('deposit_paid', true)
      .or('forfeited.is.null,forfeited.eq.false')
      .not('cohort_id', 'is', null)
      .limit(500);
    if (error) throw new Error(error.message);

    const results = [];
    for (const r of (regs || [])) {
      const out = await seatFounderForRegistration(r.id, { dryRun });
      // Only report registrations where something actually happened or broke —
      // a green run should be quiet, or nobody will read the log.
      if (out.seated || out.problems.length) results.push(out);
    }
    const seated = results.reduce((n, r) => n + r.seated, 0);
    console.log('[Cron/seat-founders]', { checked: (regs || []).length, seated, flagged: results.length });
    return res.json({ ok: true, dry_run: dryRun, checked: (regs || []).length, seated, results });
  } catch (err) {
    console.error('[Cron/seat-founders]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cron/assignment-digest ──────────────────────────────────────────
// Daily. Two nudges, both deliberately quiet:
//   · a founder with work due inside 48h that they haven't submitted
//   · a coach with submissions sitting unreviewed
//
// Only ONE mail per person per run, however many items they have — a digest that
// arrives per-row trains people to filter it, which defeats the whole point of
// moving the conversation onto the platform.
router.get('/assignment-digest', requireCron, async (req, res) => {
  const log = [];
  try {
    const { sendAssignmentDigest } = require('../lib/emailer');
    const horizon = new Date(Date.now() + (Number(req.query.hours) || 48) * 3600 * 1000);

    const { data: rows, error } = await supabase
      .from('assignment_recipients')
      .select('id, status, founder_id, '
            + 'assignments!inner(id, title, due_at, coach_id, status), '
            + 'founder_profiles(first_name, email)')
      .in('status', ['assigned', 'returned', 'submitted'])
      .limit(2000);
    if (error) throw new Error(error.message);

    const dueByFounder = new Map();   // email -> { firstName, items[] }
    const reviewByCoach = new Map();  // coach_id -> count

    for (const r of (rows || [])) {
      const a = r.assignments || {};
      if (a.status === 'closed') continue;

      if (r.status === 'submitted') {
        reviewByCoach.set(a.coach_id, (reviewByCoach.get(a.coach_id) || 0) + 1);
        continue;
      }
      // Undated work never becomes urgent, so it never nudges — otherwise the
      // digest would repeat the same item every morning forever.
      if (!a.due_at || new Date(a.due_at) > horizon) continue;

      const fp = r.founder_profiles;
      if (!fp || !fp.email) continue;
      const key = fp.email.toLowerCase();
      if (!dueByFounder.has(key)) dueByFounder.set(key, { firstName: fp.first_name || '', items: [] });
      dueByFounder.get(key).items.push({ title: a.title, dueAt: a.due_at, overdue: new Date(a.due_at) < new Date() });
    }

    let sent = 0;
    for (const [email, v] of dueByFounder) {
      try { await sendAssignmentDigest({ to: email, forRole: 'founder', firstName: v.firstName, items: v.items }); sent++; }
      catch (e) { log.push(`founder ${email}: ${e.message}`); }
    }
    for (const [coachId, count] of reviewByCoach) {
      const { data: c } = await supabase.from('coaches')
        .select('first_name, email, founderssprint_email').eq('user_id', coachId).limit(1).maybeSingle();
      const to = c && (c.founderssprint_email || c.email);
      if (!to) { log.push(`coach ${coachId}: no email`); continue; }
      try { await sendAssignmentDigest({ to, forRole: 'coach', firstName: c.first_name || '', pendingReviews: count }); sent++; }
      catch (e) { log.push(`coach ${to}: ${e.message}`); }
    }

    console.log('[Cron/assignment-digest]', { sent, problems: log.length });
    return res.json({ ok: true, sent, founders: dueByFounder.size, coaches: reviewByCoach.size, problems: log });
  } catch (err) {
    console.error('[Cron/assignment-digest]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
