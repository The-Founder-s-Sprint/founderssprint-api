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
const { sendPaymentConfirmation, sendMentorConfirmed } = require('../lib/emailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Mentor session payment callback (externalId "FS-MENTOR-<requestId>") ────────
// Same authoritative model as registrations: re-fetch the transaction from ioTec,
// guard the amount, and only then flip the request to paid/confirmed + notify.
async function handleMentorCallback(res, { iotecId, extId }) {
  const m = String(extId).match(/^FS-MENTOR-(.+)$/i);
  let mreq = null;
  if (m) {
    const { data } = await supabase.from('mentor_session_requests').select('*').eq('id', m[1]).maybeSingle();
    mreq = data;
  }
  if (!mreq && iotecId) {
    const { data } = await supabase.from('mentor_session_requests').select('*').eq('payment_transaction_id', iotecId).maybeSingle();
    mreq = data;
  }
  if (!mreq) {
    console.error('[iotec-webhook] mentor request not found for', { iotecId, extId });
    return res.status(200).json({ ok: true, note: 'mentor request not found — logged' });
  }
  if (mreq.payment_status === 'paid') return res.status(200).json({ ok: true, note: 'Already paid' });

  const refId = iotecId || mreq.payment_transaction_id;
  if (!refId) return res.status(200).json({ ok: true, note: 'No transaction id to verify; left pending' });

  let tx;
  try { tx = await getTransaction(refId); }
  catch (e) {
    console.error('[iotec-webhook] mentor status re-fetch failed:', e.message);
    return res.status(200).json({ ok: true, note: 'Could not verify yet; left pending' });
  }
  if (!tx.terminal) return res.status(200).json({ ok: true, note: `In-flight (${tx.status}); left pending` });

  const expected = Number(mreq.amount_charged || mreq.quoted_fee);
  let internal = tx.internal;
  if (internal === 'success' && Number(tx.amount) !== expected) {
    console.error('[iotec-webhook] MENTOR AMOUNT MISMATCH', { req: mreq.id, expected, got: tx.amount });
    internal = 'discrepancy';   // do NOT confirm — finance review
  }

  if (internal !== 'success') {
    // failed → mark failed so staff can retry; discrepancy/other → leave pending + logged
    if (internal === 'failed') {
      await supabase.from('mentor_session_requests')
        .update({ payment_status: 'failed', payment_transaction_id: refId })
        .eq('id', mreq.id).eq('payment_status', 'pending');
    }
    return res.status(200).json({ ok: true, status: internal });
  }

  // verified success → confirm (idempotent), notify founder + admin
  const { data: updated } = await supabase.from('mentor_session_requests')
    .update({ payment_status: 'paid', paid_at: new Date().toISOString(), payment_transaction_id: refId, status: 'confirmed' })
    .eq('id', mreq.id).neq('payment_status', 'paid').select('*').maybeSingle();
  if (updated) {
    let mentor = null;
    try { const { data } = await supabase.from('mentors').select('name,title').eq('id', updated.mentor_id).single(); mentor = data; } catch (e) {}
    try { await sendMentorConfirmed(updated, mentor); } catch (e) { console.error('[iotec-webhook] mentor confirm email failed:', e.message); }
    console.log(`[iotec-webhook] ✓ mentor session paid + confirmed: ${updated.id}`);
  }
  return res.status(200).json({ ok: true, status: 'success' });
}

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

  // Mentor session payments take a separate path (their own table, not payment_requests).
  if (/^FS-MENTOR-/i.test(String(extId))) {
    return handleMentorCallback(res, { iotecId, extId });
  }

  // ── 2) Find the matching payment_request ──────────────────────────────────────
  // Match by ioTec id first, then FALL BACK to externalId. The fallback closes a race:
  // payment-request.js writes transaction_id to the row only AFTER ioTec's collect call
  // returns, but ioTec (especially in sandbox) can fire the callback before that write
  // commits. A transaction_id-only lookup would then miss and the callback would be
  // dropped (only the daily reconcile recovers it). externalId — "FS-DEPOSIT-<regId>" /
  // "FS-BALANCE-<regId>" — deterministically identifies the registration + payment type,
  // so it's a reliable fallback. Step 5 below stamps the authoritative transaction_id.
  async function findPaymentRequest() {
    if (iotecId) {
      const { data } = await supabase
        .from('payment_requests').select('*')
        .eq('transaction_id', iotecId)
        .order('initiated_at', { ascending: false }).limit(1).maybeSingle();
      if (data) return data;
    }
    const match = String(extId).match(/^FS-(DEPOSIT|BALANCE|DEP|BAL)-(\d+)$/i);
    if (match) {
      const paymentType = match[1].toUpperCase().startsWith('D') ? 'deposit' : 'balance';
      const { data } = await supabase
        .from('payment_requests').select('*')
        .eq('registration_id', parseInt(match[2], 10))
        .eq('payment_type', paymentType)
        .order('initiated_at', { ascending: false }).limit(1).maybeSingle();
      if (data) return data;
    }
    return null;
  }

  const payReq = await findPaymentRequest();
  if (!payReq) {
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
  // On deposit confirmation, clear the 72h seat hold (the seat is now permanently paid,
  // not merely held) so the registration's status reads 'deposit_paid' cleanly.
  const regUpdate = { [field]: true, updated_at: new Date().toISOString() };
  if (payReq.payment_type === 'deposit') { regUpdate.hold_expires_at = null; regUpdate.hold_lapsed_at = null; }
  const { data: reg, error: updateErr } = await supabase
    .from('registrations')
    .update(regUpdate)
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
      method:          payReq.method || 'mobile_money',
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
