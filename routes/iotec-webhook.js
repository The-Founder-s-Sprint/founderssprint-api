/**
 * POST /api/iotec/webhook
 *
 * Receives payment callbacks from ioTec Pay (configured per-wallet in the ioTec portal:
 * Wallet → Settings → Callback URLs → Collection → this URL + a static security header).
 * ioTec POSTs here when a collection reaches Success / Failed / SentToVendor.
 *
 * Callback body (verified — identical to the Get-Status response, NOT a custom shape):
 *   { "id": "<uuid>", "status": "Success", "amount": 50000, "currency": "UGX", "externalId": "FS-DEPOSIT-42", ... }
 *
 * SECURITY (verified against the ioTec OpenAPI spec):
 *   ioTec does NOT sign callbacks — there is no HMAC/signature. The only callback auth is the
 *   STATIC header you set on the wallet (IOTEC_CALLBACK_SECRET). So we:
 *     1. verify that static header (constant-time),
 *     2. RE-FETCH the transaction from ioTec and trust THAT, never the POST body,
 *     3. verify the authoritative amount matches what we expected before crediting.
 */
const { createClient } = require('@supabase/supabase-js');
const { verifyCallbackHeader, getTransaction } = require('../lib/iotec');
const { sendPaymentConfirmation } = require('../lib/emailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── 1) Verify the static callback header (ioTec does not sign callbacks) ──────
  if (!verifyCallbackHeader(req)) {
    console.warn('[iotec-webhook] Bad/missing callback security header — rejected');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload  = req.body || {};
  const iotecId  = payload.id || null;                 // ioTec's canonical transaction id (uuid)
  const extId    = payload.externalId || payload.reference || '';

  if (!iotecId && !extId) {
    return res.status(400).json({ error: 'id or externalId is required' });
  }

  // ── 2) Find the matching payment_request ──────────────────────────────────────
  let query = supabase
    .from('payment_requests')
    .select('*')
    .order('initiated_at', { ascending: false })
    .limit(1);

  if (iotecId) {
    query = query.eq('transaction_id', iotecId);
  } else {
    const match = String(extId).match(/^FS-(DEPOSIT|BALANCE|DEP|BAL)-(\d+)$/i);
    if (!match) {
      console.error('[iotec-webhook] Cannot identify payment from payload:', payload);
      return res.status(400).json({ error: 'Cannot match payment request from payload' });
    }
    const paymentType = match[1].toUpperCase().startsWith('D') ? 'deposit' : 'balance';
    query = query.eq('registration_id', parseInt(match[2], 10)).eq('payment_type', paymentType);
  }

  const { data: payReq, error: findErr } = await query.maybeSingle();
  if (findErr || !payReq) {
    // 200 so ioTec stops retrying; we log + the reconcile cron is the safety net.
    console.error('[iotec-webhook] payment_request not found for', { iotecId, extId });
    return res.status(200).json({ ok: true, note: 'payment_request not found — logged' });
  }

  // ── 3) Idempotency: ignore if already resolved ────────────────────────────────
  if (payReq.status !== 'pending') {
    return res.status(200).json({ ok: true, note: 'Already processed' });
  }

  // ── 4) RE-FETCH authoritative status from ioTec (never trust the POST body) ────
  const refId = iotecId || payReq.transaction_id;
  if (!refId) {
    console.error('[iotec-webhook] No ioTec id to verify against — leaving pending');
    return res.status(200).json({ ok: true, note: 'No transaction id to verify; left pending' });
  }

  let tx;
  try {
    tx = await getTransaction(refId);
  } catch (e) {
    // Can't verify right now → leave pending; the reconcile cron will retry.
    console.error('[iotec-webhook] status re-fetch failed:', e.message);
    return res.status(200).json({ ok: true, note: 'Could not verify yet; left pending for reconcile' });
  }

  // Non-terminal (Pending / SentToVendor / …) → do NOT resolve. ioTec sends a callback on
  // SentToVendor too; resolving early would block the later Success.
  if (!tx.terminal) {
    return res.status(200).json({ ok: true, note: `In-flight (${tx.status}); left pending` });
  }

  // ── 5) Persist the resolution ─────────────────────────────────────────────────
  // Amount guard: on success the authoritative collected amount must match what we billed.
  const amountOk = Number(tx.amount) === Number(payReq.amount);
  let internal = tx.internal;
  if (internal === 'success' && !amountOk) {
    console.error('[iotec-webhook] AMOUNT MISMATCH', { pr: payReq.id, expected: payReq.amount, got: tx.amount });
    internal = 'discrepancy';   // do NOT credit — flag for finance review
  }

  await supabase
    .from('payment_requests')
    .update({
      status:         internal,
      transaction_id: refId,
      iotec_response: tx.raw,
      resolved_at:    new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    })
    .eq('id', payReq.id)
    .eq('status', 'pending');   // no-op if the reconcile cron resolved it first

  if (internal !== 'success') {
    console.log(`[iotec-webhook] ${internal} for registration#${payReq.registration_id} (pr#${payReq.id})`);
    return res.status(200).json({ ok: true, status: internal });
  }

  // ── 6) On verified success: mark the registration paid (idempotent) ───────────
  const field = payReq.payment_type === 'deposit' ? 'deposit_paid' : 'balance_paid';
  const { data: reg, error: updateErr } = await supabase
    .from('registrations')
    .update({ [field]: true, updated_at: new Date().toISOString() })
    .eq('id', payReq.registration_id)
    .eq(field, false)                 // idempotent: only if not already set (reconcile/webhook race)
    .select('*, cohorts!registrations_cohort_id_fkey(*)')
    .maybeSingle();

  if (updateErr) {
    console.error('[iotec-webhook] Failed to mark registration paid:', updateErr.message);
    return res.status(200).json({ ok: true, warning: 'Payment verified but registration update failed' });
  }

  if (reg) {
    await supabase.from('payment_events').insert({
      registration_id: payReq.registration_id,
      payment_type:    payReq.payment_type,
      amount:          payReq.amount,
      method:          'mobile_money',
      reference:       refId,
      note:            `ioTec callback — ${tx.status} (verified)`,
    });
    try { await sendPaymentConfirmation(reg, reg.cohorts, payReq.payment_type); }
    catch (emailErr) { console.error('[iotec-webhook] Confirmation email failed:', emailErr.message); }
    console.log(`[iotec-webhook] ✓ ${payReq.payment_type} marked paid for registration#${payReq.registration_id}`);
  } else {
    console.log(`[iotec-webhook] pr#${payReq.id} success but registration already paid (reconcile beat us) — ok`);
  }

  return res.status(200).json({ ok: true, status: 'success' });
};
