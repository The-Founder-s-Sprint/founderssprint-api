const express = require('express');
const router  = express.Router();
const {
  TRACKS, getCohort, getOpenCohorts,
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

  // Validate required fields
  if (!cohortId || !track || !firstName || !lastName || !email) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (!TRACKS[track]) {
    return res.status(400).json({ error: 'Invalid track.' });
  }

  let cohort;
  try {
    cohort = await getCohort(Number(cohortId));
  } catch {
    return res.status(404).json({ error: 'Cohort not found.' });
  }

  if (!cohort || cohort.status !== 'open') {
    return res.status(409).json({ error: `Cohort is ${cohort?.status || 'unavailable'}.` });
  }

  // Check capacity for this track
  const takenKey = track === 'group' ? 'group_taken'
                 : track === 'oneOnOne' ? 'one_on_one_taken' : 'vip_taken';
  const maxKey   = track === 'group' ? 'group_max'
                 : track === 'oneOnOne' ? 'one_on_one_max' : 'vip_max';

  if (cohort[takenKey] >= cohort[maxKey]) {
    return res.status(409).json({
      error: `${TRACKS[track].label} track is full for this cohort.`,
    });
  }

  // Create registration
  let reg;
  try {
    reg = await createRegistration({
      cohortId: cohort.id, track,
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
    track:          TRACKS[track].label,
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
        group:    { taken: c.group_taken,     cap: c.group_max    },
        oneOnOne: { taken: c.one_on_one_taken, cap: c.one_on_one_max },
        vip:      { taken: c.vip_taken,        cap: c.vip_max      },
      },
    }));
    res.json(result);
  } catch (err) {
    console.error('[Cohorts] Error:', err.message);
    res.status(500).json({ error: 'Failed to load cohorts.' });
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
