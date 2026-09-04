/**
 * POST /api/cohort-schedule/generate
 *
 * Generates a whole cohort's session series in one action — 5 disciplines ×
 * N weeks — each with a Google Meet link.
 *
 * Events are created SILENTLY (sendUpdates=none): they appear on every attendee's
 * calendar straight away, but no invitation emails are sent. Blasting 25 invites at
 * once is torture for the recipient. Notification is handled instead by the 72h-before
 * reminder cron (/api/cron/session-reminders), one email per session.
 *
 * Scheduling a cohort one session at a time through the ops form is 25 trips,
 * which is how a cohort starts on Monday with nothing in the calendar.
 *
 * Body:
 *   {
 *     cohort_id: 6,
 *     weeks: 5,                      // defaults to the cohort's own span
 *     duration_minutes: 120,
 *     days: [                        // omit to use the locked weekday map
 *       { weekday: 1, discipline: 'marketing', time: '10:00' }, ...
 *     ],
 *     dry_run: true                  // STRONGLY recommended first
 *   }
 *
 * Coach↔discipline is resolved from coach_topics.is_lead — never hardcoded,
 * per the platform scaling rule. Attendees are the cohort's paid founders.
 *
 * Idempotent: a session already sitting at the same cohort + coach + timestamp
 * is skipped, so a re-run cannot spam 25 duplicate invites at real people.
 */
const express = require('express');
const router  = express.Router();
const { supabase } = require('../lib/db');
const { createMeetSession } = require('../lib/google-calendar');

// The locked cohort map (CLAUDE.md). Weekday is ISO: 1 = Monday.
const DEFAULT_DAYS = [
  { weekday: 1, discipline: 'marketing', label: 'Marketing & Branding',        time: '10:00' },
  { weekday: 2, discipline: 'financial', label: 'Financial Modelling',         time: '10:00' },
  { weekday: 3, discipline: 'investment',label: 'Investment Readiness',        time: '10:00' },
  { weekday: 4, discipline: 'strategy',  label: 'Strategy & Team Building',    time: '10:00' },
  { weekday: 5, discipline: 'product',   label: 'Product Development & Pricing', time: '10:00' },
];
const LABELS = Object.fromEntries(DEFAULT_DAYS.map(d => [d.discipline, d.label]));

async function requireStaff(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (secret && secret === process.env.ADMIN_SECRET) return next();
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser(auth.slice(7));
      if (user && !error) {
        const { data: roles } = await supabase.from('user_roles')
          .select('role').eq('user_id', user.id).in('role', ['admin', 'finance']);
        if (roles && roles.length) { req.user = user; return next(); }
      }
    } catch (e) { console.error('[cohort-schedule] auth', e.message); }
  }
  return res.status(403).json({ error: 'Forbidden — admin or finance only' });
}

/** Nth occurrence of an ISO weekday on/after a date, as an EAT-anchored ISO string. */
function eatDateTime(startDate, weekday, weekIndex, hhmm) {
  const base = new Date(startDate + 'T00:00:00+03:00');
  const baseDow = ((base.getUTCDay() + 6) % 7) + 1;           // ISO 1..7
  const delta = (weekday - baseDow + 7) % 7;
  const d = new Date(base.getTime() + (delta + weekIndex * 7) * 86400000);
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0');
  // EAT is UTC+3 year-round, no DST, so a fixed offset is safe.
  return `${y}-${m}-${dd}T${hhmm}:00+03:00`;
}

router.post('/generate', requireStaff, async (req, res) => {
  const b = req.body || {};
  const cohortId = Number(b.cohort_id);
  const duration = Number(b.duration_minutes) || 120;
  const dryRun = b.dry_run !== false;                          // default SAFE
  if (!cohortId) return res.status(400).json({ error: 'cohort_id is required' });

  const { data: cohort } = await supabase.from('cohorts').select('*').eq('id', cohortId).maybeSingle();
  if (!cohort) return res.status(404).json({ error: 'Cohort not found' });

  const weeks = Number(b.weeks) || 5;
  // Precedence: explicit request → the cohort's own agreed schedule → the locked
  // platform map. Cohort 1 carries an agreed exception in cohorts.schedule, so the
  // times the coaches confirmed are read from data rather than retyped each run.
  const days = (Array.isArray(b.days) && b.days.length) ? b.days
             : (Array.isArray(cohort.schedule) && cohort.schedule.length) ? cohort.schedule
             : DEFAULT_DAYS;
  const scheduleSource = (Array.isArray(b.days) && b.days.length) ? 'request'
                       : (Array.isArray(cohort.schedule) && cohort.schedule.length) ? 'cohort override'
                       : 'platform default';

  // Coach per discipline, resolved from data (is_lead), never hardcoded.
  const { data: topics } = await supabase.from('coach_topics')
    .select('coach_id, discipline_key, is_lead').eq('is_lead', true);
  const { data: coaches } = await supabase.from('coaches')
    .select('id, email, first_name, last_name, user_id, status');
  const coachFor = {};
  (topics || []).forEach(t => {
    const c = (coaches || []).find(x => x.id === t.coach_id);
    if (c) coachFor[t.discipline_key] = c;
  });

  // Attendees = the cohort's paid, un-forfeited founders.
  const { data: regs } = await supabase.from('registrations')
    .select('email, first_name, last_name, deposit_paid, forfeited')
    .eq('cohort_id', cohortId).eq('deposit_paid', true).eq('forfeited', false);
  const founders = (regs || []).map(r => ({ email: r.email, name: [r.first_name, r.last_name].filter(Boolean).join(' ') }));

  if (!founders.length) {
    return res.status(400).json({ error: 'No paid founders on this cohort — nobody to invite' });
  }

  // Existing sessions, so a re-run skips rather than duplicates.
  const { data: existing } = await supabase.from('sessions')
    .select('scheduled_at, coach_id').eq('cohort_id', cohortId);
  const seen = new Set((existing || []).map(s => `${s.coach_id}|${new Date(s.scheduled_at).toISOString()}`));

  const plan = [];
  const problems = [];
  for (let w = 0; w < weeks; w++) {
    for (const d of days) {
      const coach = coachFor[d.discipline];
      if (!coach) { problems.push(`No lead coach found for discipline "${d.discipline}"`); continue; }
      if (!coach.email) { problems.push(`Lead coach for "${d.discipline}" has no email on file`); continue; }
      const startsAt = eatDateTime(cohort.start_date, d.weekday, w, d.time || '10:00');
      const key = `${coach.id}|${new Date(startsAt).toISOString()}`;
      plan.push({
        week: w + 1,
        discipline: d.discipline,
        title: `${cohort.name} · ${LABELS[d.discipline] || d.discipline} — Week ${w + 1}`,
        coach: [coach.first_name, coach.last_name].filter(Boolean).join(' ') || coach.email,
        coach_email: coach.email,
        coach_id: coach.id,
        starts_at_eat: startsAt,
        duration_minutes: duration,
        skip: seen.has(key),
      });
    }
  }

  if (dryRun) {
    return res.json({
      dry_run: true, cohort: cohort.name, weeks, schedule_source: scheduleSource,
      founders: founders.map(f => f.email),
      to_create: plan.filter(p => !p.skip).length,
      already_scheduled: plan.filter(p => p.skip).length,
      problems, plan,
    });
  }

  const created = [], failed = [];
  for (const p of plan) {
    if (p.skip) continue;
    try {
      const meet = await createMeetSession({
        coachEmail: p.coach_email,
        attendees: founders.map(f => f.email),
        title: `The Founder's Sprint — ${p.title}`,
        description: `${LABELS[p.discipline] || p.discipline} · Week ${p.week} of ${weeks}.`,
        startTime: p.starts_at_eat,
        durationMinutes: p.duration_minutes,
        // Silent create. The event lands on every calendar immediately, but nobody
        // gets 25 invitation emails at once. Notification is the 72h reminder cron.
        notify: 'none',
      });
      const { data: sess, error: sErr } = await supabase.from('sessions').insert({
        coach_id: p.coach_id, session_type: 'group', title: p.title,
        description: `${LABELS[p.discipline] || p.discipline} · Week ${p.week}`,
        scheduled_at: new Date(p.starts_at_eat).toISOString(),
        duration_minutes: p.duration_minutes, meet_link: meet.meetLink,
        calendar_event_id: meet.calendarEventId, status: 'scheduled', cohort_id: cohortId,
      }).select().single();
      if (sErr) throw new Error(sErr.message);

      await supabase.from('session_attendees')
        .insert(founders.map(f => ({ session_id: sess.id, email: f.email, name: f.name || null })));

      created.push({ title: p.title, at: p.starts_at_eat, meet_link: meet.meetLink });
    } catch (e) {
      console.error('[cohort-schedule]', p.title, e.message);
      failed.push({ title: p.title, at: p.starts_at_eat, error: e.message });
    }
  }

  return res.json({
    ok: failed.length === 0, cohort: cohort.name, schedule_source: scheduleSource,
    created: created.length, failed: failed.length,
    invited: founders.map(f => f.email),
    sessions: created, errors: failed,
  });
});

module.exports = router;
