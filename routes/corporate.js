/**
 * Corporate advisory — NDA-gated document vault API.
 *
 * The Command Centre + client portal read/write engagement data directly via
 * PostgREST (RLS enforces tenant isolation). This API exists only for FILE I/O,
 * which needs the service-role key:
 *   - POST /api/corporate/upload-url       → mint a signed upload URL (client uploads direct to storage)
 *   - POST /api/corporate/upload-complete  → record the uploaded file on the row
 *   - GET  /api/corporate/file-url         → mint a short-TTL signed download URL
 *
 * Because the service-role key BYPASSES RLS, every handler re-checks the caller's
 * membership (and the NDA gate) itself — it must never trust the client.
 *
 * Buckets are private (corporate-dd, corporate-deliverables). Object paths are
 * generated HERE, never taken from the client, so a caller can't target another
 * engagement's folder.
 */
const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');
const crypto  = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DD_BUCKET    = 'corporate-dd';
const DELIV_BUCKET = 'corporate-deliverables';
const DOWNLOAD_TTL = 900;               // 15 minutes
const MAX_BYTES    = 25 * 1024 * 1024;  // 25 MB

const EXT = {
  'application/pdf': 'pdf',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv', 'text/plain': 'txt', 'application/zip': 'zip',
};

// ── auth + authorization helpers (service role bypasses RLS → we enforce here) ──
async function authUser(req, res) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Authentication required' }); return null; }
  const { data: { user } = {}, error } = await supabase.auth.getUser(token);
  if (error || !user) { res.status(401).json({ error: 'Invalid session' }); return null; }
  return user;
}
async function sideOf(engagementId, userId) {
  const { data } = await supabase.from('engagement_members')
    .select('side').eq('engagement_id', engagementId).eq('user_id', userId).maybeSingle();
  return data ? data.side : null;
}
async function isCorpStaff(userId) {
  const { data } = await supabase.from('user_roles')
    .select('role').eq('user_id', userId).in('role', ['admin', 'finance']);
  return !!(data && data.length);
}
async function ndaSigned(engagementId) {
  const { data } = await supabase.from('engagement_contracts')
    .select('id').eq('engagement_id', engagementId).eq('type', 'mutual_nda').eq('status', 'signed').limit(1);
  return !!(data && data.length);
}
async function logEvent(engagementId, actor, action, target) {
  try {
    await supabase.from('engagement_activity_log')
      .insert({ engagement_id: engagementId, actor, action, target: target || null });
  } catch (_) {}
}

// ── POST /upload-url : mint a signed upload URL ──────────────────────────────
router.post('/upload-url', async (req, res) => {
  const user = await authUser(req, res); if (!user) return;
  const b = req.body || {};
  const engagementId = String(b.engagement_id || '');
  const kind = ['deliverable', 'nda', 'nda_template'].includes(b.kind) ? b.kind : 'dd';
  const documentId = b.document_id ? String(b.document_id) : '';
  const contentType = String(b.contentType || '').toLowerCase().trim();
  const size = Number(b.size || 0);

  if (!engagementId) return res.status(400).json({ error: 'engagement_id required' });
  if (!EXT[contentType]) return res.status(400).json({ error: 'Unsupported file type. Use PDF, Office, image, CSV or ZIP.' });
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) return res.status(400).json({ error: 'File must be under 25MB.' });

  const side = await sideOf(engagementId, user.id);
  const staff = await isCorpStaff(user.id);
  if (!side && !staff) return res.status(403).json({ error: 'Not authorised for this engagement' });

  let bucket, path;
  if (kind === 'deliverable') {
    if (!(side === 'firm' || staff)) return res.status(403).json({ error: 'Firm access required' });
    bucket = DELIV_BUCKET;
    path = engagementId + '/deliverables/' + (documentId || crypto.randomUUID()) + '/' + crypto.randomUUID() + '.' + EXT[contentType];
  } else if (kind === 'nda_template') {
    // The blank NDA the firm provides for the client to review — NOT gated.
    if (!(side === 'firm' || staff)) return res.status(403).json({ error: 'Firm access required' });
    bucket = DD_BUCKET;
    path = engagementId + '/nda/template/' + crypto.randomUUID() + '.' + EXT[contentType];
  } else if (kind === 'nda') {
    // The client's signed NDA copy — this IS how the NDA gets signed, so it is
    // NOT itself NDA-gated. Any engagement member (typically the client) may upload.
    bucket = DD_BUCKET;
    path = engagementId + '/nda/signed/' + crypto.randomUUID() + '.' + EXT[contentType];
  } else {
    // DD vault is NDA-gated
    if (!(await ndaSigned(engagementId))) return res.status(403).json({ error: 'The NDA must be signed before uploading documents.' });
    if (documentId) {
      const { data: doc } = await supabase.from('engagement_documents')
        .select('id').eq('id', documentId).eq('engagement_id', engagementId).maybeSingle();
      if (!doc) return res.status(404).json({ error: 'Document item not found on this engagement' });
    }
    bucket = DD_BUCKET;
    path = engagementId + '/dd/' + (documentId || crypto.randomUUID()) + '/' + crypto.randomUUID() + '.' + EXT[contentType];
  }

  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path);
    if (error) throw error;
    return res.status(201).json({ ok: true, bucket, path, token: data.token, signedUrl: data.signedUrl });
  } catch (e) {
    console.error('[corporate/upload-url]', e.message);
    return res.status(500).json({ error: 'Could not start the upload. Please try again.' });
  }
});

// ── POST /upload-complete : record the uploaded file on its row ──────────────
router.post('/upload-complete', async (req, res) => {
  const user = await authUser(req, res); if (!user) return;
  const b = req.body || {};
  const engagementId = String(b.engagement_id || '');
  const kind = b.kind === 'deliverable' ? 'deliverable' : 'dd';
  const documentId = String(b.document_id || '');
  const path = String(b.path || '');
  const size = Number(b.size || 0) || null;
  const mime = b.mime ? String(b.mime) : null;

  if (!engagementId || !documentId || !path) return res.status(400).json({ error: 'engagement_id, document_id and path required' });
  if (!path.startsWith(engagementId + '/')) return res.status(400).json({ error: 'Path does not belong to this engagement' });

  const side = await sideOf(engagementId, user.id);
  const staff = await isCorpStaff(user.id);
  if (!side && !staff) return res.status(403).json({ error: 'Not authorised for this engagement' });

  try {
    if (kind === 'deliverable') {
      if (!(side === 'firm' || staff)) return res.status(403).json({ error: 'Firm access required' });
      const { error } = await supabase.from('engagement_deliverables')
        .update({ storage_path: path }).eq('id', documentId).eq('engagement_id', engagementId);
      if (error) throw error;
      await logEvent(engagementId, user.id, 'deliverable_file_uploaded', documentId);
    } else {
      if (!(await ndaSigned(engagementId))) return res.status(403).json({ error: 'NDA not signed' });
      const { data: doc, error: dErr } = await supabase.from('engagement_documents')
        .update({ storage_path: path, mime, size, uploaded_by: user.id, uploaded_at: new Date().toISOString(), submission_status: 'provided' })
        .eq('id', documentId).eq('engagement_id', engagementId).select('item_key').maybeSingle();
      if (dErr) throw dErr;
      if (!doc) return res.status(404).json({ error: 'Document item not found' });
      await logEvent(engagementId, user.id, 'dd_uploaded', doc.item_key);
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('[corporate/upload-complete]', e.message);
    return res.status(500).json({ error: 'Could not record the upload.' });
  }
});

// ── GET /file-url?kind=document|deliverable&id= : short-TTL signed download ──
router.get('/file-url', async (req, res) => {
  const user = await authUser(req, res); if (!user) return;
  const kind = ['deliverable', 'contract'].includes(req.query.kind) ? req.query.kind : 'document';
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    let bucket, storagePath, engagementId;
    if (kind === 'contract') {
      const which = req.query.which === 'signed' ? 'storage_path' : 'template_path';
      const { data: c } = await supabase.from('engagement_contracts')
        .select('engagement_id, template_path, storage_path').eq('id', id).maybeSingle();
      if (!c || !c[which]) return res.status(404).json({ error: 'File not found' });
      const side = await sideOf(c.engagement_id, user.id);
      const staff = await isCorpStaff(user.id);
      if (!side && !staff) return res.status(403).json({ error: 'Not authorised' });
      bucket = DD_BUCKET; storagePath = c[which]; engagementId = c.engagement_id;
    } else if (kind === 'deliverable') {
      const { data: v } = await supabase.from('engagement_deliverables')
        .select('engagement_id, storage_path, status').eq('id', id).maybeSingle();
      if (!v || !v.storage_path) return res.status(404).json({ error: 'File not found' });
      const side = await sideOf(v.engagement_id, user.id);
      const staff = await isCorpStaff(user.id);
      if (!side && !staff) return res.status(403).json({ error: 'Not authorised' });
      // clients only get delivered/approved work product; firm/staff any state
      if (side === 'client' && !staff && !['delivered', 'approved'].includes(v.status)) {
        return res.status(403).json({ error: 'Not yet released' });
      }
      bucket = DELIV_BUCKET; storagePath = v.storage_path; engagementId = v.engagement_id;
    } else {
      const { data: d } = await supabase.from('engagement_documents')
        .select('engagement_id, storage_path, item_key').eq('id', id).maybeSingle();
      if (!d || !d.storage_path) return res.status(404).json({ error: 'File not found' });
      const side = await sideOf(d.engagement_id, user.id);
      const staff = await isCorpStaff(user.id);
      if (!side && !staff) return res.status(403).json({ error: 'Not authorised' });
      bucket = DD_BUCKET; storagePath = d.storage_path; engagementId = d.engagement_id;
    }
    const { data: signed, error } = await supabase.storage.from(bucket).createSignedUrl(storagePath, DOWNLOAD_TTL);
    if (error) throw error;
    await logEvent(engagementId, user.id, 'file_downloaded', id);
    return res.json({ ok: true, url: signed.signedUrl });
  } catch (e) {
    console.error('[corporate/file-url]', e.message);
    return res.status(500).json({ error: 'Could not generate the download link.' });
  }
});

// ── POST /invite-client : create the client's login + link them to the engagement ──
// Admin/finance only. Creates (or finds) the auth account, adds an engagement_members
// row (side=client), and emails a set-password link to the corporate portal.
const { sendCorporateClientInvite } = require('../lib/emailer');

router.post('/invite-client', async (req, res) => {
  const user = await authUser(req, res); if (!user) return;
  if (!(await isCorpStaff(user.id))) return res.status(403).json({ error: 'Admin or finance access required' });

  const b = req.body || {};
  const engagementId = String(b.engagement_id || '');
  const email = String(b.email || '').trim().toLowerCase();
  const name = b.name ? String(b.name).trim() : '';
  const role = ['primary_contact', 'authorized_signatory', 'viewer'].includes(b.role) ? b.role : 'primary_contact';

  if (!engagementId) return res.status(400).json({ error: 'engagement_id required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });

  try {
    // engagement + client name for the email
    const { data: eng } = await supabase.from('corporate_engagements')
      .select('id, title, client_id, corporate_clients(name)').eq('id', engagementId).maybeSingle();
    if (!eng) return res.status(404).json({ error: 'Engagement not found' });
    const clientName = (eng.corporate_clients && eng.corporate_clients.name) || 'your company';

    const redirectTo = process.env.CORPORATE_PORTAL_URL || 'https://founderssprint.co/corporate-portal.html';

    // create-or-find the auth account, get a single-use action link
    let existing = false;
    let gen = await supabase.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } });
    if (gen.error) {
      const m = (gen.error.message || '').toLowerCase();
      if (m.includes('already') || m.includes('registered') || m.includes('exist')) {
        existing = true;
        gen = await supabase.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
        if (gen.error) throw new Error(gen.error.message);
      } else { throw new Error(gen.error.message); }
    }
    const actionUrl = gen.data?.properties?.action_link;
    const newUserId = gen.data?.user?.id;
    if (!actionUrl || !newUserId) throw new Error('Could not generate the invite link');

    // link them to the engagement (idempotent on engagement_id,user_id)
    const { error: mErr } = await supabase.from('engagement_members')
      .upsert({ engagement_id: engagementId, user_id: newUserId, side: 'client', role, invited_by: user.id },
              { onConflict: 'engagement_id,user_id', ignoreDuplicates: true });
    if (mErr) throw new Error('Could not link the client: ' + mErr.message);

    await logEvent(engagementId, user.id, 'client_invited', email);

    let emailed = false;
    try {
      const r = await sendCorporateClientInvite({ to: email, name: name || email.split('@')[0], clientName, engagementTitle: eng.title || '', actionUrl });
      emailed = !!(r && r.ok);
    } catch (e) { console.error('[corporate/invite-client] email', e.message); }

    return res.json({ ok: true, created: !existing, emailed });
  } catch (e) {
    console.error('[corporate/invite-client]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
