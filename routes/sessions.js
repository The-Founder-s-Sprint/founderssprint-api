const express = require('express');
const router  = express.Router();
const { supabase } = require('../lib/db');
const { createMeetSession, cancelMeetSession } = require('../lib/google-calendar');

// ── Auth middleware — same pattern as admin routes ────────────────────────────
function requireSecret(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ── POST /api/sessions/schedule — create a session with Google Meet ──────────
router.post('/schedule', requireSecret, async (req, res) => {
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
router.get('/', requireSecret, async (req, res) => {
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
router.patch('/:id', requireSecret, async (req, res) => {
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
        .select('calendar_event_id')
        .eq('id', id)
        .single();

      if (session?.calendar_event_id) {
        try {
          await cancelMeetSession(session.calendar_event_id);
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
