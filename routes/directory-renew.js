/**
 * Directory renewal — payment-gated (ioTec).
 *
 *   GET  /api/directory/renew-context?p=<providerId>&t=<token>
 *        Public. Validates the opaque token (stored server-side only in
 *        directory_renewals) and returns the provider + the LIVE price for its tier,
 *        computed server-side from the traffic-band rate card. Never trusts a client price.
 *
 *   POST /api/directory/renew   { providerId, token, method, phone|email, name }
 *        Public, token-gated, rate-limited. Re-computes the price server-side, opens an
 *        ioTec MoMo (STK push) or card (PegPay redirect) collection with externalId
 *        "FS-DIR-<renewalId>". The webhook (iotec-webhook.js) confirms it authoritatively
 *        and extends the listing.
 *
 *   POST /api/directory/send-renew-link   { providerId }
 *        Admin/finance only. Mints a fresh renewal token and emails the provider a link
 *        to the renew page (also returns the link so the console can copy it).
 *
 * The price is ALWAYS taken from directory_current_rate() server-side — a client-supplied
 * amount is ignored. The token lives only in directory_renewals (service-role table), so it
 * is never exposed through the anon-readable directory_providers row.
 */
const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { requestCollection, requestCardCollection } = require('../lib/iotec');
const { sendDirectoryRenewLink } = require('../lib/emailer');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SITE_BASE = process.env.SITE_BASE_URL || 'https://founderssprint.co';

// Renewal term per tier (months). Basic is free → no renewal. Mirrors directory-lifecycle.js.
const TIER_MONTHS = { verified: 3, featured: 3, corporate: 12 };
const TIER_LABELS = { verified: 'Verified Partner', featured: 'Featured Partner', corporate: 'Programme Sponsor' };

// Live price for a tier from the traffic-band rate card (server-side, authoritative).
async function rateForTier(tier) {
  const { data, error } = await supabase.rpc('directory_current_rate');
  if (error || !data) return null;
  const price = tier === 'featured' ? data.featured
              : tier === 'corporate' ? data.corporate
              : data.verified;
  return { price, band_id: data.band_id, band_label: data.band_label, monthly_reach: data.monthly_reach };
}

// Corporate/sponsor tiers are bespoke (no rate-card price) → point them at the team.
function bespokeOrUnavailable(tier) {
  return tier === 'corporate'
    ? 'Sponsor & corporate renewals are arranged directly with our team — please email hello@founderssprint.co.'
    : 'Renewal pricing is unavailable right now. Please try again shortly.';
}

// Find the newest un-consumed renewal row matching provider + token (+ its provider).
async function findRenewal(providerId, token) {
  const { data } = await supabase
    .from('directory_renewals')
    .select('*, provider:directory_providers!inner(id,company_name,tier,email,status)')
    .eq('provider_id', providerId)
    .eq('token', token)
    .is('used_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

// Bearer-JWT staff gate (admin or finance) — mirrors routes/mentor-charge.js.
async function requireStaffPay(req, res, next) {
  try {
    const authz = req.headers['authorization'] || '';
    const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid session' });
    const { data: roles } = await supabase
      .from('user_roles').select('role').eq('user_id', user.id).in('role', ['admin', 'finance']);
    if (!roles || !roles.length) return res.status(403).json({ error: 'Admin or finance only' });
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Auth failed' });
  }
}

// ── GET /api/directory/renew-context ─────────────────────────────────────────
router.get('/directory/renew-context', async (req, res) => {
  const { p, t } = req.query;
  if (!p || !t) return res.status(400).json({ error: 'Missing renewal token.' });

  const r = await findRenewal(p, t);
  if (!r) return res.status(404).json({ error: 'This renewal link is invalid or has already been used.' });

  const tier   = r.provider.tier;
  const months = TIER_MONTHS[tier];
  if (!months) return res.status(400).json({ error: 'This is a free listing — no renewal needed.' });

  const rate = await rateForTier(tier);
  if (!rate || !rate.price) return res.status(400).json({ error: bespokeOrUnavailable(tier) });

  return res.json({
    ok:            true,
    company_name:  r.provider.company_name,
    tier,
    tier_label:    TIER_LABELS[tier] || tier,
    months,
    amount:        rate.price,
    monthly_reach: rate.monthly_reach,
    band_label:    rate.band_label,
    currency:      process.env.IOTEC_CURRENCY || 'UGX',
    already_paid:  r.status === 'success',
  });
});

// ── POST /api/directory/renew ────────────────────────────────────────────────
router.post('/directory/renew', async (req, res) => {
  const { providerId, token, method, phone, email, name } = req.body || {};
  if (!providerId || !token) return res.status(400).json({ error: 'Missing renewal token.' });

  const r = await findRenewal(providerId, token);
  if (!r) return res.status(404).json({ error: 'This renewal link is invalid or has already been used.' });
  if (r.status === 'success') return res.status(409).json({ error: 'This renewal has already been paid.' });
  if (r.status === 'pending' && r.transaction_id) {
    return res.status(202).json({ ok: true, pending: true, message: 'A payment is already in progress — complete it on your phone.' });
  }

  const tier   = r.provider.tier;
  const months = TIER_MONTHS[tier];
  if (!months) return res.status(400).json({ error: 'This is a free listing — no renewal needed.' });

  const rate = await rateForTier(tier);
  const amount = rate && rate.price;
  if (!amount || amount <= 0) return res.status(400).json({ error: bespokeOrUnavailable(tier) });

  const externalId = `FS-DIR-${r.id}`;
  // Snapshot the server-computed amount + band + method BEFORE charging.
  await supabase.from('directory_renewals').update({
    amount, band_id: rate.band_id, monthly_reach: rate.monthly_reach, months, tier,
    method: method === 'card' ? 'card' : 'mobile_money',
    status: 'pending', charged_at: new Date().toISOString(),
  }).eq('id', r.id);

  try {
    if (method === 'card') {
      const payerEmail = String(email || r.provider.email || '').trim();
      if (!payerEmail) return res.status(400).json({ error: 'An email is required for card payment.' });
      const redirectUrl = `${SITE_BASE}/directory-renew.html?p=${providerId}&t=${token}&paid=1`;
      const io = await requestCardCollection({
        email: payerEmail, name: name || r.provider.company_name, amount, externalId,
        note: `Founder's Sprint directory renewal — ${r.provider.company_name}`, redirectUrl,
      });
      await supabase.from('directory_renewals').update({ transaction_id: io.id }).eq('id', r.id);
      if (!io.cardRedirectUrl) throw new Error('No card redirect URL from provider');
      return res.json({ ok: true, method: 'card', redirectUrl: io.cardRedirectUrl, amount });
    }
    // mobile money (default)
    if (!phone) return res.status(400).json({ error: 'A mobile money number is required.' });
    const io = await requestCollection({
      phone, amount, externalId,
      note: `Founders Sprint directory renewal ${r.provider.company_name}`,
    });
    await supabase.from('directory_renewals').update({ transaction_id: io.id }).eq('id', r.id);
    return res.json({ ok: true, method: 'mobile_money', transactionId: io.id, amount, currency: process.env.IOTEC_CURRENCY || 'UGX' });
  } catch (e) {
    console.error('[directory/renew] ioTec error:', e.message);
    await supabase.from('directory_renewals').update({ status: 'failed', resolved_at: new Date().toISOString() }).eq('id', r.id);
    return res.status(502).json({ error: 'Could not start the payment. Please try again.', details: e.message });
  }
});

// ── POST /api/directory/send-renew-link (admin/finance) ──────────────────────
router.post('/directory/send-renew-link', requireStaffPay, async (req, res) => {
  const { providerId } = req.body || {};
  if (!providerId) return res.status(400).json({ error: 'Missing providerId' });

  const { data: p } = await supabase.from('directory_providers').select('*').eq('id', providerId).maybeSingle();
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  const months = TIER_MONTHS[p.tier];
  if (!months) return res.status(400).json({ error: 'Basic listings are free — nothing to renew.' });

  const { data: row, error } = await supabase
    .from('directory_renewals')
    .insert({ provider_id: providerId, tier: p.tier, months })
    .select().single();
  if (error) return res.status(500).json({ error: 'Could not create renewal: ' + error.message });

  const link = `${SITE_BASE}/directory-renew.html?p=${providerId}&t=${row.token}`;
  let emailed = false;
  if (p.email) {
    try { await sendDirectoryRenewLink(p, link); emailed = true; }
    catch (e) { console.error('[directory/send-renew-link] email failed:', e.message); }
  }
  return res.json({ ok: true, link, emailed });
});

// ── GET /api/directory/renew-status ──────────────────────────────────────────
// Token-scoped poll for the renew page (returns even after the token is consumed).
router.get('/directory/renew-status', async (req, res) => {
  const { p, t } = req.query;
  if (!p || !t) return res.status(400).json({ error: 'Missing renewal token.' });
  const { data } = await supabase
    .from('directory_renewals')
    .select('status, provider:directory_providers!inner(status, expires_at)')
    .eq('provider_id', p).eq('token', t)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return res.status(404).json({ error: 'Not found.' });
  return res.json({
    ok: true,
    status: data.status,
    listing_active: data.provider.status === 'active',
    expires_at: data.provider.expires_at,
  });
});

module.exports = router;
