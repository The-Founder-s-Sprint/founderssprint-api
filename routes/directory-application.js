/**
 * POST /api/directory-application
 *
 * Rate-limited public service-provider directory application (beta/apply-directory.html).
 * Same locked-down pattern as /api/mentor-recommendation: there is NO anon INSERT
 * policy on public.directory_applications, so the ONLY way to create a row is this
 * endpoint using the service role. That gives us:
 *   - the strict rate limiter (5/min/IP, applied in api/index.js),
 *   - server-side validation, length caps and field whitelisting,
 *   - status forced to 'pending' (an applicant can never self-approve or self-list),
 *   - preferred_tier is a *request*, never an entitlement — pricing/approval is admin-side.
 *
 * Admin review happens in the ops dashboard (directory lifecycle).
 */
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const clean = (v, max) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const b = req.body || {};
  const company_name = clean(b.company_name, 200);
  const category     = clean(b.category, 80);
  const contact_name = clean(b.contact_name, 160);
  const email        = clean(b.email, 254);

  if (!company_name || !category || !contact_name || !email) {
    return res.status(400).json({ error: 'Please complete the required fields.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'That email looks off.' });
  }

  try {
    const { error } = await supabase.from('directory_applications').insert({
      company_name,
      category,
      contact_name,
      email: email.toLowerCase(),
      phone:          clean(b.phone, 40),
      website:        clean(b.website, 400),
      preferred_tier: clean(b.preferred_tier, 40),
      message:        clean(b.message, 2000),
      status: 'pending',
    });
    if (error) {
      console.error('[directory-application] insert error:', error.message);
      return res.status(500).json({ error: 'Could not submit. Please try again.' });
    }
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error('[directory-application] error:', e.message);
    return res.status(500).json({ error: 'Could not submit. Please try again.' });
  }
};
