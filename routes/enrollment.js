/**
 * POST /api/enrollment/decide  { change_id, decision, note, target_cohort }
 * GET  /api/enrollment/quote?registration_id=&kind=
 *
 * The database moves the seat; Google has to be told separately. Doing that from
 * the browser would need calendar credentials client-side, and doing it "later"
 * is how a founder who postponed in September is still getting Meet invites in
 * October. So approval and calendar cleanup happen in one request.
 *
 * Order matters: read the OLD cohort before the RPC runs, because approving a
 * deferral moves registrations.cohort_id and the old sessions become unfindable.
 */
const express = require('express');
const router  = express.Router();
const { supabase } = require('../lib/db');
const { removeAttendeeFromEvent } = require('../lib/google-calendar');
const { seatFounderForRegistration } = require('../lib/cohort-seating');

async function requireStaff(req, res, next) {
  try {
    const authz = req.headers.authorization || '';
    const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired session' });

    const { data: roles } = await supabase
      .from('user_roles').select('role').eq('user_id', user.id);
    const held = (roles || []).map(r => r.role);
    if (!held.some(r => ['admin', 'finance', 'founder_support'].includes(r))) {
      return res.status(403).json({ error: 'Staff only' });
    }
    req.actor = { id: user.id, email: (user.email || '').toLowerCase(), token, roles: held };
    next();
  } catch (e) {
    console.error('[enrollment] auth:', e.message);
    return res.status(500).json({ error: 'Authorization check failed' });
  }
}

// Read-only "what would this cost" — used by the staff queue before deciding.
router.get('/quote', requireStaff, async (req, res) => {
  try {
    const regId = Number(req.query.registration_id);
    const kind  = String(req.query.kind || '');
    if (!regId || !['defer', 'cancel'].includes(kind)) {
      return res.status(400).json({ error: 'registration_id and kind (defer|cancel) required' });
    }
    const { data, error } = await supabase.rpc('fs_enrollment_quote', { p_reg_id: regId, p_kind: kind });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ ok: true, quote: data });
  } catch (e) {
    console.error('[enrollment/quote]', e);
    return res.status(500).json({ error: e.message });
  }
});

router.post('/decide', requireStaff, async (req, res) => {
  const { change_id, decision, note, target_cohort } = req.body || {};
  if (!change_id || !['approve', 'decline'].includes(decision)) {
    return res.status(400).json({ error: 'change_id and decision (approve|decline) required' });
  }

  try {
    // Snapshot BEFORE the RPC — after it, cohort_id points at the new cohort.
    const { data: change, error: cErr } = await supabase
      .from('enrollment_changes')
      .select('id, kind, status, registration_id, registrations(id, email, user_id, cohort_id, first_name, last_name)')
      .eq('id', change_id).single();
    if (cErr || !change) return res.status(404).json({ error: 'Request not found' });
    if (change.status !== 'requested') return res.status(409).json({ error: `Already ${change.status}` });

    const reg         = change.registrations || {};
    const oldCohortId = reg.cohort_id;
    const email       = String(reg.email || '').trim().toLowerCase();

    // Collect the events to clean up while we can still find them.
    let toClear = [];
    if (decision === 'approve') {
      const { data: sessions } = await supabase
        .from('sessions')
        .select('id, calendar_event_id, organiser_email')
        .eq('cohort_id', oldCohortId)
        .neq('status', 'cancelled')
        .gt('scheduled_at', new Date().toISOString())
        .limit(200);
      toClear = (sessions || []).filter(s => s.calendar_event_id);
    }

    // The decision runs AS THE STAFF MEMBER, so decide_enrollment_change's own
    // role check still applies — this endpoint cannot widen who may approve.
    // The caller's JWT serves as both apikey and bearer, so no anon key needs
    // to exist in this service's env (it doesn't).
    const actingClient = require('@supabase/supabase-js').createClient(
      process.env.SUPABASE_URL,
      req.actor.token,
      { global: { headers: { Authorization: `Bearer ${req.actor.token}` } },
        auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data: result, error: dErr } = await actingClient.rpc('decide_enrollment_change', {
      p_id: change_id, p_decision: decision, p_note: note || null,
      p_target_cohort: target_cohort || null,
    });
    if (dErr) return res.status(400).json({ error: dErr.message });

    if (decision === 'decline') return res.json({ ok: true, result });

    // Calendar cleanup. Failures are reported, never thrown: the seat has moved
    // and a stuck invite is a nuisance, not a reason to undo a decision.
    const calendar = { removed: 0, problems: [] };
    for (const s of toClear) {
      try {
        const r = await removeAttendeeFromEvent(s.calendar_event_id, email, s.organiser_email);
        if (r.removed) calendar.removed++;
      } catch (e) { calendar.problems.push(`session ${s.id}: ${e.message}`); }
    }

    // Seat them in the new cohort if its sessions already exist. If they don't,
    // the seat-founders cron picks them up once the schedule is generated.
    let seated = null;
    if (change.kind === 'defer') {
      try { seated = await seatFounderForRegistration(change.registration_id); }
      catch (e) { calendar.problems.push('reseat: ' + e.message); }
    }

    return res.json({ ok: true, result, calendar, seated });
  } catch (e) {
    console.error('[enrollment/decide]', e);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
