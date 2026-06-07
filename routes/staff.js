const express = require('express');
const router  = express.Router();
const { supabase } = require('../lib/db');
const { sendStaffInvite } = require('../lib/emailer');

// Human labels for the scoped staff roles (DB value -> display).
const ROLE_LABELS = {
  admin:            'Super Admin',
  finance:          'Finance',
  coach_support:    'Coach Support',
  investor_support: 'Investor Support',
  founder_support:  'Founder Support',
  hub_partner:      'Partner',
};
const ALLOWED_ROLES = Object.keys(ROLE_LABELS);
const COMPANY_DOMAIN = '@founderssprint.co';

// ── Auth: caller must be a validated super-admin ─────────────────────────────
// Validates the Supabase JWT for real (never length-based) and checks the
// user_roles table for an 'admin' row. Service-role key stays server-side.
async function requireSuperAdmin(req, res, next) {
  try {
    const authz = req.headers.authorization || '';
    const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired session' });

    const { data: roles, error: rErr } = await supabase
      .from('user_roles').select('role').eq('user_id', user.id).eq('role', 'admin').limit(1);
    if (rErr) return res.status(500).json({ error: 'Role check failed' });
    if (!roles || !roles.length) return res.status(403).json({ error: 'Super-admin only' });

    req.actor = { id: user.id, email: (user.email || '').toLowerCase() };
    next();
  } catch (e) {
    console.error('[staff] auth error:', e.message);
    return res.status(500).json({ error: 'Authorization check failed' });
  }
}

// ── POST /api/staff/invite — create-or-update a staff account + grant role(s) ──
router.post('/invite', requireSuperAdmin, async (req, res) => {
  try {
    let { email, roles, name } = req.body || {};
    email = String(email || '').trim().toLowerCase();

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return res.status(400).json({ error: 'A valid email is required' });
    if (!email.endsWith(COMPANY_DOMAIN))
      return res.status(400).json({ error: `Staff access is limited to ${COMPANY_DOMAIN} company emails` });

    roles = Array.isArray(roles) ? roles : (roles ? [roles] : []);
    roles = [...new Set(roles)].filter(r => ALLOWED_ROLES.includes(r));
    if (!roles.length) return res.status(400).json({ error: 'Select at least one valid role' });

    const redirectTo = process.env.STAFF_SET_PASSWORD_URL || 'https://founderssprint.co/set-password.html';

    // Create-or-find the auth account and get a single-use action link.
    let existingAccount = false;
    let gen = await supabase.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } });
    if (gen.error) {
      const m = (gen.error.message || '').toLowerCase();
      if (m.includes('already') || m.includes('registered') || m.includes('exist')) {
        existingAccount = true;
        gen = await supabase.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
        if (gen.error) throw new Error(gen.error.message);
      } else {
        throw new Error(gen.error.message);
      }
    }
    const actionUrl = gen.data?.properties?.action_link;
    const userId    = gen.data?.user?.id;
    if (!actionUrl || !userId) throw new Error('Could not generate the invite link');

    // Grant the role(s) — idempotent (unique on user_id,role).
    const { error: upErr } = await supabase
      .from('user_roles')
      .upsert(roles.map(r => ({ user_id: userId, role: r })), { onConflict: 'user_id,role', ignoreDuplicates: true });
    if (upErr) throw new Error('Role grant failed: ' + upErr.message);

    // Audit (one row per role granted).
    await supabase.from('audit_log').insert(roles.map(r => ({
      actor_user_id: req.actor.id, actor_email: req.actor.email,
      action: 'staff.invite', target_email: email, target_user_id: userId, role: r,
      detail: { existing_account: existingAccount },
    })));

    // Branded invite email via Mandrill.
    const roleLabel = roles.map(r => ROLE_LABELS[r]).join(', ');
    const emailRes = await sendStaffInvite({
      to: email,
      name: (name && String(name).trim()) || email.split('@')[0],
      roleLabel, rolePlural: roles.length > 1, actionUrl, existingAccount,
    });

    return res.json({ ok: true, created: !existingAccount, roles, emailed: !!emailRes.ok });
  } catch (e) {
    console.error('[staff/invite]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── POST /api/staff/disable — offboard: revoke all roles + ban the account ─────
router.post('/disable', requireSuperAdmin, async (req, res) => {
  try {
    const userId = String((req.body || {}).user_id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return res.status(400).json({ error: 'Valid user_id required' });
    if (userId === req.actor.id) return res.status(400).json({ error: 'You cannot disable your own account' });

    // Capture roles before deletion for the audit trail.
    const { data: had } = await supabase.from('user_roles').select('role').eq('user_id', userId);
    const hadRoles = (had || []).map(r => r.role);

    await supabase.from('user_roles').delete().eq('user_id', userId);
    const { error: banErr } = await supabase.auth.admin.updateUserById(userId, { ban_duration: '876000h' });
    if (banErr) throw new Error('Account disable failed: ' + banErr.message);

    await supabase.from('staff_presence').delete().eq('user_id', userId);
    await supabase.from('audit_log').insert({
      actor_user_id: req.actor.id, actor_email: req.actor.email,
      action: 'staff.disable', target_user_id: userId, detail: { revoked_roles: hadRoles },
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('[staff/disable]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
