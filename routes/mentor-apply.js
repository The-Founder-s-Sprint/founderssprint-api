/**
 * POST /api/mentor-apply
 *
 * Rate-limited public mentor application (mentor-apply.html). Wraps the SQL
 * function submit_public_mentor_application(jsonb), which already does the hard
 * validation server-side:
 *   - forces status='applied' (an applicant can never self-list),
 *   - validates specialties against taxonomy_specialties (bogus slugs stripped),
 *   - requires consent + a valid email, caps formats to coffee/zoom,
 *   - ignores privileged fields (mentor_id, invite_token, admin_notes, KYC).
 *
 * Routing it through here adds the strict rate limiter (5/min/IP, api/index.js)
 * and lets us revoke anon EXECUTE on the function, so the ONLY way in is this
 * endpoint using the service role — same pattern as /api/mentor-recommendation.
 *
 * Admin review + approval happens in the Command Centre (Mentors → Applications).
 */
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Accept either {p:{...}} (RPC-shaped) or a bare payload.
  const body = req.body || {};
  const p = (body.p && typeof body.p === 'object') ? body.p : body;

  if (!p || typeof p !== 'object') {
    return res.status(400).json({ error: 'Invalid submission.' });
  }

  try {
    const { data, error } = await supabase.rpc('submit_public_mentor_application', { p });
    if (error) {
      // The function raises human-readable messages for the validation cases.
      const known = /Name required|Valid email required|Consent required/i.test(error.message || '');
      if (known) return res.status(400).json({ error: error.message });
      console.error('[mentor-apply] rpc error:', error.message);
      return res.status(500).json({ error: 'Could not submit. Please try again.' });
    }
    return res.status(201).json({ ok: true, id: data });
  } catch (e) {
    console.error('[mentor-apply] error:', e.message);
    return res.status(500).json({ error: 'Could not submit. Please try again.' });
  }
};
