/**
 * POST /api/payment-request
 *
 * Initiates an ioTec mobile money collection (STK push) for a registration.
 *
 * Body:
 *   registrationId  {number}  — ID returned by POST /api/register
 *   paymentType     {string}  — 'deposit' or 'balance'
 *   phone           {string}  — customer's MTN / Airtel number (e.g. 0712345678)
 *
 * On success:
 *   { ok: true, transactionId, network, message }
 *   → customer gets a payment prompt on their phone
 *   → ioTec POSTs confirmation to /api/iotec/webhook
 */
const { createClient } = require('@supabase/supabase-js');
const { requestCollection, normalisePhone, detectNetwork } = require('../lib/iotec');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// The public Vercel URL — used as the webhook callback for ioTec
const API_BASE = process.env.API_BASE_URL || 'https://founders-sprint-api.vercel.app';

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { registrationId, paymentType, phone } = req.body || {};

  // ── Validate input ────────────────────────────────────────────────────────────
  if (!registrationId || !['deposit', 'balance'].includes(paymentType) || !phone) {
    return res.status(400).json({
      error: 'registrationId, paymentType (deposit|balance), and phone are required.',
    });
  }

  // ── Fetch registration + cohort ───────────────────────────────────────────────
  const { data: reg, error: regErr } = await supabase
    .from('registrations')
    .select('*, cohorts(*)')
    .eq('id', registrationId)
    .single();

  if (regErr || !reg) {
    return res.status(404).json({ error: 'Registration not found.' });
  }

  // Guard: don't charge an already-paid field
  if (paymentType === 'deposit' && reg.deposit_paid) {
    return res.status(409).json({ error: 'Deposit has already been paid.' });
  }
  if (paymentType === 'balance' && reg.balance_paid) {
    return res.status(409).json({ error: 'Balance has already been paid.' });
  }

  // Guard: can't pay balance before deposit
  if (paymentType === 'balance' && !reg.deposit_paid) {
    return res.status(409).json({ error: 'Deposit must be paid before the balance.' });
  }

  const amount = paymentType === 'deposit' ? reg.deposit_amount : reg.balance_amount;
  const cohort = reg.cohorts;

  const reference   = `FS-${paymentType.toUpperCase()}-${registrationId}`;
  const description = paymentType === 'deposit'
    ? `Founder's Sprint deposit — ${cohort?.name || 'upcoming cohort'}`
    : `Founder's Sprint balance — ${cohort?.name || 'upcoming cohort'}`;

  const callbackUrl = `${API_BASE}/api/iotec/webhook`;

  // ── Check for an existing pending request (prevent double-charging) ───────────
  const { data: existing } = await supabase
    .from('payment_requests')
    .select('id, status, initiated_at')
    .eq('registration_id', registrationId)
    .eq('payment_type', paymentType)
    .eq('status', 'pending')
    .order('initiated_at', { ascending: false })
    .limit(1)
    .single();

  if (existing) {
    const ageMinutes = (Date.now() - new Date(existing.initiated_at).getTime()) / 60000;
    if (ageMinutes < 5) {
      // Recent pending request — tell the client to wait
      return res.status(202).json({
        ok:      true,
        pending: true,
        message: 'A payment request is already in progress. Check your phone and enter your PIN.',
      });
    }
    // Older than 5 minutes → treat as expired, allow retry
  }

  // ── Record the request in DB (before calling ioTec, so we have a paper trail) ─
  const { data: payReq, error: insertErr } = await supabase
    .from('payment_requests')
    .insert({
      registration_id: registrationId,
      payment_type:    paymentType,
      phone:           normalisePhone(phone),
      amount,
    })
    .select()
    .single();

  if (insertErr) {
    console.error('[payment-request] DB insert error:', insertErr.message);
    return res.status(500).json({ error: 'Failed to create payment request.' });
  }

  // ── Call ioTec Pay ────────────────────────────────────────────────────────────
  let iotecResult;
  try {
    iotecResult = await requestCollection({
      phone, amount, reference, description, callbackUrl,
    });
  } catch (err) {
    console.error('[payment-request] ioTec error:', err.message);

    // Mark the DB record as failed
    await supabase
      .from('payment_requests')
      .update({ status: 'failed', iotec_response: { error: err.message }, resolved_at: new Date().toISOString() })
      .eq('id', payReq.id);

    return res.status(502).json({
      error: 'Failed to send payment request. Please try again or pay manually.',
      details: err.message,
    });
  }

  // ── Update record with ioTec's transaction ID ─────────────────────────────────
  await supabase
    .from('payment_requests')
    .update({
      transaction_id: iotecResult.transactionId,
      iotec_response: iotecResult.raw,
      updated_at:     new Date().toISOString(),
    })
    .eq('id', payReq.id);

  const network = detectNetwork(phone);

  return res.status(200).json({
    ok:            true,
    transactionId: iotecResult.transactionId,
    network,
    amount,
    currency:      'UGX',
    message:       `Payment request sent to your ${network} number. Check your phone and enter your PIN to confirm.`,
  });
};
