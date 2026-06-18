/**
 * POST /api/testimonial
 *
 * Rate-limited anonymous testimonial submission. This REPLACES the previous
 * direct anon Supabase REST insert into testimonial_submissions — that path is an
 * unauthenticated write surface with no rate limiting, so it could be spammed to
 * flood the moderation queue. Routing it through the API gives us:
 *   - the strict rate limiter (5/min/IP, applied in api/index.js),
 *   - server-side validation + length caps + field whitelisting,
 *   - status forced to 'new' server-side so a submission can never self-approve.
 *
 * The photo (optional) is uploaded client-side to the testimonial-photos bucket,
 * which is now MIME- (images only) and size-capped (5MB); we accept only a
 * sanitized filename here (no path traversal) and never trust client-set fields
 * like status/approved.
 *
 * After this ships, drop the anon INSERT policy on public.testimonial_submissions
 * so the ONLY way to create a submission is through this rate-limited endpoint.
 */
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Coach slugs that ratings/testimonials can target (must match the explore/profile slugs).
const VALID_TARGETS = ['teddy-ruge', 'barry-wojega', 'joseph-kalema', 'moses-okudu', 'patrick-ngolobe', 'group'];
const PHOTO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(jpe?g|png|webp)$/i;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const b = req.body || {};
  const name        = (b.name || '').toString().trim();
  const testimonial = (b.testimonial || '').toString().trim();

  // ── Validate ────────────────────────────────────────────────────────────────
  if (!name || !testimonial || b.consent !== true) {
    return res.status(400).json({ error: 'Name, a testimonial, and consent are required.' });
  }
  if (name.length > 120 || testimonial.length > 2000) {
    return res.status(400).json({ error: 'Submission is too long.' });
  }

  const for_target = VALID_TARGETS.includes(b.for_target) ? b.for_target : 'group';

  // Rating only applies to an individual coach, clamped 1–5.
  let rating = null;
  if (for_target !== 'group') {
    const n = parseInt(b.rating, 10);
    if (n >= 1 && n <= 5) rating = n;
  }

  // Only accept a clean image filename (the file itself lives in the capped bucket).
  let photo_path = null;
  if (b.photo_path && PHOTO_RE.test(String(b.photo_path))) photo_path = String(b.photo_path);

  // ── Insert via service role; status forced to 'new' (cannot self-approve) ────
  try {
    const { error } = await supabase.from('testimonial_submissions').insert({
      name,
      role_title:  b.role_title ? b.role_title.toString().trim().slice(0, 120) : null,
      company:     b.company    ? b.company.toString().trim().slice(0, 120)    : null,
      for_target,
      testimonial,
      photo_path,
      consent: true,
      status:  'new',
      rating,
    });
    if (error) {
      console.error('[testimonial] insert error:', error.message);
      return res.status(500).json({ error: 'Could not submit. Please try again.' });
    }
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error('[testimonial] error:', e.message);
    return res.status(500).json({ error: 'Could not submit. Please try again.' });
  }
};
