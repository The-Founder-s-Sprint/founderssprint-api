/**
 * Course Materials API
 *
 * Admin endpoints for managing the curriculum content library.
 * Extends beyond coach_presentations by adding curriculum structure,
 * content lifecycle (draft → in_review → published), and delivery controls.
 *
 * Routes:
 *   GET    /api/course-materials              — list materials (filterable)
 *   GET    /api/course-materials/curriculum    — curriculum map (week × discipline grid)
 *   GET    /api/course-materials/:id           — single material
 *   POST   /api/course-materials               — create a new material
 *   PATCH  /api/course-materials/:id           — update material metadata
 *   DELETE /api/course-materials/:id           — soft-delete (is_active = false)
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
      console.error('[CourseMaterials] Auth validation error:', err.message);
    }
  }
  return res.status(403).json({ error: 'Forbidden' });
}

// ── GET /api/course-materials — list materials ─────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const { coach_id, discipline, status, week, access_type, active_only } = req.query;

    let query = supabase
      .from('course_materials')
      .select('*')
      .order('week_number', { ascending: true, nullsFirst: false })
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (coach_id)    query = query.eq('coach_id', coach_id);
    if (discipline)  query = query.eq('discipline', discipline);
    if (status)      query = query.eq('status', status);
    if (week)        query = query.eq('week_number', parseInt(week));
    if (access_type) query = query.eq('access_type', access_type);
    if (active_only) query = query.eq('is_active', true);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/course-materials/curriculum — curriculum map ───────────────────
// Returns materials grouped by week_number for the visual curriculum grid
router.get('/curriculum', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('course_materials')
      .select('*')
      .eq('is_active', true)
      .not('week_number', 'is', null)
      .order('week_number', { ascending: true })
      .order('sort_order', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    // Group by week
    const weeks = {};
    for (const mat of (data || [])) {
      const w = mat.week_number;
      if (!weeks[w]) weeks[w] = [];
      weeks[w].push(mat);
    }

    res.json({ weeks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/course-materials/:id — single material ─────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('course_materials')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Material not found' });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/course-materials — create a new material ─────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      coach_id,
      title,
      discipline,
      module_type     = 'lesson',
      week_number     = null,
      session_code    = null,
      sort_order      = 0,
      duration_minutes = 120,
      file_path       = null,
      source_url      = null,
      format          = 'html_native',
      status          = 'draft',
      access_type     = 'both',
      description     = null,
    } = req.body;

    if (!coach_id || !title || !discipline) {
      return res.status(400).json({
        error: 'Missing required fields: coach_id, title, discipline',
      });
    }

    const { data, error } = await supabase
      .from('course_materials')
      .insert({
        coach_id,
        title,
        discipline,
        module_type,
        week_number:     week_number ? parseInt(week_number) : null,
        session_code:    session_code || null,
        sort_order:      parseInt(sort_order) || 0,
        duration_minutes: parseInt(duration_minutes) || 120,
        file_path:       file_path || null,
        source_url:      source_url || null,
        format,
        status,
        access_type,
        description:     description || null,
        is_active:       true,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    console.log(`[CourseMaterials] Created "${title}" for coach ${coach_id} (${discipline})`);
    res.json({ ok: true, material: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/course-materials/:id — update material ─────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = [
      'title', 'description', 'discipline', 'module_type',
      'week_number', 'session_code', 'sort_order', 'duration_minutes',
      'file_path', 'source_url', 'format',
      'status', 'access_type', 'is_active',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('course_materials')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Material not found' });

    console.log(`[CourseMaterials] Updated material #${id}: ${JSON.stringify(updates)}`);
    res.json({ ok: true, material: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/course-materials/:id — soft-delete ─────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('course_materials')
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Material not found' });

    console.log(`[CourseMaterials] Deactivated material #${id}`);
    res.json({ ok: true, material: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
