/**
 * POST /api/iotec/webhook
 *
 * Receives payment confirmation callbacks from ioTec Pay.
 * ioTec POSTs here after the customer completes (or cancels) the mobile money prompt.
 *
 * Expected payload from ioTec:
 * {
 *   transaction_id: "abc123",       // ioTec's transaction reference
 *   reference:      "FS-DEP-42",    // our reference passed in requestCollection()
 *   status:         "SUCCESSFUL",   // SUCCESSFUL | FAILED | CANCELLED
 *   amount:         50000,
 *   currency:       "UGX",
 *   phone_number:   "256712345678",
 *   timestamp:      "2024-05-01T10:00:00Z"
 * }
 *
 * Security: requests are verified with HMAC-SHA256 (X-Iotec-Signature header).
 * Set IOTEC_WEBHOOK_SECRET in Vercel env to match the secret configured in ioTec dashboard.
 */
const { createClient } = require('@supabase/supabase-js');
const { verifyWebhookSignature } = require('../lib/iotec');
const { sendPaymentConfirmation } = require('../lib/emailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Signature verification ────────────────────────────────────────────────────
  // Express with express.json() gives us req.body (parsed) but not the raw body.
  // We re-stringify for HMAC verification — this works when ioTec sends compact JSON.
  // For production, configure Express to expose rawBody (or use a raw middleware).
  const rawBody = JSON.stringify(req.body);
  const sig     = req.headers['x-iotec-signature'] || req.headers['x-signature'] || '';

  if (!verifyWebhookSignature(rawBody, sig)) {
    console.warn('[iotec-webhook] Invalid signature — request rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = req.body || {};
  const {
    transaction_id: transactionId,
    reference,
    status: rawStatus,
  } = payload;

  if (!transactionId && !reference) {
    return res.status(400).json({ error: 'transaction_id or reference is required' });
  }

  // Normalise ioTec status to our internal values
  const statusMap = {
    SUCCESSFUL:  'success',
    SUCCESS:     'success',
    COMPLETED:   'success',
    FAILED:      'failed',
    FAILURE:     'failed',
    CANCELLED:   'cancelled',
    CANCELED:    'cancelled',
    EXPIRED:     'expired',
  };
  const internalStatus = statusMap[(rawStatus || '').toUpperCase()] || 'failed';

  // ── Find the matching payment_request record ──────────────────────────────────
  let query = supabase
    .from('payment_requests')
    .select('*')
    .order('initiated_at', { ascending: false })
    .limit(1);

  if (transactionId) {
    query = query.eq('transaction_id', transactionId);
  } else {
    // Fall back: parse our reference format "FS-{TYPE}-{regId}"
    const match = (reference || '').match(/^FS-(DEPOSIT|BALANCE|DEP|BAL)-(\d+)$/i);
    if (match) {
      const paymentType = match[1].startsWith('D') ? 'deposit' : 'balance';
      const regId = parseInt(match[2], 10);
      query = query.eq('registration_id', regId).eq('payment_type', paymentType);
    } else {
      console.error('[iotec-webhook] Cannot identify payment from payload:', payload);
      return res.status(400).json({ error: 'Cannot match payment request from payload' });
    }
  }

  const { data: payReq, error: findErr } = await query.single();

  if (findErr || !payReq) {
    // ioTec may retry — return 200 to stop retries, but log the issue
    console.error('[iotec-webhook] payment_request not found for', { transactionId, reference });
    return res.status(200).json({ ok: true, note: 'payment_request not found — logged' });
  }

  // ── Idempotency: ignore duplicate callbacks ───────────────────────────────────
  if (payReq.status !== 'pending') {
    console.log(`[iotec-webhook] Already resolved: payment_request#${payReq.id} (${payReq.status})`);
    return res.status(200).json({ ok: true, note: 'Already processed' });
  }

  // ── Update payment_request ────────────────────────────────────────────────────
  await supabase
    .from('payment_requests')
    .update({
      status:         internalStatus,
      transaction_id: transactionId || payReq.transaction_id,
      iotec_response: payload,
      resolved_at:    new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    })
    .eq('id', payReq.id);

  // ── On success: mark registration as paid ────────────────────────────────────
  if (internalStatus === 'success') {
    const field = payReq.payment_type === 'deposit' ? 'deposit_paid' : 'balance_paid';

    const { data: reg, error: updateErr } = await supabase
      .from('registrations')
      .update({ [field]: true, updated_at: new Date().toISOString() })
      .eq('id', payReq.registration_id)
      .select('*, cohorts(*)')
      .single();

    if (updateErr) {
      console.error('[iotec-webhook] Failed to mark registration paid:', updateErr.message);
      // Still return 200 — payment was received, we'll fix the DB manually
      return res.status(200).json({ ok: true, warning: 'Payment received but registration update failed' });
    }

    // Log to payment_events
    await supabase.from('payment_events').insert({
      registration_id: payReq.registration_id,
      payment_type:    payReq.payment_type,
      amount:          payReq.amount,
      method:          'mobile_money',
      reference:       transactionId || reference,
      note:            `ioTec webhook — ${rawStatus}`,
    });

    // Send confirmation email
    try {
      await sendPaymentConfirmation(reg, reg.cohorts, payReq.payment_type);
    } catch (emailErr) {
      console.error('[iotec-webhook] Confirmation email failed:', emailErr.message);
      // Non-fatal — payment IS confirmed
    }

    console.log(
      `[iotec-webhook] ✓ ${payReq.payment_type} marked paid for registration#${payReq.registration_id}`
    );
  } else {
    console.log(
      `[iotec-webhook] ✗ Payment ${internalStatus} for registration#${payReq.registration_id}`
    );
  }

  // Always return 200 to ioTec (non-200 triggers retries)
  return res.status(200).json({ ok: true, status: internalStatus });
};
