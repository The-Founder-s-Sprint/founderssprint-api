/**
 * Google Meet REST API (v2) — who actually joined a call.
 *
 * This is the evidence that a session was DELIVERED. It is deliberately not a
 * measure of completion: a founder who joins for ten minutes and loses network
 * still had the session delivered. Whether they did the work is the coach's
 * judgement, recorded separately against the L3.
 *
 * Requires the Meet API enabled on the Cloud project and this scope added to the
 * service account's domain-wide delegation:
 *   https://www.googleapis.com/auth/meetings.space.readonly
 *
 * IDENTITY CAVEAT — read before trusting a match.
 * The API returns a participant's DISPLAY NAME. `signedinUser.user` is a People
 * API resource id, not an email; resolving it needs the Admin SDK Directory
 * scope as well. So we match on name and report anything we cannot match rather
 * than guessing. Phone joins and personal Google accounts often will not match —
 * which is why the coach's manual mark stays permanently, not as a stopgap.
 */
const { getAccessToken } = require('./google-calendar');

const MEET_API = 'https://meet.googleapis.com/v2';

/** "https://meet.google.com/qew-rchz-rjf" → "qew-rchz-rjf" */
function meetingCodeFrom(meetLink) {
  if (!meetLink) return null;
  const m = String(meetLink).match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  return m ? m[1].toLowerCase() : null;
}

async function meetGet(path, asUser) {
  const token = await getAccessToken(asUser);
  const res = await fetch(MEET_API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Meet API ${res.status} on ${path} — ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Everyone who joined the conference for one meeting code, with their total time.
 * Rejoins are collapsed: a founder whose network dropped twice is one person who
 * attended, not three.
 *
 * @returns [{ displayName, kind, minutes, firstJoined, lastLeft, joinCount }]
 */
async function attendanceForMeeting(meetLink, asUser, endedAfter) {
  const code = meetingCodeFrom(meetLink);
  if (!code) return { code: null, participants: [] };

  // Conference records are per-conference: one per time the meeting was actually
  // held, so a weekly recurring link has many. Filter to the window we care about.
  const filter = encodeURIComponent(`space.meeting_code="${code}"`);
  const recs = await meetGet(`/conferenceRecords?filter=${filter}&pageSize=20`, asUser);
  let records = recs.conferenceRecords || [];
  if (endedAfter) {
    const cutoff = new Date(endedAfter).getTime();
    records = records.filter(r => !r.startTime || new Date(r.startTime).getTime() >= cutoff);
  }
  if (!records.length) return { code, participants: [] };

  // Most recent conference for this code within the window.
  records.sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));
  const rec = records[0];

  const parts = await meetGet(`/${rec.name}/participants?pageSize=100`, asUser);
  const out = [];

  for (const p of (parts.participants || [])) {
    const who = p.signedinUser || p.anonymousUser || p.phoneUser || {};
    const kind = p.signedinUser ? 'signed_in' : (p.phoneUser ? 'phone' : 'anonymous');

    // Each participant may have several sessions (left and rejoined). Sum them.
    let minutes = 0, joinCount = 0, first = null, last = null;
    try {
      const sess = await meetGet(`/${p.name}/participantSessions?pageSize=50`, asUser);
      for (const s of (sess.participantSessions || [])) {
        if (!s.startTime) continue;
        joinCount++;
        const st = new Date(s.startTime);
        const en = s.endTime ? new Date(s.endTime) : new Date(rec.endTime || s.startTime);
        minutes += Math.max(0, Math.round((en - st) / 60000));
        if (!first || st < first) first = st;
        if (!last || en > last) last = en;
      }
    } catch (e) {
      // A missing session breakdown must not lose the fact that they joined.
      console.error('[meet] participantSessions failed for', p.name, e.message);
    }

    out.push({
      displayName: who.displayName || null,
      kind,
      minutes: minutes || null,
      joinCount: joinCount || null,
      firstJoined: first ? first.toISOString() : null,
      lastLeft: last ? last.toISOString() : null,
    });
  }

  return { code, conference: rec.name, startTime: rec.startTime, participants: out };
}

/**
 * Match a Meet display name to someone on the session roster.
 * Conservative by design: an unmatched participant is reported, never guessed
 * onto a founder. A wrong attendance record is worse than a missing one, because
 * it becomes evidence of a delivery that may not have happened.
 */
function matchToRoster(displayName, roster) {
  if (!displayName) return null;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  const d = norm(displayName);
  if (!d) return null;

  // 1. Exact name match.
  let hit = roster.find(r => norm(r.name) === d);
  if (hit) return hit;

  // 2. The local part of their email, as some people's Meet name is their handle.
  hit = roster.find(r => norm(String(r.email || '').split('@')[0]) === d);
  if (hit) return hit;

  // 3. Every word of a roster name appears in the display name (handles middle
  //    names and reordering) — but only when it is unambiguous.
  const candidates = roster.filter(r => {
    const words = norm(r.name).split(' ').filter(w => w.length > 2);
    return words.length >= 2 && words.every(w => d.includes(w));
  });
  return candidates.length === 1 ? candidates[0] : null;
}

module.exports = { attendanceForMeeting, matchToRoster, meetingCodeFrom };
