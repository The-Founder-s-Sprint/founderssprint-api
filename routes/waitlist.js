const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── POST /api/waitlist ───────────────────────────────────────────────────────
router.post('/waitlist', async (req, res) => {
  const { name, email, phone, business, source } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }

  try {
    // Upsert by email — if they sign up twice, update their info
    const { data, error } = await supabase
      .from('waitlist')
      .upsert(
        {
          name:     (name || '').trim().slice(0, 120) || null,
          email:    email.trim().toLowerCase().slice(0, 254),
          phone:    (phone || '').trim().slice(0, 40) || null,
          business: (business || '').trim().slice(0, 160) || null,
          source:   (source || 'website').trim().slice(0, 60),
        },
        { onConflict: 'email' }
      )
      .select();

    if (error) {
      console.error('[Waitlist] Supabase error:', error);
      return res.status(500).json({ error: 'Failed to save signup.' });
    }

    res.status(200).json({ success: true, message: 'Added to waitlist.' });
  } catch (err) {
    console.error('[Waitlist] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── GET /api/waitlist/count — public count for social proof ──────────────────
router.get('/waitlist/count', async (_req, res) => {
  try {
    const { count, error } = await supabase
      .from('waitlist')
      .select('*', { count: 'exact', head: true });

    if (error) {
      return res.status(500).json({ error: 'Failed to get count.' });
    }

    res.json({ count: count || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
