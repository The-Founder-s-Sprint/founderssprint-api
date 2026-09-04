/**
 * POST /api/confirm-payment
 * Body: { registrationId, paymentType: 'deposit'|'balance', method?, reference?, note? }
 *
 * Marks a deposit or balance as paid, logs the payment event,
 * and sends a confirmation email to the registrant.
 */
const { createClient } = require('@supabase/supabase-js');
const { sendPaymentConfirmation } = require('../lib/emailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Manual payment confirmation is an ADMIN/FINANCE override (cash, off-platform settlement).
// It must never be public: it sets deposit_paid/balance_paid, which gate materials + access.
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

  if (!(await isAuthorised(req))) {
    return res.status(403).json({ error: 'Forbidden — admin or finance only' });
  }

  const { registrationId, paymentType, method, reference, note } = req.body || {};

  if (!registrationId || !['deposit', 'balance'].includes(paymentType)) {
    return res.status(400).json({ error: 'registrationId and paymentType (deposit|balance) are required' });
  }

  // Fetch registration + cohort
  const { data: reg, error: regErr } = await supabase
    .from('registrations')
    .select('*, cohorts!registrations_cohort_id_fkey(*)')
    .eq('id', registrationId)
    .single();

  if (regErr || !reg) return res.status(404).json({ error: 'Registration not found' });

  const field     = paymentType === 'deposit' ? 'deposit_paid' : 'balance_paid';
  const amount    = paymentType === 'deposit' ? reg.deposit_amount : reg.balance_amount;

  // Mark as paid
  const { error: updateErr } = await supabase
    .from('registrations')
    .update({ [field]: true, updated_at: new Date().toISOString() })
    .eq('id', registrationId);

  if (updateErr) return res.status(500).json({ error: 'Failed to update payment status' });

  // Log payment event
  await supabase.from('payment_events').insert({
    registration_id: registrationId,
    payment_type:    paymentType,
    amount,
    method:          method || null,
    reference:       reference || null,
    note:            note || null,
  });

  // Book the settlement (80/20 split + coach earnings).
  // The ioTec webhook does this for online payments; without it here, an offline
  // payment marks the founder paid but the coach's share is never booked — the
  // money silently vanishes from coach earnings and the platform cut.
  // settle_registration_payment is idempotent (returns the existing settlement
  // for the same registration+payment_type), so a retry can't double-book.
  // NOTE: supabase.rpc() RESOLVES with { error } on a DB error — it does not throw.
  // Check the returned error explicitly; a bare try/catch here would silently pass.
  let settled = true;
  try {
    const { error: setErr } = await supabase.rpc('settle_registration_payment', {
      p_reg_id: registrationId,
      p_payment_type: paymentType,
    });
    if (setErr) { settled = false; console.error('[confirm-payment] settlement failed:', setErr.message); }
  } catch (thrown) {
    settled = false;
    console.error('[confirm-payment] settlement threw:', thrown.message);
  }
  // Don't fail the request — the payment IS confirmed; settlement can be re-run.
  // `settled` is surfaced in the response so the dashboard can warn finance.

  // Send payment confirmation email
  try {
    await sendPaymentConfirmation(reg, reg.cohorts, paymentType);
  } catch (emailErr) {
    console.error('[confirm-payment] Email failed:', emailErr.message);
    // Don't fail the request — payment is confirmed, email is secondary
  }

  return res.status(200).json({
    ok: true,
    settled,
    message: `${paymentType} marked as paid for registration #${registrationId}`
      + (settled ? '' : ' — WARNING: settlement not booked, tell finance to re-run it'),
  });
};
