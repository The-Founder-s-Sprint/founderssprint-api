/**
 * Balance-grace choice — the founder's roll-vs-refund decision.
 *
 * Reached from the tokenised link in the grace email (renew.html?token=…). The
 * 48-char token IS the authorisation: it's an unguessable per-registration secret,
 * so no login is required and only that one booking can ever be touched.
 *
 *   GET  /api/grace/:token   → safe, PII-light view for the page
 *   POST /api/grace/:token   → apply { choice: 'roll' | 'refund' }
 *
 * No money is moved here. A refund only flags an ops task + notifies finance.
 * Mounted behind the strict rate limiter in api/index.js.
 */
const express = require('express');
const router  = express.Router();
const {
  getRegByGraceToken, getNextOpenCohortByDate,
  rollRegistrationForward, requestRegistrationRefund,
} = require('../lib/db');
const {
  sendMovedNotification, sendRefundRequestedFounder, sendRefundOpsAlert,
} = require('../lib/emailer');

// PII-light view of a grace decision (drives renew.html). No email/phone leaked.
router.get('/:token', async (req, res) => {
  try {
    const reg = await getRegByGraceToken(String(req.params.token || ''));
    if (!reg) return res.status(404).json({ error: 'This link is invalid or has expired.' });
    const next    = reg.cohort ? await getNextOpenCohortByDate(reg.cohort) : null;
    const deposit = Number(reg.deposit_amount || 0);
    const paid    = Number(reg.amount_paid || 0);
    return res.json({
      resolved:   !!reg.balance_choice || reg.forfeited === true,
      choice:     reg.balance_choice || null,
      firstName:  reg.first_name,
      cohortName: reg.cohort ? reg.cohort.name : null,
      deadline:   reg.balance_grace_deadline,
      amountPaid: paid,
      deposit,
      refundable: Math.max(0, paid - deposit),
      currency:   'UGX',
      next: next ? { name: next.name, dates: next.dates || `${next.start_date} – ${next.end_date}` } : null,
    });
  } catch (err) {
    console.error('[Grace] GET error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Apply the founder's choice. Mutation happens only on this explicit POST — never
// on GET — so email link-scanners/prefetchers can't trigger a roll or refund.
router.post('/:token', async (req, res) => {
  try {
    const choice = String((req.body && req.body.choice) || '').toLowerCase();
    if (choice !== 'roll' && choice !== 'refund') {
      return res.status(400).json({ error: 'Please choose to roll forward or request a refund.' });
    }
    const reg = await getRegByGraceToken(String(req.params.token || ''));
    if (!reg) return res.status(404).json({ error: 'This link is invalid or has expired.' });
    if (reg.balance_choice) {
      return res.json({ ok: true, alreadyChosen: true, choice: reg.balance_choice });
    }
    if (reg.balance_paid === true) {
      return res.status(409).json({ error: 'This balance is already paid — nothing to decide.' });
    }

    if (choice === 'roll') {
      const next = reg.cohort ? await getNextOpenCohortByDate(reg.cohort) : null;
      if (!next) {
        return res.status(409).json({ error: 'No upcoming cohort is open yet — please request a refund or contact us.' });
      }
      const applied = await rollRegistrationForward(reg, next);
      if (applied) { try { await sendMovedNotification(reg, reg.cohort, next); } catch (e) { console.error('[Grace] moved email:', e.message); } }
      return res.json({ ok: true, choice: 'roll', next: { name: next.name } });
    }

    // refund — flags an ops task; deposit stays non-refundable
    const refund = await requestRegistrationRefund(reg);
    if (refund === null) { return res.json({ ok: true, alreadyChosen: true, choice: 'refund' }); }
    try { await sendRefundRequestedFounder(reg, refund); } catch (e) { console.error('[Grace] refund email:', e.message); }
    try { await sendRefundOpsAlert(reg, reg.cohort, refund); } catch (e) { console.error('[Grace] ops email:', e.message); }
    return res.json({ ok: true, choice: 'refund', refund });
  } catch (err) {
    console.error('[Grace] POST error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
