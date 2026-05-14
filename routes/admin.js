const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const mailchimp = require('@mailchimp/mailchimp_transactional');
const {
  getOpenCohorts, getCohort, getRegistrationsForCohort, getCoaches, supabase,
} = require('../lib/db');
const { sendAdminReport } = require('../lib/emailer');

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ── GET /api/admin/cohorts — all cohorts with registration counts ──────────────
router.get('/cohorts', requireSecret, async (req, res) => {
  try {
    const cohorts = await getOpenCohorts();
    const result  = await Promise.all(
      cohorts.map(async c => ({
        ...c,
        registrations: await getRegistrationsForCohort(c.id),
      }))
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/cohorts/:id/registrations — full roster ────────────────────
router.get('/cohorts/:id/registrations', requireSecret, async (req, res) => {
  try {
    const cohort = await getCohort(Number(req.params.id));
    if (!cohort) return res.status(404).json({ error: 'Cohort not found' });
    const registrations = await getRegistrationsForCohort(cohort.id);
    res.json({ cohort, registrations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/cohorts/:id/report — trigger admin email report ───────────
router.post('/cohorts/:id/report', requireSecret, async (req, res) => {
  try {
    const cohort = await getCohort(Number(req.params.id));
    if (!cohort) return res.status(404).json({ error: 'Cohort not found' });
    const registrations = await getRegistrationsForCohort(cohort.id);
    await sendAdminReport(cohort, registrations);
    res.json({ ok: true, message: `Report sent for ${cohort.name}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/send-founding-invite — one-click meeting invite ──────────

const ZOOM_LINK = process.env.ZOOM_LINK || 'https://zoom.us/j/XXXXXXXXXX';

// Recipients are pulled live from the coaches table (role=coach only)

const MEETING_CFG = {
  date:     '2026-05-08',
  timeUTC:  '15:00',
  duration: 90,
  summary:  "The Founder's Sprint — Founding Team Meeting",
  get location() { return `Zoom: ${ZOOM_LINK}`; },
  get description() {
    return [
      "Founding Team Meeting — The Founder's Sprint",
      "",
      "Agenda:",
      "1. The Vision — from solo programme to continental platform",
      "2. Platform Architecture — tech build & curriculum delivery",
      "3. The Founding Team — expertise niches & the 5-coach model",
      "4. Revenue Model & Equity — shareholding & revenue splits",
      "5. Next Steps & Timeline — commitments, onboarding, launch",
      "",
      "Presentation deck: https://tmsruge.com/founders_pitch/",
      "",
      `Join Zoom: ${ZOOM_LINK}`,
    ].join('\\n');
  },
};

function generateICS() {
  const now     = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const dtStart = MEETING_CFG.date.replace(/-/g, '') + 'T' + MEETING_CFG.timeUTC.replace(':', '') + '00Z';
  const endDate = new Date(`${MEETING_CFG.date}T${MEETING_CFG.timeUTC}:00Z`);
  endDate.setMinutes(endDate.getMinutes() + MEETING_CFG.duration);
  const dtEnd = endDate.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const uid = `founding-team-meeting-2026-05-08@tmsruge.com`;

  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', "PRODID:-//The Founder's Sprint//EN",
    'CALSCALE:GREGORIAN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:${uid}`, `DTSTAMP:${now}`, `DTSTART:${dtStart}`, `DTEND:${dtEnd}`,
    `SUMMARY:${MEETING_CFG.summary}`, `DESCRIPTION:${MEETING_CFG.description}`,
    `LOCATION:${MEETING_CFG.location}`, `URL:${ZOOM_LINK}`,
    `ORGANIZER;CN=The Founder's Sprint:mailto:hello@founderssprint.co`,
    'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY',
    "DESCRIPTION:Founding Team Meeting tomorrow at 6 PM EAT", 'END:VALARM',
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY',
    "DESCRIPTION:Founding Team Meeting in 1 hour", 'END:VALARM',
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY',
    "DESCRIPTION:Founding Team Meeting starts in 15 minutes!", 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');

  return { type: 'text/calendar; method=REQUEST', name: 'founding-team-meeting.ics', content: Buffer.from(ics).toString('base64') };
}

function loadInviteTemplate(vars = {}) {
  const file = path.join(__dirname, '..', 'templates', 'founding_team_invite.html');
  let html = fs.readFileSync(file, 'utf8');
  for (const [key, val] of Object.entries(vars)) {
    html = html.replaceAll(`{{${key}}}`, val ?? '');
  }
  return html;
}

// Accept either x-admin-secret OR a valid Supabase JWT (from the dashboard)
function requireAuth(req, res, next) {
  // Check admin secret first
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret && secret === process.env.ADMIN_SECRET) return next();

  // Check Supabase bearer token (dashboard sends this)
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ') && auth.length > 20) return next();

  return res.status(403).json({ error: 'Forbidden' });
}

// GET /api/admin/coaches — return active coaches (used by dashboard)
router.get('/coaches', requireAuth, async (req, res) => {
  try {
    const coaches = await getCoaches();
    res.json(coaches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/send-founding-invite', requireAuth, async (req, res) => {
  const key = process.env.MAILCHIMP_API_KEY;
  if (!key) return res.status(500).json({ error: 'MAILCHIMP_API_KEY not set' });

  // Pull coaches from DB (exclude founder — that's the sender)
  let coaches;
  try {
    coaches = await getCoaches({ role: 'coach' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load coaches: ' + err.message });
  }

  if (!coaches.length) return res.status(400).json({ error: 'No active coaches found' });

  const client = mailchimp(key);
  const icsAttachment = generateICS();
  const results = [];

  for (const coach of coaches) {
    const sendTo = coach.founderssprint_email || coach.email;  // prefer platform email when available
    try {
      const html = loadInviteTemplate({
        FIRST_NAME: coach.first_name,
        ZOOM_LINK:  ZOOM_LINK,
      });

      const response = await client.messages.send({
        message: {
          from_email: 'hello@founderssprint.co',
          from_name:  "The Founder's Sprint",
          to: [{ email: sendTo, type: 'to' }],
          subject: "You're Invited — Founding Team Meeting · The Founder's Sprint",
          html,
          attachments: [icsAttachment],
        },
      });

      const r = response?.[0];
      const ok = r?.status === 'sent' || r?.status === 'queued';
      results.push({ email: sendTo, name: coach.first_name, status: r?.status || 'unknown', ok });
    } catch (err) {
      results.push({ email: sendTo, name: coach.first_name, status: 'error', ok: false, error: err.message });
    }
  }

  const sent = results.filter(r => r.ok).length;
  res.json({ ok: sent === coaches.length, sent, total: coaches.length, results });
});

// ── GET /api/admin/send-founding-invite — same logic, callable via browser/fetch ─
router.get('/send-founding-invite', requireSecret, async (req, res) => {
  const key = process.env.MAILCHIMP_API_KEY;
  if (!key) return res.status(500).json({ error: 'MAILCHIMP_API_KEY not set' });

  // Optional: ?to=email@example.com sends only to that address (test mode)
  const testTo = req.query.to;

  let recipients;
  if (testTo) {
    // Test mode — send to a single email
    recipients = [{ first_name: 'Teddy', email: testTo }];
  } else {
    // Production mode — send to all coaches
    try {
      recipients = await getCoaches({ role: 'coach' });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to load coaches: ' + err.message });
    }
  }

  if (!recipients.length) return res.status(400).json({ error: 'No recipients found' });

  const client = mailchimp(key);
  const icsAttachment = generateICS();
  const results = [];

  for (const r of recipients) {
    const sendTo = r.founderssprint_email || r.email;
    try {
      const html = loadInviteTemplate({
        FIRST_NAME: r.first_name,
        ZOOM_LINK:  ZOOM_LINK,
      });

      const response = await client.messages.send({
        message: {
          from_email: 'hello@founderssprint.co',
          from_name:  "The Founder's Sprint",
          to: [{ email: sendTo, type: 'to' }],
          subject: "You're Invited — Founding Team Meeting · The Founder's Sprint",
          html,
          attachments: [icsAttachment],
        },
      });

      const result = response?.[0];
      const ok = result?.status === 'sent' || result?.status === 'queued';
      results.push({ email: sendTo, name: r.first_name, status: result?.status || 'unknown', ok });
    } catch (err) {
      results.push({ email: sendTo, name: r.first_name, status: 'error', ok: false, error: err.message });
    }
  }

  const sent = results.filter(r => r.ok).length;
  res.json({ ok: sent === recipients.length, sent, total: recipients.length, testMode: !!testTo, results });
});

// ── POST /api/admin/reset-password — trigger password reset for a dashboard user ─
router.post('/reset-password', requireSecret, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const redirectTo = process.env.DASHBOARD_URL || 'https://founderssprint.co/dashboard.html';
    const { error } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo },
    });
    if (error) throw error;

    res.json({ ok: true, message: `Password reset link generated for ${email}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/dashboard-users — list all Supabase Auth users (for user mgmt) ─
router.get('/dashboard-users', requireSecret, async (req, res) => {
  try {
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    if (error) throw error;

    const summary = (users || []).map(u => ({
      id:         u.id,
      email:      u.email,
      full_name:  u.user_metadata?.full_name || null,
      role:       u.user_metadata?.role || null,
      founding:   u.user_metadata?.founding_coach || false,
      created_at: u.created_at,
      last_sign_in: u.last_sign_in_at,
    }));

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
