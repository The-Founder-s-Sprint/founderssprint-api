/**
 * POST /api/investor-application
 *
 * Rate-limited public investor intake (beta/investor-onboarding.html). Wraps the
 * SQL function submit_investor_application(jsonb), which hardcodes status='pending'
 * and public=false — so an applicant can never self-approve or self-publish a firm.
 *
 * Routing it through here adds the strict rate limiter (5/min/IP, api/index.js) and
 * lets us revoke anon EXECUTE on the function, so the ONLY way in is this endpoint
 * using the service role — same pattern as /api/mentor-recommendation.
 *
 * Admin approval happens in the Command Centre (Investors portal).
 */
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const p = (body.p && typeof body.p === 'object') ? body.p : body;

  const name = p && p.name ? String(p.name).trim() : '';
  if (!name) return res.status(400).json({ error: 'Firm or investor name is required.' });

  const contactEmail = p && p.contact_email ? String(p.contact_email).trim() : '';
  if (!contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    return res.status(400).json({ error: 'A valid contact email is required.' });
  }

  try {
    const { data, error } = await supabase.rpc('submit_investor_application', { p });
    if (error) {
      console.error('[investor-application] rpc error:', error.message);
      return res.status(500).json({ error: 'Could not submit. Please try again.' });
    }
    return res.status(201).json({ ok: true, id: data });
  } catch (e) {
    console.error('[investor-application] error:', e.message);
    return res.status(500).json({ error: 'Could not submit. Please try again.' });
  }
};
