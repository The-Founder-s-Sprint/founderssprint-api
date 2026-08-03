/**
 * POST /api/mentor-recommendation
 *
 * Rate-limited anonymous "recommend a mentor" submission (founders suggesting an
 * operator who isn't on the platform yet). Same locked-down pattern as
 * /api/testimonial: there is NO anon INSERT policy on public.mentor_recommendations,
 * so the ONLY way to create a row is through this endpoint using the service role.
 * That gives us:
 *   - the strict rate limiter (5/min/IP, applied in api/index.js),
 *   - server-side validation + length caps + field whitelisting,
 *   - status forced to 'new' server-side (a submission can never self-advance).
 *
 * Admin review + invite happens in the Command Centre (Mentors portal).
 */
const { createClient } = require('@supabase/supabase-js');
const { sendMentorRecommendationInvite } = require('../lib/emailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (v, max) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const b = req.body || {};
  const prospect_name = clean(b.prospect_name, 160);
  const reason        = clean(b.reason, 2000);

  // ── Validate ────────────────────────────────────────────────────────────────
  if (!prospect_name || !reason) {
    return res.status(400).json({ error: 'Tell us who to recommend and why.' });
  }

  const recommender_email = clean(b.recommender_email, 254);
  if (recommender_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recommender_email)) {
    return res.status(400).json({ error: 'That email looks off.' });
  }

  const prospect_link    = clean(b.prospect_link, 400);
  const recommender_name = clean(b.recommender_name, 160);

  // ── Insert via service role; status forced to 'new' ─────────────────────────
  try {
    const { error } = await supabase.from('mentor_recommendations').insert({
      prospect_name,
      prospect_company:  clean(b.prospect_company, 200),
      prospect_link,
      reason,
      recommender_name,
      recommender_email,
      status: 'new',
    });
    if (error) {
      console.error('[mentor-recommendation] insert error:', error.message);
      return res.status(500).json({ error: 'Could not submit. Please try again.' });
    }

    // Automate onboarding: if the nominee's contact is an email, invite them to
    // self-register right away (best-effort — never fail the submission on email).
    let invited = false;
    if (prospect_link && EMAIL_RE.test(prospect_link)) {
      try {
        const r = await sendMentorRecommendationInvite({ email: prospect_link, prospect_name, recommender_name });
        invited = !!(r && r.ok);
      } catch (e) {
        console.error('[mentor-recommendation] invite email failed:', e.message);
      }
    }

    return res.status(201).json({ ok: true, invited });
  } catch (e) {
    console.error('[mentor-recommendation] error:', e.message);
    return res.status(500).json({ error: 'Could not submit. Please try again.' });
  }
};
