/**
 * POST /api/mentor-apply-photo
 *
 * Issues a short-lived, single-use signed upload URL so a mentor applicant can
 * attach a headshot — WITHOUT opening an anonymous write policy on the storage
 * bucket. Rate-limited (5/min/IP, applied in api/index.js).
 *
 * Why a signed URL rather than posting the file through here: Vercel caps a
 * serverless request body at ~4.5MB, so a 5MB photo (bigger still as base64)
 * could never make it through the function. The browser uploads straight to
 * storage instead; this endpoint only mints the permission.
 *
 * Security:
 *   - The object path is generated HERE, never taken from the client — so an
 *     applicant cannot target someone else's path and overwrite their photo.
 *   - The bucket independently enforces image/jpeg|png|webp and a 5MB limit, so
 *     a client that uploads something other than it declared is still rejected.
 *   - Uploads land under applications/ and only become a public mentor photo if
 *     an admin approves the application.
 */
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 5 * 1024 * 1024;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const b = req.body || {};
  const contentType = String(b.contentType || '').toLowerCase().trim();
  const size = Number(b.size || 0);

  if (!EXT[contentType]) {
    return res.status(400).json({ error: 'Use a PNG, JPG or WebP image.' });
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
    return res.status(400).json({ error: 'Image must be under 5MB.' });
  }

  // Server-generated path — the client never chooses where the file lands.
  const path = 'applications/' + crypto.randomUUID() + '.' + EXT[contentType];

  try {
    const { data, error } = await supabase
      .storage.from('mentor-photos')
      .createSignedUploadUrl(path);

    if (error) {
      console.error('[mentor-apply-photo] sign error:', error.message);
      return res.status(500).json({ error: 'Could not start the upload. Please try again.' });
    }

    const publicUrl = supabase.storage.from('mentor-photos').getPublicUrl(path).data.publicUrl;
    return res.status(201).json({ ok: true, signedUrl: data.signedUrl, token: data.token, path, publicUrl });
  } catch (e) {
    console.error('[mentor-apply-photo] error:', e.message);
    return res.status(500).json({ error: 'Could not start the upload. Please try again.' });
  }
};
