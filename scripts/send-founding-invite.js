#!/usr/bin/env node
/**
 * Send branded founding team meeting invite via Mandrill.
 *
 * Usage:
 *   node scripts/send-founding-invite.js                 # test send to Teddy
 *   node scripts/send-founding-invite.js --send-all      # send to all 5 coaches
 *
 * Requires:
 *   MAILCHIMP_API_KEY  env var (Mandrill transactional key)
 *
 * Meeting: Thursday 8 May 2026, 6:00 PM EAT (3:00 PM UTC), Zoom
 */

const mailchimp = require('@mailchimp/mailchimp_transactional');
const fs   = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────

const MANDRILL_KEY = process.env.MAILCHIMP_API_KEY;
if (!MANDRILL_KEY) {
  console.error('❌  Set MAILCHIMP_API_KEY before running.');
  process.exit(1);
}

const client = mailchimp(MANDRILL_KEY);

const FROM_EMAIL = 'hello@founderssprint.co';
const FROM_NAME  = "The Founder's Sprint";

// Zoom link — replace with the real meeting link before sending
const ZOOM_LINK = 'https://zoom.us/j/XXXXXXXXXX';

const MEETING = {
  date:     '2026-05-08',
  timeUTC:  '15:00',          // 6 PM EAT = 3 PM UTC
  duration: 90,               // minutes
  summary:  "The Founder's Sprint — Founding Team Meeting",
  location: `Zoom: ${ZOOM_LINK}`,
  description: [
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
  ].join('\\n'),
};

// ── Recipients ───────────────────────────────────────────────────────────────

const TEST_RECIPIENT = {
  email: 'tms.ruge@me.com',
  first_name: 'Teddy',
};

// All 4 founding coaches + Teddy for test
const ALL_RECIPIENTS = [
  TEST_RECIPIENT,
  { email: 'joe.kalema@gmail.com',         first_name: 'Joseph' },
  { email: 'mengwau@gmail.com',            first_name: 'Moses' },
  { email: 'bwojega@hivecolab.com',        first_name: 'Barry' },
  { email: 'patrick.ngolobe@aels.co.ug',   first_name: 'Patrick' },
];

// ── ICS Calendar Generator ───────────────────────────────────────────────────

function generateICS() {
  const now     = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const dtStart = MEETING.date.replace(/-/g, '') + 'T' + MEETING.timeUTC.replace(':', '') + '00Z';

  const endDate = new Date(`${MEETING.date}T${MEETING.timeUTC}:00Z`);
  endDate.setMinutes(endDate.getMinutes() + MEETING.duration);
  const dtEnd = endDate.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';

  const uid = `founding-team-meeting-2026-05-08@tmsruge.com`;

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    "PRODID:-//The Founder's Sprint//EN",
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${MEETING.summary}`,
    `DESCRIPTION:${MEETING.description}`,
    `LOCATION:${MEETING.location}`,
    `URL:${ZOOM_LINK}`,
    `ORGANIZER;CN=Teddy Ruge:mailto:${FROM_EMAIL}`,
    // 24-hour reminder
    'BEGIN:VALARM',
    'TRIGGER:-P1D',
    'ACTION:DISPLAY',
    "DESCRIPTION:Founding Team Meeting tomorrow at 6 PM EAT — review the deck!",
    'END:VALARM',
    // 1-hour reminder
    'BEGIN:VALARM',
    'TRIGGER:-PT1H',
    'ACTION:DISPLAY',
    "DESCRIPTION:Founding Team Meeting in 1 hour — join via Zoom",
    'END:VALARM',
    // 15-minute reminder
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    "DESCRIPTION:Founding Team Meeting starts in 15 minutes!",
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  return {
    type:    'text/calendar; method=REQUEST',
    name:    'founding-team-meeting.ics',
    content: Buffer.from(ics).toString('base64'),
  };
}

// ── Template Loader ──────────────────────────────────────────────────────────

function loadTemplate(vars = {}) {
  const file = path.join(__dirname, '..', 'templates', 'founding_team_invite.html');
  let html = fs.readFileSync(file, 'utf8');
  for (const [key, val] of Object.entries(vars)) {
    html = html.replaceAll(`{{${key}}}`, val ?? '');
  }
  return html;
}

// ── Sender ───────────────────────────────────────────────────────────────────

async function sendInvite(recipient) {
  const html = loadTemplate({
    FIRST_NAME: recipient.first_name,
    ZOOM_LINK:  ZOOM_LINK,
  });

  const icsAttachment = generateICS();

  const message = {
    from_email: FROM_EMAIL,
    from_name:  FROM_NAME,
    to: [{ email: recipient.email, type: 'to' }],
    subject: "You're Invited — Founding Team Meeting · The Founder's Sprint",
    html,
    attachments: [icsAttachment],
  };

  try {
    const response = await client.messages.send({ message });
    const result = response?.[0];
    const ok = result?.status === 'sent' || result?.status === 'queued';

    if (ok) {
      console.log(`✅  ${recipient.email} — ${result.status}`);
    } else {
      console.error(`❌  ${recipient.email} — ${result?.status}: ${result?.reject_reason || 'unknown'}`);
    }
    return ok;
  } catch (err) {
    console.error(`❌  ${recipient.email} — Error: ${err.message}`);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const sendAll = process.argv.includes('--send-all');

  console.log('');
  console.log("┌─────────────────────────────────────────────┐");
  console.log("│  The Founder's Sprint — Meeting Invite      │");
  console.log("│  Thursday 8 May 2026 · 6:00 PM EAT · Zoom  │");
  console.log("└─────────────────────────────────────────────┘");
  console.log('');

  if (sendAll) {
    console.log(`Sending to ${ALL_RECIPIENTS.length} recipient(s)...`);
    console.log('');
    let ok = 0;
    for (const r of ALL_RECIPIENTS) {
      if (await sendInvite(r)) ok++;
    }
    console.log('');
    console.log(`Done. ${ok}/${ALL_RECIPIENTS.length} sent successfully.`);
  } else {
    console.log('TEST MODE — sending to Teddy only');
    console.log('');
    await sendInvite(TEST_RECIPIENT);
    console.log('');
    console.log('Run with --send-all to send to all founding team members.');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
