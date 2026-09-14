/**
 * POST /api/assignments/notify-assigned  { assignment_id }
 * POST /api/assignments/notify-reply     { recipient_id }
 *
 * Email is what makes in-dashboard messaging viable. A founder who only learns
 * about an assignment by happening to log in will keep using WhatsApp, and so
 * will the coach who got no reply. These two endpoints are the nudge.
 *
 * The client already wrote the row under RLS, so the row's existence is not in
 * question — what this endpoint must establish is that the CALLER is a party to
 * it before handing out anybody's email address. Service-role reads are used to
 * assemble the email, so authorisation is checked explicitly, never inherited.
 */
const express = require('express');
const router  = express.Router();
const { supabase } = require('../lib/db');
const { sendAssignmentSet, sendAssignmentReply } = require('../lib/emailer');

// Validate the JWT for real. Never trust a token by shape or length.
async function requireUser(req, res, next) {
  try {
    const authz = req.headers.authorization || '';
    const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired session' });
    req.actor = { id: user.id, email: (user.email || '').toLowerCase() };
    next();
  } catch (e) {
    console.error('[assignments] auth:', e.message);
    return res.status(500).json({ error: 'Authorization check failed' });
  }
}

// Everything needed to address an email, plus the two identities that are
// allowed to trigger one for this recipient row.
async function loadRecipient(recipientId) {
  const { data, error } = await supabase
    .from('assignment_recipients')
    .select('id, status, response, founder_id, assignment_id, '
          + 'assignments(id, title, brief, due_at, coach_id), '
          + 'founder_profiles(id, user_id, first_name, last_name, email)')
    .eq('id', recipientId)
    .single();
  if (error || !data) return null;
  return data;
}

async function coachContact(userId) {
  const { data } = await supabase
    .from('coaches')
    .select('first_name, last_name, email, founderssprint_email')
    .eq('user_id', userId).limit(1).maybeSingle();
  if (!data) return null;
  return {
    name:  `${data.first_name || ''} ${data.last_name || ''}`.trim() || 'Your coach',
    email: data.founderssprint_email || data.email || null,
  };
}

// ── Coach assigned work → email every founder on it ──────────────────────────
router.post('/notify-assigned', requireUser, async (req, res) => {
  try {
    const id = String(req.body?.assignment_id || '');
    if (!id) return res.status(400).json({ error: 'assignment_id required' });

    const { data: a, error } = await supabase
      .from('assignments').select('id, title, brief, due_at, coach_id').eq('id', id).single();
    if (error || !a) return res.status(404).json({ error: 'Not found' });

    // Only the author may announce their own assignment.
    if (a.coach_id !== req.actor.id) return res.status(403).json({ error: 'Not your assignment' });

    const coach = await coachContact(a.coach_id);
    const { data: recips } = await supabase
      .from('assignment_recipients')
      .select('id, founder_profiles(first_name, email)')
      .eq('assignment_id', id);

    let sent = 0, failed = 0;
    for (const r of (recips || [])) {
      const fp = r.founder_profiles;
      if (!fp || !fp.email) { failed++; continue; }
      // One founder's dead address must not stop the rest of the cohort's mail.
      try {
        await sendAssignmentSet({
          to: fp.email, firstName: fp.first_name || '',
          coachName: coach?.name || 'Your coach',
          title: a.title, brief: a.brief, dueAt: a.due_at,
        });
        sent++;
      } catch (e) { failed++; console.error('[assignments] send failed', fp.email, e.message); }
    }
    return res.json({ ok: true, sent, failed });
  } catch (e) {
    console.error('[assignments/notify-assigned]', e);
    return res.status(500).json({ error: e.message });
  }
});

// ── Either side posted → email the other side ────────────────────────────────
router.post('/notify-reply', requireUser, async (req, res) => {
  try {
    const id = String(req.body?.recipient_id || '');
    if (!id) return res.status(400).json({ error: 'recipient_id required' });

    const r = await loadRecipient(id);
    if (!r) return res.status(404).json({ error: 'Not found' });

    const a  = r.assignments || {};
    const fp = r.founder_profiles || {};
    const isCoach   = a.coach_id === req.actor.id;
    const isFounder = fp.user_id === req.actor.id;
    if (!isCoach && !isFounder) return res.status(403).json({ error: 'Not a party to this' });

    const coach = await coachContact(a.coach_id);

    // The most recent message is the thing being announced. A status change with
    // no message still sends, so "sent back for another go" reaches the founder.
    const { data: last } = await supabase
      .from('assignment_messages')
      .select('body, author_role, created_at')
      .eq('recipient_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle();

    const founderName = `${fp.first_name || ''} ${fp.last_name || ''}`.trim() || 'Your founder';

    if (isCoach) {
      if (!fp.email) return res.status(422).json({ error: 'Founder has no email on file' });
      await sendAssignmentReply({
        to: fp.email, forRole: 'founder', firstName: fp.first_name || '',
        fromName: coach?.name || 'Your coach',
        title: a.title, status: r.status,
        body: (last && last.author_role === 'coach') ? last.body : null,
      });
    } else {
      if (!coach?.email) return res.status(422).json({ error: 'Coach has no email on file' });
      await sendAssignmentReply({
        to: coach.email, forRole: 'coach', firstName: coach.name.split(' ')[0],
        fromName: founderName,
        title: a.title, status: r.status,
        body: (last && last.author_role === 'founder') ? last.body : null,
        submission: r.status === 'submitted' ? r.response : null,
      });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('[assignments/notify-reply]', e);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
