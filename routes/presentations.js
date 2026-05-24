/**
 * Coach Presentations API
 *
 * Admin-only endpoints for managing presentation links on coach profiles.
 * Presentations are standalone HTML files uploaded to the server by Teddy,
 * then linked to a coach via this API.
 *
 * Routes:
 *   GET    /api/presentations?coach_id=<UUID>  — list presentations for a coach (or all)
 *   POST   /api/presentations                  — link a presentation to a coach
 *   PATCH  /api/presentations/:id              — update presentation metadata
 *   DELETE /api/presentations/:id              — soft-delete (set is_active = false)
 */

const express = require('express');
const router  = express.Router();
const { supabase } = require('../lib/db');

// ── Auth middleware — accepts admin secret OR Bearer token ────────────────────
async function requireAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (secret && secret === process.env.ADMIN_SECRET) return next();

  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (user && !error) { req.user = user; return next(); }
    } catch (err) {
      console.error('[Presentations] Auth validation error:', err.message);
    }
  }
  return res.status(403).json({ error: 'Forbidden' });
}

// ── GET /api/presentations — list presentations ─────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { coach_id, active_only } = req.query;

    let query = supabase
      .from('coach_presentations')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (coach_id)    query = query.eq('coach_id', coach_id);
    if (active_only) query = query.eq('is_active', true);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/presentations — link a presentation to a coach ────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      coach_id,
      title,
      taxonomy_l1,
      session_code,
      file_path,
      description,
      duration_minutes = 120,
      sort_order = 0,
    } = req.body;

    if (!coach_id || !title || !taxonomy_l1 || !file_path) {
      return res.status(400).json({
        error: 'Missing required fields: coach_id, title, taxonomy_l1, file_path',
      });
    }

    const { data, error } = await supabase
      .from('coach_presentations')
      .insert({
        coach_id,
        title,
        taxonomy_l1,
        session_code: session_code || null,
        file_path,
        description: description || null,
        duration_minutes,
        sort_order,
        is_active: true,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    console.log(`[Presentations] Linked "${title}" to coach ${coach_id}`);
    res.json({ ok: true, presentation: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/presentations/:id — update presentation metadata ─────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['title', 'taxonomy_l1', 'session_code', 'file_path', 'description', 'duration_minutes', 'sort_order', 'is_active'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('coach_presentations')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Presentation not found' });

    res.json({ ok: true, presentation: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/presentations/:id — soft-delete ─────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('coach_presentations')
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Presentation not found' });

    console.log(`[Presentations] Deactivated presentation #${id}`);
    res.json({ ok: true, presentation: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
