/**
 * POST /api/bug-report
 *
 * Rate-limited problem reports from the in-app widget (report-widget.js).
 * Same locked-down pattern as /api/mentor-recommendation and /api/testimonial:
 * there is NO anon INSERT policy on public.bug_reports, so the ONLY way to create
 * a row is through this endpoint using the service role. That gives us:
 *   - the strict rate limiter (5/min/IP, applied in api/index.js),
 *   - server-side validation, length caps and field whitelisting,
 *   - status forced to 'new' (a report can never self-triage),
 *   - attribution that CANNOT be forged: reporter_user_id comes from a *verified*
 *     Bearer token, never from the request body.
 *
 * Triage happens in the Command Centre (Admin & Ops → Bug & error reports).
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

const SEVERITIES = ['low', 'normal', 'high', 'critical'];
const KINDS      = ['bug', 'error', 'feedback', 'other'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const b = req.body || {};
  const summary = clean(b.summary, 300);
  if (!summary || summary.length < 3) {
    return res.status(400).json({ error: 'Please describe what happened.' });
  }

  const reporter_email = clean(b.reporter_email, 254);
  if (reporter_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporter_email)) {
    return res.status(400).json({ error: 'That email looks off.' });
  }

  // ── Attribution: only ever from a verified token ────────────────────────────
  // The widget sends the signed-in founder's access token. We resolve the user
  // server-side; anything the client *claims* about reporter_user_id is ignored.
  let reporter_user_id = null;
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (token) {
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data && data.user) reporter_user_id = data.user.id;
    } catch (_) { /* anonymous report — fine */ }
  }

  try {
    const { error } = await supabase.from('bug_reports').insert({
      summary,
      details:       clean(b.details, 4000),
      severity:      SEVERITIES.includes(b.severity) ? b.severity : 'normal',
      kind:          KINDS.includes(b.kind) ? b.kind : 'bug',
      page:          clean(b.page, 500),
      area:          clean(b.area, 120),
      reporter_role: clean(b.reporter_role, 60),
      reporter_email,
      reporter_user_id,
      user_agent:    clean(b.user_agent, 500),
      console_error: clean(b.console_error, 2000),
      status: 'new',
    });
    if (error) {
      console.error('[bug-report] insert error:', error.message);
      return res.status(500).json({ error: 'Could not submit. Please try again.' });
    }
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error('[bug-report] error:', e.message);
    return res.status(500).json({ error: 'Could not submit. Please try again.' });
  }
};
