/**
 * Seat a paying founder into their cohort's sessions.
 *
 * `/api/cohort-schedule/generate` snapshots whoever has paid at the moment it
 * runs. Anyone who pays afterwards got no attendee row and no calendar invite,
 * silently — Cohort 1's second founder had to be added to all 25 sessions by
 * hand. With twelve seats selling over three months, that stops scaling.
 *
 * Two things must happen, and the first matters more than the second:
 *
 *   1. session_attendees row, WITH user_id. coach_covers_founder joins on it,
 *      so a row without one makes the founder invisible to every coach — no My
 *      Founders entry, no assessment, no intake. That is a silent failure that
 *      looks exactly like "the founder hasn't done anything yet".
 *   2. Google Calendar attendee, so they get the invite carrying the Meet link.
 *
 * Idempotent throughout: safe to call on every payment, and safe to run as a
 * repair pass over everyone. Never throws at the caller — a seating failure
 * must not roll back a confirmed payment.
 */
const { supabase } = require('./db');
const { addAttendeeToEvent } = require('./google-calendar');

async function seatFounderForRegistration(registrationId, { notify = 'all', dryRun = false } = {}) {
  const out = { registration_id: registrationId, seated: 0, invited: 0, already: 0, problems: [] };

  const { data: reg, error: rErr } = await supabase
    .from('registrations')
    .select('id, first_name, last_name, email, user_id, founder_id, cohort_id, track, deposit_paid, forfeited')
    .eq('id', registrationId).single();
  if (rErr || !reg) { out.problems.push('registration not found'); return out; }

  // A seat is a paid seat. Interest and lapsed holds get nothing.
  if (!reg.deposit_paid)       { out.skipped = 'deposit not paid';  return out; }
  if (reg.forfeited)           { out.skipped = 'forfeited';         return out; }
  if (!reg.cohort_id)          { out.skipped = 'no cohort';         return out; }
  // 1:1 and pick3 book their own sessions; only cohort seats join the standing run.
  if (reg.track !== 'cohort')  { out.skipped = 'not a cohort track'; return out; }

  const email = String(reg.email || '').trim().toLowerCase();
  if (!email) { out.problems.push('registration has no email'); return out; }

  // user_id may not exist yet if they paid before creating a login. Fall back to
  // the founder profile, which the registration links to once claimed.
  let userId = reg.user_id || null;
  if (!userId && reg.founder_id) {
    const { data: fp } = await supabase
      .from('founder_profiles').select('user_id').eq('id', reg.founder_id).maybeSingle();
    userId = (fp && fp.user_id) || null;
  }
  if (!userId) out.problems.push('no user_id yet — coach visibility will be blind until they log in');

  // Future sessions only. Back-filling a founder onto sessions that already ran
  // would fabricate attendance history for classes they were never in.
  const { data: sessions, error: sErr } = await supabase
    .from('sessions')
    .select('id, title, scheduled_at, calendar_event_id, organiser_email, status')
    .eq('cohort_id', reg.cohort_id)
    .neq('status', 'cancelled')
    .gt('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(200);
  if (sErr) { out.problems.push('session lookup failed: ' + sErr.message); return out; }
  if (!sessions || !sessions.length) { out.skipped = 'no future sessions for this cohort yet'; return out; }
  out.sessions_considered = sessions.length;

  const ids = sessions.map(s => s.id);
  const { data: existing } = await supabase
    .from('session_attendees')
    .select('session_id, email, user_id')
    .in('session_id', ids);

  const seatedAlready = new Set(
    (existing || [])
      .filter(a => (userId && a.user_id === userId)
                || String(a.email || '').trim().toLowerCase() === email)
      .map(a => a.session_id)
  );

  const name = `${reg.first_name || ''} ${reg.last_name || ''}`.trim() || null;

  for (const s of sessions) {
    if (seatedAlready.has(s.id)) { out.already++; continue; }
    if (dryRun) { out.seated++; continue; }

    const { error: iErr } = await supabase.from('session_attendees')
      .insert({ session_id: s.id, email, name, user_id: userId });
    if (iErr) { out.problems.push(`session ${s.id}: ${iErr.message}`); continue; }
    out.seated++;

    // The DB row is what makes them visible to coaches; the invite is what gets
    // them into the room. A calendar failure must not undo the row.
    if (!s.calendar_event_id) { out.problems.push(`session ${s.id}: no calendar event to invite them to`); continue; }
    try {
      const r = await addAttendeeToEvent(s.calendar_event_id, email, s.organiser_email, { notify });
      if (r.alreadyInvited) out.already_invited = (out.already_invited || 0) + 1; else out.invited++;
    } catch (e) {
      out.problems.push(`session ${s.id} invite: ${e.message}`);
    }
  }
  return out;
}

module.exports = { seatFounderForRegistration };
