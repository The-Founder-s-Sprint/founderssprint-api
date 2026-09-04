/**
 * Minimal RFC 5545 iCalendar builder for session invites.
 *
 * Why: cohort events are created on Google Calendar silently, which only reaches
 * people who actually use Google Calendar. Attaching an .ics to each 72h reminder
 * makes the invite provider-agnostic — Apple Calendar, Outlook, Thunderbird and
 * Google all read it — without sending anyone a second email.
 *
 * The fiddly parts of RFC 5545, all of which break silently in Outlook if wrong:
 *   • CRLF line endings, always. Bare \n is the classic cause of "invalid" files.
 *   • Lines folded at 75 octets, continuations prefixed with a single space.
 *   • TEXT values escape backslash, semicolon, comma and newline.
 *   • UTC timestamps as YYYYMMDDTHHMMSSZ (no punctuation, trailing Z).
 *   • A stable UID so a re-sent invite UPDATES the event instead of duplicating it.
 */

/** Escape a TEXT value per §3.3.11. Order matters — backslash first. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** UTC stamp: 2026-09-07T06:00:00.000Z → 20260907T060000Z */
function stamp(d) {
  return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Fold to 75 OCTETS (not characters) per §3.1. Multi-byte characters must never
 * be split mid-sequence, so measure in bytes and break on a character boundary.
 */
function fold(line) {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;
  const out = [];
  let start = 0, limit = 75;
  while (start < buf.length) {
    let end = Math.min(start + limit, buf.length);
    // Walk back off a UTF-8 continuation byte (10xxxxxx) so we cut cleanly.
    while (end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
    out.push(buf.slice(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines carry a leading space
  }
  return out.join('\r\n ');
}

/**
 * Build a single-event calendar.
 *
 * @param {object}  o
 * @param {string}  o.uid           stable id (e.g. `session-42@founderssprint.co`)
 * @param {string}  o.title
 * @param {string}  o.description
 * @param {Date|string} o.start
 * @param {number}  o.durationMinutes
 * @param {string}  o.meetLink      used as LOCATION + URL so "join" works from the calendar
 * @param {string}  o.organizerEmail
 * @param {string}  o.organizerName
 * @param {Array}   o.attendees     [{ email, name }]
 * @param {number}  o.sequence      bump when re-issuing a changed event
 * @param {string}  o.method        REQUEST (invite) | PUBLISH (add-to-calendar) | CANCEL
 */
function buildSessionIcs(o) {
  const start = new Date(o.start);
  const end = new Date(start.getTime() + (o.durationMinutes || 120) * 60000);
  const desc = [o.description, o.meetLink ? `Join: ${o.meetLink}` : '']
    .filter(Boolean).join('\n\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//The Founder\'s Sprint//Sessions//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${o.method || 'REQUEST'}`,
    'BEGIN:VEVENT',
    `UID:${o.uid}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SEQUENCE:${Number.isFinite(o.sequence) ? o.sequence : 0}`,
    `SUMMARY:${esc(o.title)}`,
    `DESCRIPTION:${esc(desc)}`,
    o.meetLink ? `LOCATION:${esc(o.meetLink)}` : null,
    o.meetLink ? `URL:${esc(o.meetLink)}` : null,
    o.organizerEmail
      ? `ORGANIZER;CN=${esc(o.organizerName || 'The Founder\'s Sprint')}:mailto:${o.organizerEmail}`
      : null,
    ...(o.attendees || []).filter(a => a && a.email).map(a =>
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE` +
      `;CN=${esc(a.name || a.email)}:mailto:${a.email}`),
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    // A 30-minute alarm on the recipient's own calendar, independent of our emails.
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${esc(o.title)}`,
    'TRIGGER:-PT30M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);

  // CRLF throughout, and a trailing CRLF — some parsers reject a file without it.
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildSessionIcs, _esc: esc, _fold: fold, _stamp: stamp };
