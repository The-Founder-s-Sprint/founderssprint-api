/**
 * POST /api/card-payment-request
 *
 * Initiates an ioTec CARD collection (Visa/MasterCard via PegPay) for a registration.
 * Unlike mobile money there is no STK push — ioTec returns a hosted PegPay page URL
 * (`redirectUrl` in our response) that the client must redirect the customer's browser to.
 * On completion PegPay returns the browser to our card-return page AND ioTec fires the
 * SAME webhook (/api/iotec/webhook), so crediting reuses the existing webhook + reconcile
 * path with no changes — the externalId scheme (FS-DEPOSIT-<regId> / FS-BALANCE-<regId>)
 * is identical to the mobile-money path.
 *
 * Body:
 *   registrationId  {number}
 *   paymentType     {string}  'deposit' | 'balance'
 *   email           {string}  customer email (the PegPay payer)
 *   name            {string}  customer name (optional, populates the PegPay form)
 *
 * On success:
 *   { ok: true, transactionId, redirectUrl, amount, currency }
 *   → client does `window.location = redirectUrl` to send the payer to PegPay
 */
const { createClient } = require('@supabase/supabase-js');
const { requestCardCollection } = require('../lib/iotec');
const { sendHoldStarted } = require('../lib/emailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Where PegPay returns the customer's browser after payment completes.
const SITE_BASE = process.env.SITE_BASE_URL || 'https://founderssprint.co';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { registrationId, paymentType, email, name } = req.body || {};

  // ── Validate input ────────────────────────────────────────────────────────────
  if (!registrationId || !['deposit', 'balance'].includes(paymentType) || !email) {
    return res.status(400).json({
      error: 'registrationId, paymentType (deposit|balance), and email are required.',
    });
  }
  if (!EMAIL_RE.test(String(email))) {
    return res.status(400).json({ error: 'A valid email address is required for card payments.' });
  }

  // ── Fetch registration + cohort ───────────────────────────────────────────────
  const { data: reg, error: regErr } = await supabase
    .from('registrations')
    .select('*, cohorts!registrations_cohort_id_fkey(*)')
    .eq('id', registrationId)
    .single();

  if (regErr || !reg) return res.status(404).json({ error: 'Registration not found.' });

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

  // ── Reserve the seat with a 72h hold BEFORE the card page (deposit only) ──────
  // Same as the mobile-money path: writing hold_expires_at trips the capacity trigger,
  // so a full cohort is rejected here (never send a payer to PegPay for a lost seat),
  // and the later webhook deposit_paid flip can't fail on capacity.
  const HOLD_HOURS = 72;
  const firstHold  = paymentType === 'deposit' && !reg.deposit_paid && (!reg.held_at || !!reg.hold_lapsed_at);
  let holdReg = reg;
  if (paymentType === 'deposit' && !reg.deposit_paid) {
    const nowIso      = new Date().toISOString();
    const holdExpires = new Date(Date.now() + HOLD_HOURS * 3600 * 1000).toISOString();
    const { data: hr, error: holdErr } = await supabase
      .from('registrations')
      .update({
        hold_expires_at:     holdExpires,
        held_at:             reg.held_at || nowIso,
        hold_reminders_sent: 0,
        hold_reminded_at:    null,
        hold_lapsed_at:      null,
        updated_at:          nowIso,
      })
      .eq('id', reg.id)
      .select('*, cohorts!registrations_cohort_id_fkey(*)')
      .maybeSingle();
    if (holdErr) {
      const full = /COHORT_FULL/i.test(holdErr.message || '');
      return res.status(full ? 409 : 500).json({
        error: full
          ? 'That cohort just filled up — this seat is no longer available. Please choose another cohort.'
          : 'Could not reserve your seat. Please try again.',
      });
    }
    if (hr) holdReg = hr;
  }

  const reference   = `FS-${paymentType.toUpperCase()}-${registrationId}`;
  const description = paymentType === 'deposit'
    ? `Founder's Sprint deposit — ${cohort?.name || 'upcoming cohort'}`
    : `Founder's Sprint balance — ${cohort?.name || 'upcoming cohort'}`;
  const redirectUrl = `${SITE_BASE}/card-return.html?ref=${encodeURIComponent(reference)}`;

  // ── Prevent double-charging: an existing recent pending request ───────────────
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
      return res.status(202).json({
        ok: true, pending: true,
        message: 'A payment is already in progress. Complete it on the card page, or try again shortly.',
      });
    }
  }

  // ── Record the request BEFORE calling ioTec (paper trail) ─────────────────────
  // `phone` is NOT NULL on payment_requests; for card the payer is the email, so we
  // store it there too (and in payer_email) and mark method='card'.
  const { data: payReq, error: insertErr } = await supabase
    .from('payment_requests')
    .insert({
      registration_id: registrationId,
      payment_type:    paymentType,
      phone:           String(email).trim(),
      payer_email:     String(email).trim(),
      method:          'card',
      amount,
    })
    .select()
    .single();

  if (insertErr) {
    console.error('[card-payment-request] DB insert error:', insertErr.message);
    return res.status(500).json({ error: 'Failed to create payment request.' });
  }

  // ── Call ioTec (PegPay card) ──────────────────────────────────────────────────
  let iotecResult;
  try {
    iotecResult = await requestCardCollection({
      email, name, amount, externalId: reference, note: description, redirectUrl,
    });
  } catch (err) {
    console.error('[card-payment-request] ioTec error:', err.message);
    await supabase
      .from('payment_requests')
      .update({ status: 'failed', iotec_response: { error: err.message }, resolved_at: new Date().toISOString() })
      .eq('id', payReq.id);
    return res.status(502).json({
      error: 'Failed to start card payment. Please try again or pay by mobile money.',
      details: err.message,
    });
  }

  if (!iotecResult.cardRedirectUrl) {
    // No hosted-page URL means we can't send the payer anywhere — treat as a failure.
    console.error('[card-payment-request] No cardRedirectUrl returned:', JSON.stringify(iotecResult.raw));
    await supabase
      .from('payment_requests')
      .update({ status: 'failed', transaction_id: iotecResult.id, iotec_response: iotecResult.raw, resolved_at: new Date().toISOString() })
      .eq('id', payReq.id);
    return res.status(502).json({ error: 'Card payment could not be started (no redirect URL from provider).' });
  }

  // ── Stamp ioTec's transaction id + raw response ───────────────────────────────
  await supabase
    .from('payment_requests')
    .update({
      transaction_id: iotecResult.id,
      iotec_response: iotecResult.raw,
      updated_at:     new Date().toISOString(),
    })
    .eq('id', payReq.id);

  // Held email — fired once per fresh hold, after ioTec returned a valid card page.
  if (firstHold) {
    try { await sendHoldStarted(holdReg, holdReg.cohorts); }
    catch (e) { console.error('[card-payment-request] hold email failed:', e.message); }
  }

  return res.status(200).json({
    ok:            true,
    transactionId: iotecResult.id,
    redirectUrl:   iotecResult.cardRedirectUrl,   // client redirects the browser here (PegPay)
    amount,
    currency:      process.env.IOTEC_CURRENCY || 'UGX',
    message:       'Redirecting you to the secure card payment page…',
  });
};
