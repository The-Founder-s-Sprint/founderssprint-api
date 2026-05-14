/**
 * GET /api/materials?token=<TOKEN>
 *
 * Public endpoint — validates an access token, then returns:
 *   • founder's name & cohort info
 *   • signed download URLs for every document tagged to that cohort
 *     (plus documents with cohort_id = NULL, i.e. "all cohorts")
 *
 * Tokens are single-use in the sense that they expire at the cohort end_date;
 * the first access is recorded in `used_at` for auditing.
 */

const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SIGNED_URL_TTL = 3600; // 1 hour per download link

router.get('/', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token parameter' });

  try {
    // ── 1. Look up the token ─────────────────────────────────────────────────
    const { data: tk, error: tkErr } = await supabase
      .from('access_tokens')
      .select('*, registration:registrations(first_name, last_name, email, track), cohort:cohorts(name, start_date, end_date, dates)')
      .eq('token', token)
      .single();

    if (tkErr || !tk) return res.status(404).json({ error: 'Invalid or unknown access link' });

    // ── 2. Check revocation ──────────────────────────────────────────────────
    if (tk.revoked) return res.status(403).json({ error: 'This access link has been revoked' });

    // ── 3. Check expiry ──────────────────────────────────────────────────────
    if (new Date(tk.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This access link has expired' });
    }

    // ── 4. Record first access ───────────────────────────────────────────────
    if (!tk.used_at) {
      await supabase
        .from('access_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('id', tk.id);
    }

    // ── 5. Fetch documents for this cohort (+ "all cohorts" docs) ────────────
    const { data: docs, error: docErr } = await supabase
      .from('documents')
      .select('id, name, description, category, storage_path, file_size, mime_type, created_at')
      .or(`cohort_id.eq.${tk.cohort_id},cohort_id.is.null`)
      .order('category')
      .order('created_at', { ascending: false });

    if (docErr) throw docErr;

    // ── 6. Generate signed URLs for each document ────────────────────────────
    const files = [];
    for (const doc of (docs || [])) {
      const { data: signed } = await supabase.storage
        .from('course-materials')
        .createSignedUrl(doc.storage_path, SIGNED_URL_TTL);

      files.push({
        id:          doc.id,
        name:        doc.name,
        description: doc.description,
        category:    doc.category,
        size:        doc.file_size,
        mime:        doc.mime_type,
        uploadedAt:  doc.created_at,
        downloadUrl: signed?.signedUrl || null,
      });
    }

    // ── 7. Return payload ────────────────────────────────────────────────────
    res.json({
      ok: true,
      founder: {
        firstName: tk.registration.first_name,
        lastName:  tk.registration.last_name,
        track:     tk.registration.track,
      },
      cohort: {
        name:      tk.cohort.name,
        startDate: tk.cohort.start_date,
        endDate:   tk.cohort.end_date,
        dates:     tk.cohort.dates,
      },
      expiresAt: tk.expires_at,
      files,
    });
  } catch (err) {
    console.error('[Materials] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
