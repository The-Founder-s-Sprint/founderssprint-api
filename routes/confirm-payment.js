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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { registrationId, paymentType, method, reference, note } = req.body || {};

  if (!registrationId || !['deposit', 'balance'].includes(paymentType)) {
    return res.status(400).json({ error: 'registrationId and paymentType (deposit|balance) are required' });
  }

  // Fetch registration + cohort
  const { data: reg, error: regErr } = await supabase
    .from('registrations')
    .select('*, cohorts(*)')
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

  // Send payment confirmation email
  try {
    await sendPaymentConfirmation(reg, reg.cohorts, paymentType);
  } catch (emailErr) {
    console.error('[confirm-payment] Email failed:', emailErr.message);
    // Don't fail the request — payment is confirmed, email is secondary
  }

  return res.status(200).json({
    ok: true,
    message: `${paymentType} marked as paid for registration #${registrationId}`,
  });
};
