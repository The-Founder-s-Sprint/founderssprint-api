/**
 * Beta express 1:1 consulting sessions with Teddy (manual mobile-money, admin-
 * confirmed). Standalone from cohort registrations; retired when ioTec goes live.
 *
 *   GET  /api/express/slots            → taken slot timestamps (to grey out the grid)
 *   POST /api/express/book             → validate slot + create account + hold booking + emails
 *   POST /api/express/confirm          → (admin/finance) confirm payment + release Meet link
 *
 * Booking window: weekdays, 10:00–17:00 EAT (hourly starts 10–16), from tomorrow
 * up to 31 Aug 2026. Double-booking is prevented by a DB unique index; the insert
 * translates a 23505 into a friendly "slot just taken". Mounted behind the strict
 * limiter in api/index.js. All writes use the service-role client.
 */
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { ensureFounderAccount } = require('../lib/db');
const { sendExpressBookingRequest, sendExpressBookingAdmin, sendExpressConfirmed } = require('../lib/emailer');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const AMOUNT   = 200000;                              // UGX — Founding Beta rate
const DURATION = 60;
const MM_NUMBER = process.env.EXPRESS_MM_NUMBER || process.env.AIRTEL_NUMBER || '07XX XXX XXX';
const MM_NAME   = process.env.EXPRESS_MM_NAME   || 'Teddy Ruge';
const WINDOW_END = new Date('2026-09-01T00:00:00+03:00'); // launch — last bookable day is 31 Aug
const WEEKDAYS = { Mon: 1, Tue: 1, Wed: 1, Thu: 1, Fri: 1 };

const cap = (s, n = 200) => String(s == null ? '' : s).trim().slice(0, n);

// Extract EAT (Africa/Nairobi) weekday/hour/minute for a given instant.
function eatFields(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { d, wd: get('weekday'), hour: parseInt(get('hour'), 10), minute: parseInt(get('minute'), 10) };
}

// ── Taken slots (public; timestamps only, no PII) ────────────────────────────
router.get('/slots', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('express_bookings')
      .select('slot_start')
      .in('status', ['requested', 'paid', 'confirmed'])
      .gte('slot_start', new Date().toISOString());
    if (error) throw error;
    res.json({ taken: (data || []).map((r) => r.slot_start), amount: AMOUNT, duration: DURATION });
  } catch (err) {
    console.error('[Express] slots:', err.message);
    res.status(500).json({ error: 'Could not load availability.' });
  }
});

// ── Book (hold) a slot + create the founder account ──────────────────────────
router.post('/book', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, password, slotStart } = req.body || {};
    if (!firstName || !email || !slotStart) return res.status(400).json({ error: 'Please add your name, email, and pick a time.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'Please choose a password of at least 8 characters.' });

    const ef = eatFields(slotStart);
    if (!ef) return res.status(400).json({ error: 'That time slot is invalid.' });
    if (!WEEKDAYS[ef.wd] || ef.hour < 10 || ef.hour > 16 || ef.minute !== 0)
      return res.status(400).json({ error: 'Sessions run weekdays, 10am–5pm EAT, on the hour.' });
    if (ef.d <= new Date())      return res.status(400).json({ error: 'That time has passed — please pick another.' });
    if (ef.d >= WINDOW_END)      return res.status(400).json({ error: 'Beta sessions run until 31 August. Please pick an earlier time.' });

    // Create/ensure the founder's login account (non-fatal — booking still proceeds).
    const account = await ensureFounderAccount({
      email: String(email).trim(), password,
      firstName: cap(firstName, 120), lastName: cap(lastName, 120), phone: cap(phone, 40),
    });

    const ref = 'FS-EXP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const row = {
      first_name: cap(firstName, 120),
      last_name:  cap(lastName, 120) || null,
      email:      String(email).trim().slice(0, 254),
      phone:      cap(phone, 40) || null,
      user_id:    (account && account.userId) || null,
      slot_start: ef.d.toISOString(),
      duration_min: DURATION, amount: AMOUNT, currency: 'UGX',
      status: 'requested', payment_ref: ref,
    };
    const { data: b, error } = await supabase.from('express_bookings').insert(row).select('*').single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Sorry — that slot was just taken. Please pick another time.' });
      console.error('[Express] insert:', error.message);
      return res.status(500).json({ error: 'Could not save your booking. Please try again.' });
    }

    await Promise.allSettled([ sendExpressBookingRequest(b), sendExpressBookingAdmin(b) ]);
    return res.status(201).json({ ok: true, ref, amount: b.amount, mm: MM_NUMBER, mmName: MM_NAME, slotStart: b.slot_start });
  } catch (err) {
    console.error('[Express] book:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Confirm payment + release the Meet link (admin / finance only) ───────────
async function requireStaff(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) { res.status(401).json({ error: 'Not signed in.' }); return null; }
  const { data: { user } = {}, error } = await supabase.auth.getUser(token);
  if (error || !user) { res.status(401).json({ error: 'Your session has expired — sign in again.' }); return null; }
  const { data: roles } = await supabase.from('user_roles').select('role').eq('user_id', user.id);
  if (!(roles || []).some((r) => r.role === 'admin' || r.role === 'finance')) {
    res.status(403).json({ error: 'Not authorised.' }); return null;
  }
  return user;
}

router.post('/confirm', async (req, res) => {
  const user = await requireStaff(req, res);
  if (!user) return;
  try {
    const { id, meetLink } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing booking id.' });
    const { data: b, error } = await supabase
      .from('express_bookings')
      .update({ status: 'confirmed', meet_link: (meetLink || '').trim() || null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!b) return res.status(404).json({ error: 'Booking not found.' });
    try { await sendExpressConfirmed(b); } catch (e) { console.error('[Express] confirm email:', e.message); }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[Express] confirm:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
