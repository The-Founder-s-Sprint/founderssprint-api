/**
 * POST /api/mentor/charge   { requestId }
 *
 * Post-approval mentor payment. An admin/finance staffer clicks "Approve & charge"
 * in the Command Centre; this fires a single FULL-fee ioTec mobile-money prompt to
 * the founder's phone and records it as pending. The ioTec webhook
 * (externalId "FS-MENTOR-<id>") confirms it authoritatively and flips the request
 * to paid/confirmed, auto-notifying the founder + admin.
 *
 * Auth: bearer JWT validated against Supabase; caller must hold role admin or
 * finance. The amount is taken from the server-side quoted_fee (stamped at request
 * time) — never from the client. Service-role key stays server-side.
 */
const { createClient } = require('@supabase/supabase-js');
const { requestCollection } = require('../lib/iotec');
const { sendMentorPaymentRequested } = require('../lib/emailer');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function requireStaffPay(req, res, next) {
  try {
    const authz = req.headers.authorization || '';
    const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired session' });
    const { data: roles, error: rErr } = await supabase
      .from('user_roles').select('role').eq('user_id', user.id).in('role', ['admin', 'finance']);
    if (rErr) return res.status(500).json({ error: 'Role check failed' });
    if (!roles || !roles.length) return res.status(403).json({ error: 'Admin or finance only' });
    req.actor = { id: user.id, email: (user.email || '').toLowerCase() };
    next();
  } catch (e) {
    console.error('[mentor-charge] auth error:', e.message);
    return res.status(500).json({ error: 'Authorization check failed' });
  }
}

async function charge(req, res) {
  const { requestId } = req.body || {};
  if (!requestId) return res.status(400).json({ error: 'requestId required' });

  // Fetch the request (service role — bypasses RLS; we've already checked the caller is staff)
  const { data: reqRow, error: rErr } = await supabase
    .from('mentor_session_requests').select('*').eq('id', requestId).single();
  if (rErr || !reqRow) return res.status(404).json({ error: 'Request not found.' });
  if (reqRow.payment_status === 'paid') return res.status(409).json({ error: 'This session is already paid.' });

  const amount = reqRow.quoted_fee;   // authoritative, stamped server-side at request time
  if (!amount || amount <= 0) return res.status(400).json({ error: 'This request has no quoted fee to charge.' });
  if (!reqRow.founder_phone) return res.status(400).json({ error: 'No founder phone on file to charge.' });

  // Mentor label for the founder's email (public, PII-free fields only)
  let mentor = null;
  try {
    const { data } = await supabase.from('mentors').select('name,title').eq('id', reqRow.mentor_id).single();
    mentor = data || null;
  } catch (e) {}

  const externalId = `FS-MENTOR-${requestId}`;
  let iotec;
  try {
    iotec = await requestCollection({ phone: reqRow.founder_phone, amount, externalId, note: "Founder's Sprint mentor session" });
  } catch (e) {
    await supabase.from('mentor_session_requests').update({ payment_status: 'failed' }).eq('id', requestId);
    console.error('[mentor-charge] ioTec error:', e.message);
    return res.status(502).json({ error: 'Could not send the payment prompt. Please try again.', details: e.message });
  }

  await supabase.from('mentor_session_requests').update({
    payment_status:         'pending',
    amount_charged:         amount,
    payment_transaction_id: iotec.id,
    payment_ref:            externalId,
    status: (reqRow.status === 'new' || reqRow.status === 'contacted') ? 'scheduled' : reqRow.status,
  }).eq('id', requestId);

  // Notify the founder (non-blocking) — the STK prompt is already on their phone.
  sendMentorPaymentRequested({ ...reqRow, amount_charged: amount }, mentor)
    .catch(e => console.error('[mentor-charge] founder email failed:', e.message));

  return res.status(200).json({ ok: true, transactionId: iotec.id, amount });
}

module.exports = { requireStaffPay, charge };
