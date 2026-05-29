const express = require('express');
const router  = express.Router();
const {
  TRACKS, getTrackPricing, getCohort, getOpenCohorts,
  createRegistration, markDepositPaid, markFullyPaid,
} = require('../lib/db');
const { sendConfirmation, sendNewRegistrationAdmin } = require('../lib/emailer');

// ── POST /api/register ────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const {
    cohortId, track,
    firstName, lastName, email,
    phone, whatsapp,       // register.html sends as 'whatsapp'
    company, businessName, // register.html sends as 'businessName'
    sector,                // business sector for dashboard analytics
    timeslot,              // preferred time slot for 1-on-1 / VIP
  } = req.body;
  const resolvedPhone   = phone   || whatsapp    || null;
  const resolvedCompany = company || businessName || null;

  // Validate required fields — VIP 1-on-1 doesn't require a cohort
  const isVIP = (track === 'vip1on1');
  if (!track || !firstName || !lastName || !email) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (!cohortId && !isVIP) {
    return res.status(400).json({ error: 'Missing cohort selection.' });
  }
  const tracks = await getTrackPricing();
  if (!tracks[track]) {
    return res.status(400).json({ error: 'Invalid track.' });
  }

  // VIP registrations are not cohort-bound — skip cohort validation
  let cohort = null;
  if (cohortId) {
    try {
      cohort = await getCohort(Number(cohortId));
    } catch {
      return res.status(404).json({ error: 'Cohort not found.' });
    }

    if (!cohort || cohort.status !== 'open') {
      return res.status(409).json({ error: `Cohort is ${cohort?.status || 'unavailable'}.` });
    }

    // Check capacity for this track
    const TAKEN_MAP = { single:'single_taken', pick3:'pick3_taken', cohort:'cohort_taken', vip1on1:'vip1on1_taken', group:'group_taken', oneOnOne:'one_on_one_taken', vip:'vip_taken' };
    const MAX_MAP   = { single:'single_max',   pick3:'pick3_max',   cohort:'cohort_max',   vip1on1:'vip1on1_max',   group:'group_max',   oneOnOne:'one_on_one_max',   vip:'vip_max' };
    const takenKey = TAKEN_MAP[track] || 'single_taken';
    const maxKey   = MAX_MAP[track]   || 'single_max';

    if (cohort[takenKey] >= cohort[maxKey]) {
      return res.status(409).json({
        error: `${tracks[track].label} track is full for this cohort.`,
      });
    }
  }

  // Create registration
  let reg;
  try {
    reg = await createRegistration({
      cohortId: cohort ? cohort.id : null, track,
      firstName, lastName, email,
      phone: resolvedPhone, company: resolvedCompany,
      sector:   sector   || null,
      timeslot: timeslot || null,
    });
  } catch (err) {
    console.error('[Register] DB error:', err.message);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }

  // Await both emails before responding — Vercel kills the function on res.send()
  // Promise.allSettled so one failure doesn't block the other
  const [confirmResult, adminResult] = await Promise.allSettled([
    sendConfirmation(reg, cohort),
    sendNewRegistrationAdmin(reg, cohort),
  ]);
  if (confirmResult.status === 'rejected') {
    console.error('[Register] Confirmation email failed:', confirmResult.reason);
  }
  if (adminResult.status === 'rejected') {
    console.error('[Register] Admin notification failed:', adminResult.reason);
  }

  return res.status(201).json({
    registrationId: reg.id,
    cohortName:     cohort.name,
    cohortDates:    cohort.dates || `${cohort.start_date} – ${cohort.end_date}`,
    track:          tracks[track].label,
    fullFee:        reg.full_fee,
    depositAmount:  reg.deposit_amount,
    balanceAmount:  reg.balance_amount,
    airtelNumber:   process.env.AIRTEL_NUMBER || '',
  });
});

// ── GET /api/cohorts — live availability for the landing page calendar ────────
router.get('/cohorts', async (req, res) => {
  try {
    const cohorts = await getOpenCohorts();
    const result  = cohorts.map(c => ({
      id:         c.id,
      name:       c.name,
      quarter:    c.quarter,
      dates:      c.dates,
      start_date: c.start_date,
      end_date:   c.end_date,
      status:     c.status,
      spots: {
        single:  { taken: c.single_taken  || 0, cap: c.single_max  || 50 },
        pick3:   { taken: c.pick3_taken   || 0, cap: c.pick3_max   || 30 },
        cohort:  { taken: c.cohort_taken  || 0, cap: c.cohort_max  || 20 },
        vip1on1: { taken: c.vip1on1_taken || 0, cap: c.vip1on1_max || 5  },
      },
    }));
    res.json(result);
  } catch (err) {
    console.error('[Cohorts] Error:', err.message);
    res.status(500).json({ error: 'Failed to load cohorts.' });
  }
});

// ── GET /api/pricing — public track prices for registration forms ─────────────
router.get('/pricing', async (req, res) => {
  try {
    const tracks = await getTrackPricing();
    const result = Object.entries(tracks).map(([key, t]) => ({
      track:     key,
      label:     t.label,
      fullFee:   t.fullFee,
      depositPct: t.depositPct,
      deposit:   Math.round(t.fullFee * t.depositPct / 100),
      balance:   t.fullFee - Math.round(t.fullFee * t.depositPct / 100),
    }));
    res.json(result);
  } catch (err) {
    console.error('[Pricing] Error:', err.message);
    res.status(500).json({ error: 'Failed to load pricing.' });
  }
});

// ── PATCH /api/payment/deposit — admin marks deposit received ─────────────────
router.patch('/payment/deposit', async (req, res) => {
  const { registrationId, adminNote, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const reg = await markDepositPaid(Number(registrationId), adminNote);
    res.json({ ok: true, registration: reg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/payment/balance — admin marks balance received ─────────────────
router.patch('/payment/balance', async (req, res) => {
  const { registrationId, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const reg = await markFullyPaid(Number(registrationId));
    res.json({ ok: true, registration: reg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
