const express = require('express');
const router  = express.Router();
const { supabase } = require('../lib/db');
const { createMeetSession, cancelMeetSession, patchEventTime } = require('../lib/google-calendar');

// ── Auth middleware — accepts admin secret OR Bearer token ────────────────────
async function requireAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (secret && secret === process.env.ADMIN_SECRET) return next();

  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (user && !error) { req.user = user; return next(); }
    } catch (err) {
      console.error('[Sessions] Auth validation error:', err.message);
    }
  }
  return res.status(403).json({ error: 'Forbidden' });
}

// ── POST /api/sessions/reschedule — move a session in time ───────────────────
// { session_id, starts_at, duration_minutes?, title?, notify? }
//
// Moves the Google event IN PLACE and updates our row to match. The event id,
// the Meet room and the guest list all survive — only the time changes. This is
// the function whose absence meant every schedule change had to be done by hand
// in the Google UI, which is how a delete-and-recreate silently forks the link.
//
// The Meet link is read back from Google afterwards and re-saved, so even if the
// room were reissued our copy stays true.
router.post('/reschedule', requireAuth, async (req, res) => {
  try {
    const { session_id, starts_at, duration_minutes, title, notify } = req.body || {};
    if (!session_id || !starts_at) {
      return res.status(400).json({ error: 'session_id and starts_at required' });
    }
    const when = new Date(starts_at);
    if (isNaN(when)) return res.status(400).json({ error: 'starts_at is not a valid date' });

    const { data: s, error } = await supabase
      .from('sessions')
      .select('id, title, scheduled_at, duration_minutes, calendar_event_id, organiser_email, status, meet_link')
      .eq('id', session_id).single();
    if (error || !s) return res.status(404).json({ error: 'Session not found' });
    if (s.status === 'cancelled') return res.status(409).json({ error: 'Session is cancelled' });

    const mins = Number(duration_minutes) || s.duration_minutes || 120;
    let google = null;
    if (s.calendar_event_id) {
      google = await patchEventTime(s.calendar_event_id, {
        startTime: when.toISOString(),
        durationMinutes: mins,
        summary: title || null,
        organiserEmail: s.organiser_email,
        notify: notify || 'all',
      });
    }

    const patch = { scheduled_at: when.toISOString(), duration_minutes: mins };
    if (title) patch.title = title;
    // Trust Google for the room: it owns it, we only point at it.
    if (google && google.meetLink) patch.meet_link = google.meetLink;

    const { error: uErr } = await supabase.from('sessions').update(patch).eq('id', session_id);
    if (uErr) return res.status(500).json({ error: 'DB update failed: ' + uErr.message });

    return res.json({
      ok: true, session: session_id,
      was: s.scheduled_at, now: when.toISOString(),
      meet_link: (google && google.meetLink) || s.meet_link,
      link_unchanged: !google || !google.meetLink || google.meetLink === s.meet_link,
      calendar: google ? 'patched' : 'no calendar event on this session',
    });
  } catch (e) {
    console.error('[Sessions/reschedule]', e);
    return res.status(500).json({ error: e.message });
  }
});

// ── POST /api/sessions/schedule — create a session with Google Meet ──────────
router.post('/schedule', requireAuth, async (req, res) => {
  try {
    const {
      coach_id,       // UUID from coaches table
      coach_email,    // Coach's @founderssprint.co email
      attendees,      // Array of { email, name }
      title,
      description,
      scheduled_at,   // ISO 8601 datetime
      duration_minutes = 120,
      session_type = 'group',
      cohort_id = null,
    } = req.body;

    // Validate required fields
    if (!coach_email || !title || !scheduled_at) {
      return res.status(400).json({
        error: 'Missing required fields: coach_email, title, scheduled_at',
      });
    }

    if (!attendees || !attendees.length) {
      return res.status(400).json({ error: 'At least one attendee is required' });
    }

    console.log(`[Sessions] Creating session: "${title}" with ${coach_email} at ${scheduled_at}`);

    // 1. Create Google Calendar event with Meet link
    let meetLink = null;
    let calendarEventId = null;
    let htmlLink = null;
    let organiserEmail = null;

    try {
      const result = await createMeetSession({
        coachEmail: coach_email,
        attendees: attendees.map(a => a.email),
        title: `The Founder's Sprint — ${title}`,
        description: description || '',
        startTime: scheduled_at,
        durationMinutes: duration_minutes,
      });

      meetLink = result.meetLink;
      calendarEventId = result.calendarEventId;
      htmlLink = result.htmlLink;
      organiserEmail = result.organiserEmail;
      console.log(`[Sessions] Meet link created: ${meetLink}`);
    } catch (calErr) {
      console.error('[Sessions] Google Calendar error:', calErr.message);
      // Don't fail the whole request — save the session without Meet link
      // Admin can retry or manually add a link
    }

    // 2. Save session to database
    const { data: session, error: sessionErr } = await supabase
      .from('sessions')
      .insert({
        coach_id: coach_id || null,
        session_type,
        title,
        description,
        scheduled_at,
        duration_minutes,
        meet_link: meetLink,
        calendar_event_id: calendarEventId,
        organiser_email: organiserEmail,
        status: 'scheduled',
        cohort_id,
      })
      .select()
      .single();

    if (sessionErr) {
      console.error('[Sessions] DB insert error:', sessionErr.message);
      return res.status(500).json({ error: 'Failed to save session: ' + sessionErr.message });
    }

    // 3. Save attendees
    if (attendees.length > 0) {
      const attendeeRows = attendees.map(a => ({
        session_id: session.id,
        email: a.email,
        name: a.name || null,
      }));

      const { error: attErr } = await supabase
        .from('session_attendees')
        .insert(attendeeRows);

      if (attErr) {
        console.error('[Sessions] Attendee insert error:', attErr.message);
        // Non-fatal — session is created, attendees can be added later
      }
    }

    console.log(`[Sessions] Session #${session.id} created successfully`);

    res.json({
      ok: true,
      session: {
        id: session.id,
        title: session.title,
        scheduled_at: session.scheduled_at,
        duration_minutes: session.duration_minutes,
        meet_link: meetLink,
        calendar_event_id: calendarEventId,
        html_link: htmlLink,
        status: session.status,
      },
    });
  } catch (err) {
    console.error('[Sessions] Unhandled error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/sessions — list sessions (with optional filters) ────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { coach_id, status, from, to, limit = 50 } = req.query;

    let query = supabase
      .from('sessions')
      .select('*, session_attendees(email, name, attended)')
      .order('scheduled_at', { ascending: true })
      .limit(Number(limit));

    if (coach_id) query = query.eq('coach_id', coach_id);
    if (status)   query = query.eq('status', status);
    if (from)     query = query.gte('scheduled_at', from);
    if (to)       query = query.lte('scheduled_at', to);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/sessions/:id — update session status ──────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const updates = {};
    if (status) updates.status = status;
    if (notes !== undefined) updates.notes = notes;

    // If cancelling, also cancel the Google Calendar event
    if (status === 'cancelled') {
      const { data: session } = await supabase
        .from('sessions')
        .select('calendar_event_id, organiser_email')
        .eq('id', id)
        .single();

      if (session?.calendar_event_id) {
        try {
          await cancelMeetSession(session.calendar_event_id, session.organiser_email);
          console.log(`[Sessions] Cancelled calendar event for session #${id}`);
        } catch (calErr) {
          console.error('[Sessions] Failed to cancel calendar event:', calErr.message);
          // Non-fatal — continue updating the DB status
        }
      }
    }

    const { data, error } = await supabase
      .from('sessions')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Session not found' });

    res.json({ ok: true, session: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
