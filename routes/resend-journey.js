/**
 * POST /api/resend-journey
 * Body: { registrationId, emails: ['confirmation','admin','payment_deposit','payment_balance'] }
 *
 * Re-fires the registration journey emails for an EXISTING registration.
 *
 * Why this exists: a registration created outside the booking flow — an admin
 * enrolling someone by hand, a recovered signup, a payment taken offline — never
 * triggers the emails that /api/register and the ioTec webhook send. The founder
 * ends up paid-up and silent, having received nothing from us. This is the
 * recovery path, and the audit trail lands in email_log like any other send.
 *
 * Deliberately NOT included: hold_started. Telling a founder who has already paid
 * that their seat is "on hold" is worse than sending nothing.
 *
 * Admin/finance only — it sends mail in the platform's name to a real customer.
 */
const { createClient } = require('@supabase/supabase-js');
const {
  sendConfirmation, sendNewRegistrationAdmin, sendPaymentConfirmation, sendCohortSchedule,
} = require('../lib/emailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED = ['confirmation', 'admin', 'payment_deposit', 'payment_balance', 'schedule'];

async function isAuthorised(req) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret && req.headers['x-admin-secret'] === adminSecret) return true;
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return false;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(auth.slice(7));
    if (error || !user) return false;
    const { data: roles } = await supabase
      .from('user_roles').select('role').eq('user_id', user.id).in('role', ['admin', 'finance']);
    return !!(roles && roles.length);
  } catch { return false; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await isAuthorised(req))) return res.status(403).json({ error: 'Forbidden — admin or finance only' });

  const { registrationId } = req.body || {};
  const wanted = Array.isArray(req.body && req.body.emails)
    ? req.body.emails.filter(e => ALLOWED.includes(e))
    : [];

  if (!registrationId) return res.status(400).json({ error: 'registrationId is required' });
  if (!wanted.length) return res.status(400).json({ error: 'Pick at least one of: ' + ALLOWED.join(', ') });

  const { data: reg, error: regErr } = await supabase
    .from('registrations')
    .select('*, cohorts!registrations_cohort_id_fkey(*)')
    .eq('id', registrationId)
    .single();
  if (regErr || !reg) return res.status(404).json({ error: 'Registration not found' });

  // Don't send a payment receipt for money we have not actually recorded as received.
  if (wanted.includes('payment_deposit') && !reg.deposit_paid) {
    return res.status(400).json({ error: 'Deposit is not marked paid — confirm the payment first' });
  }
  if (wanted.includes('payment_balance') && !reg.balance_paid) {
    return res.status(400).json({ error: 'Balance is not marked paid — confirm the payment first' });
  }

  const results = {};
  for (const kind of wanted) {
    try {
      if (kind === 'schedule') {
        // The whole programme in one email — a founder should see the shape of the
        // five weeks, not assemble it from 25 separate reminders.
        const { data: sessions } = await supabase.from('sessions')
          .select('title, scheduled_at, duration_minutes')
          .eq('cohort_id', reg.cohort_id).eq('status', 'scheduled')
          .order('scheduled_at', { ascending: true });
        if (!sessions || !sessions.length) throw new Error('no sessions scheduled for this cohort yet');
        await sendCohortSchedule(reg, reg.cohorts, sessions);
      }
      else if (kind === 'confirmation') await sendConfirmation(reg, reg.cohorts);
      else if (kind === 'admin')        await sendNewRegistrationAdmin(reg, reg.cohorts);
      else if (kind === 'payment_deposit') await sendPaymentConfirmation(reg, reg.cohorts, 'deposit');
      else if (kind === 'payment_balance') await sendPaymentConfirmation(reg, reg.cohorts, 'balance');
      results[kind] = 'sent';
    } catch (e) {
      // One failure must not stop the rest — a partial send beats none, and the
      // caller can see exactly which one to retry.
      console.error('[resend-journey] ' + kind + ' failed:', e.message);
      results[kind] = 'FAILED: ' + e.message;
    }
  }

  const failed = Object.values(results).filter(v => String(v).startsWith('FAILED')).length;
  return res.status(failed === wanted.length ? 502 : 200).json({
    ok: failed === 0,
    registrationId,
    to: reg.email,
    results,
  });
};
