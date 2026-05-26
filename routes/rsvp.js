const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── POST /api/rsvp ───────────────────────────────────────────────────────────
router.post('/rsvp', async (req, res) => {
  const { name, email, phone, company, guest_count, notes, event_name } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }

  try {
    const { data, error } = await supabase
      .from('event_rsvps')
      .upsert(
        {
          event_name: (event_name || 'launch-july-2026').trim(),
          name:       (name || '').trim() || null,
          email:      email.trim().toLowerCase(),
          phone:      (phone || '').trim() || null,
          company:    (company || '').trim() || null,
          guest_count: Math.min(Math.max(parseInt(guest_count) || 1, 1), 5),
          notes:      (notes || '').trim() || null,
        },
        { onConflict: 'event_name,email' }
      )
      .select();

    if (error) {
      console.error('[RSVP] Supabase error:', error);
      return res.status(500).json({ error: 'Failed to save RSVP.' });
    }

    res.status(200).json({ success: true, message: 'RSVP confirmed.' });
  } catch (err) {
    console.error('[RSVP] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
