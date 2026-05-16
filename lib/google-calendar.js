/**
 * Google Calendar + Meet integration using raw HTTPS calls.
 * No external dependency — uses Node's built-in crypto for JWT signing
 * and native fetch (Node 18+) for API calls.
 *
 * Requires env vars:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  — service account email
 *   GOOGLE_PRIVATE_KEY            — PEM private key (with newlines)
 *   GOOGLE_CALENDAR_DELEGATE      — Workspace user to impersonate (e.g. sessions@founderssprint.co)
 */

const crypto = require('crypto');

// ── JWT construction for Google service account auth ─────────────────────────

function base64url(input) {
  const str = typeof input === 'string' ? input : input.toString('base64');
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createJWT(scopes, delegate) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    sub: delegate,
    scope: scopes,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const segments = [
    base64url(Buffer.from(JSON.stringify(header)).toString('base64')),
    base64url(Buffer.from(JSON.stringify(payload)).toString('base64')),
  ];

  const signingInput = segments.join('.');

  // Handle private key — Vercel may store it with literal \n or actual newlines
  let privateKey = process.env.GOOGLE_PRIVATE_KEY || '';
  if (privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = base64url(sign.sign(privateKey, 'base64'));

  return `${signingInput}.${signature}`;
}

// ── Token cache ──────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const delegate = process.env.GOOGLE_CALENDAR_DELEGATE;
  if (!delegate) throw new Error('GOOGLE_CALENDAR_DELEGATE env var not set');

  const jwt = createJWT(
    'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events',
    delegate
  );

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google OAuth error: ${res.status} — ${body}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // refresh 60s early
  return cachedToken;
}

// ── Create calendar event with Google Meet ───────────────────────────────────

/**
 * Creates a Google Calendar event with an auto-generated Meet link.
 *
 * @param {Object} opts
 * @param {string} opts.coachEmail     — Coach's @founderssprint.co email
 * @param {string[]} opts.attendees    — Array of attendee emails (founders)
 * @param {string} opts.title          — Event title
 * @param {string} opts.description    — Event description (optional)
 * @param {string} opts.startTime      — ISO 8601 datetime (e.g. 2026-07-14T09:00:00+03:00)
 * @param {number} opts.durationMinutes — Session length in minutes (default 120)
 * @param {string} opts.timezone       — IANA timezone (default Africa/Kampala)
 * @returns {Object} { meetLink, calendarEventId, htmlLink }
 */
async function createMeetSession(opts) {
  const {
    coachEmail,
    attendees = [],
    title,
    description = '',
    startTime,
    durationMinutes = 120,
    timezone = 'Africa/Kampala',
  } = opts;

  const token = await getAccessToken();
  const delegate = process.env.GOOGLE_CALENDAR_DELEGATE;

  // Build start/end times
  const start = new Date(startTime);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  // All attendees: coach + founders + the delegate calendar
  const allAttendees = [
    { email: coachEmail, responseStatus: 'accepted' },
    ...attendees.map(email => ({ email })),
  ];

  // Don't duplicate if coach IS the delegate
  if (delegate !== coachEmail) {
    allAttendees.push({ email: delegate, responseStatus: 'accepted', self: true });
  }

  const event = {
    summary: title,
    description: description + '\n\nScheduled via The Founder\'s Sprint platform.',
    start: { dateTime: start.toISOString(), timeZone: timezone },
    end: { dateTime: end.toISOString(), timeZone: timezone },
    attendees: allAttendees,
    conferenceData: {
      createRequest: {
        requestId: `fs-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 60 },    // 1 hour before
        { method: 'popup', minutes: 15 },     // 15 minutes before
      ],
    },
    guestsCanModify: false,
    guestsCanInviteOthers: false,
  };

  const calendarId = encodeURIComponent(delegate);
  const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?conferenceDataVersion=1&sendUpdates=all`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Calendar API error: ${res.status} — ${body}`);
  }

  const created = await res.json();

  return {
    meetLink: created.hangoutLink || created.conferenceData?.entryPoints?.[0]?.uri || null,
    calendarEventId: created.id,
    htmlLink: created.htmlLink,
  };
}

// ── Cancel a calendar event ──────────────────────────────────────────────────

async function cancelMeetSession(calendarEventId) {
  const token = await getAccessToken();
  const delegate = process.env.GOOGLE_CALENDAR_DELEGATE;
  const calendarId = encodeURIComponent(delegate);

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${calendarEventId}?sendUpdates=all`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!res.ok && res.status !== 410) { // 410 = already deleted
    const body = await res.text();
    throw new Error(`Google Calendar delete error: ${res.status} — ${body}`);
  }

  return { ok: true };
}

module.exports = { createMeetSession, cancelMeetSession };
