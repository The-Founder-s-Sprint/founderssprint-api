const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const {
  createCoachApplication,
  getCoachApplications,
  getCoachApplication,
  updateCoachApplication,
  createCoachFromApplication,
  createCoachAuthAccount,
  createApprovalVote,
  getApprovalVotes,
  uploadCoachFile,
  supabase,
} = require('../lib/db');
const {
  sendCoachConfirmation,
  sendCoachAdminNotification,
  sendCoachApproval,
  sendCoachRejection,
} = require('../lib/emailer');

// ── Multer config: memory storage for Supabase upload ──────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'application/pdf',
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Invalid file type: ' + file.mimetype));
  },
});

const fileFields = upload.fields([
  { name: 'profile_photo', maxCount: 1 },
  { name: 'cv_file',       maxCount: 1 },
  { name: 'id_document',   maxCount: 1 },
]);

// ── Auth middleware (admin routes) ──────────────────────────────────────────
// Accept either x-admin-secret OR a valid Supabase JWT (from the dashboard)
async function requireSecret(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret && secret === process.env.ADMIN_SECRET) {
    req.reviewerEmail = process.env.ADMIN_EMAIL || 'hello@founderssprint.co';
    req.reviewerName  = 'Teddy Ruge';
    return next();
  }

  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return res.status(403).json({ error: 'Invalid token' });
      req.reviewerEmail = user.email;
      req.reviewerName  = user.user_metadata?.full_name || user.email;
      return next();
    } catch {
      return res.status(403).json({ error: 'Token verification failed' });
    }
  }

  return res.status(403).json({ error: 'Forbidden' });
}

// ── Helper: parse array fields from form data ──────────────────────────────
function parseArrayField(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return [val]; }
}

// ── POST /api/coach-application — submit new application ───────────────────
router.post('/coach-application', fileFields, async (req, res) => {
  try {
    const b = req.body;

    // Generate a temp ID for file paths
    const tempId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    // Upload files to Supabase Storage
    let profilePhotoPath = null;
    let cvPath = null;
    let idDocPath = null;

    if (req.files?.profile_photo?.[0]) {
      const f = req.files.profile_photo[0];
      const ext = f.originalname.split('.').pop();
      profilePhotoPath = await uploadCoachFile(
        'coach-profiles', `${tempId}/photo.${ext}`, f.buffer, f.mimetype
      );
    }

    if (req.files?.cv_file?.[0]) {
      const f = req.files.cv_file[0];
      cvPath = await uploadCoachFile(
        'coach-documents', `${tempId}/cv.pdf`, f.buffer, f.mimetype
      );
    }

    if (req.files?.id_document?.[0]) {
      const f = req.files.id_document[0];
      const ext = f.originalname.split('.').pop();
      idDocPath = await uploadCoachFile(
        'coach-documents', `${tempId}/id-document.${ext}`, f.buffer, f.mimetype
      );
    }

    // Build application record
    const application = await createCoachApplication({
      first_name:     b.first_name,
      last_name:      b.last_name,
      email:          b.email,
      country_code:   b.country_code || '+256',
      phone:          b.phone,

      taxonomy_l1:    b.taxonomy_l1,
      taxonomy_l2:    parseArrayField(b.taxonomy_l2),
      taxonomy_l3:    parseArrayField(b.taxonomy_l3),
      assigned_day:   b.assigned_day,

      profile_photo_path: profilePhotoPath,
      headline:       b.headline,
      bio:            b.bio,
      geographies:    b.geographies,
      linkedin_url:   b.linkedin_url,
      twitter_url:    b.twitter_url,
      instagram_url:  b.instagram_url,
      website_url:    b.website_url,

      current_role:   b.current_role,
      experience:     b.experience,
      notable_clients: b.notable_clients,
      cv_path:        cvPath,

      session_types:  parseArrayField(b.session_types),
      time_slots:     parseArrayField(b.time_slots),
      has_existing_materials: b.has_existing_materials,
      coaching_philosophy:    b.coaching_philosophy,

      mobile_money_provider: b.mobile_money_provider,
      mobile_money_number:   b.mobile_money_number,
      bank_name:      b.bank_name,
      bank_branch:    b.bank_branch,
      account_name:   b.account_name,
      account_number: b.account_number,
      swift_code:     b.swift_code,
      tax_status:     b.tax_status,
      company_name:   b.company_name,

      id_type:        b.id_type,
      id_document_path: idDocPath,
      tin:            b.tin,

      agree_terms:    parseArrayField(b.agree_terms),
    });

    // Send confirmation email to applicant
    try {
      await sendCoachConfirmation(application);
    } catch (emailErr) {
      console.error('[Email] Coach confirmation failed:', emailErr.message);
    }

    // Notify admin
    try {
      await sendCoachAdminNotification(application);
    } catch (emailErr) {
      console.error('[Email] Admin notification failed:', emailErr.message);
    }

    res.status(201).json({ ok: true, id: application.id });
  } catch (err) {
    console.error('[Coach Application] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/coach-applications — list all (admin) ───────────────────
router.get('/admin/coach-applications', requireSecret, async (req, res) => {
  try {
    const status = req.query.status || null;
    const apps = await getCoachApplications({ status });
    // Include votes for each application so dashboard can show approval progress
    const appsWithVotes = await Promise.all(apps.map(async (app) => {
      const votes = await getApprovalVotes(app.id);
      return { ...app, votes };
    }));
    // Also return the current reviewer's email so the UI knows who's logged in
    res.json({ applications: appsWithVotes, reviewerEmail: req.reviewerEmail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/coach-applications/:id — single application detail ──────
router.get('/admin/coach-applications/:id', requireSecret, async (req, res) => {
  try {
    const app = await getCoachApplication(req.params.id);
    if (!app) return res.status(404).json({ error: 'Not found' });
    // Include votes for the approval UI
    const votes = await getApprovalVotes(app.id);
    res.json({ ...app, votes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/coach-applications/:id/votes — list votes for an app ───
router.get('/admin/coach-applications/:id/votes', requireSecret, async (req, res) => {
  try {
    const votes = await getApprovalVotes(req.params.id);
    res.json(votes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/coach-applications/:id/vote — cast approve or reject ──
// Body: { vote: 'approve'|'reject', reason?: string, notes?: string }
// Multi-coach approval: requires ALL coaches (except applicant) to approve.
// A single rejection immediately rejects the application.
router.post('/admin/coach-applications/:id/vote', requireSecret, async (req, res) => {
  try {
    const app = await getCoachApplication(req.params.id);
    if (!app) return res.status(404).json({ error: 'Not found' });
    if (app.status !== 'pending') {
      return res.status(400).json({ error: 'Application already ' + app.status });
    }

    const { vote, reason, notes } = req.body;
    if (!vote || !['approve', 'reject'].includes(vote)) {
      return res.status(400).json({ error: 'vote must be "approve" or "reject"' });
    }

    // Can't vote on your own application
    if (req.reviewerEmail.toLowerCase() === app.email.toLowerCase()) {
      return res.status(403).json({ error: 'You cannot vote on your own application' });
    }

    // Record the vote
    await createApprovalVote({
      applicationId:   app.id,
      reviewerEmail:   req.reviewerEmail,
      reviewerName:    req.reviewerName,
      vote,
      rejectionReason: vote === 'reject' ? (reason || null) : null,
      notes:           notes || null,
    });

    // Tally all votes for this application
    const allVotes = await getApprovalVotes(app.id);
    const approvals  = allVotes.filter(v => v.vote === 'approve').length;
    const rejections = allVotes.filter(v => v.vote === 'reject').length;
    const required   = app.required_approvals || 4;

    // Update vote counts on the application
    await updateCoachApplication(app.id, {
      approval_votes:  approvals,
      rejection_votes: rejections,
    });

    // If any rejection → immediately reject the application
    if (rejections > 0) {
      const rejectReasons = allVotes
        .filter(v => v.vote === 'reject' && v.rejection_reason)
        .map(v => `${v.reviewer_name}: ${v.rejection_reason}`)
        .join('\n');

      await updateCoachApplication(app.id, {
        status:           'rejected',
        reviewed_by:      allVotes.map(v => v.reviewer_name).join(', '),
        reviewed_at:      new Date().toISOString(),
        rejection_reason: rejectReasons || 'Rejected by peer review',
        admin_notes:      notes || null,
      });

      // Send rejection email
      try {
        await sendCoachRejection(app, rejectReasons || 'After peer review by the coaching team.');
      } catch (emailErr) {
        console.error('[Email] Coach rejection email failed:', emailErr.message);
      }

      return res.json({ ok: true, status: 'rejected', approvals, rejections, required });
    }

    // If all required approvals met → approve
    if (approvals >= required) {
      await updateCoachApplication(app.id, {
        status:      'approved',
        reviewed_by: allVotes.map(v => v.reviewer_name).join(', '),
        reviewed_at: new Date().toISOString(),
        admin_notes: notes || null,
      });

      // Create coach record
      const coach = await createCoachFromApplication(app);

      // Create Supabase auth account + seed user_roles
      let authResult = null;
      try {
        authResult = await createCoachAuthAccount(app, coach.id);
        console.log('[Auth] Coach auth account created for', app.email, '— user_id:', authResult.userId);
      } catch (authErr) {
        // Non-fatal: coach record exists, auth can be retried manually
        console.error('[Auth] Coach auth account creation failed (non-fatal):', authErr.message);
      }

      // Send approval email (with login credentials if auth succeeded)
      try {
        const loginUrl = (process.env.CURRICULUM_URL || 'https://learn.founderssprint.co') + '/login?redirect=/coach/dashboard';
        await sendCoachApproval(app, {
          tempPassword: authResult?.tempPassword || null,
          loginUrl,
        });
      } catch (emailErr) {
        console.error('[Email] Coach approval email failed:', emailErr.message);
      }

      return res.json({ ok: true, status: 'approved', coach_id: coach.id, user_id: authResult?.userId || null, approvals, rejections, required });
    }

    // Still pending — need more votes
    res.json({ ok: true, status: 'pending', approvals, rejections, required });
  } catch (err) {
    console.error('[Coach Vote] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Legacy endpoints — redirect to vote system ────────────────────────────
router.post('/admin/coach-applications/:id/approve', requireSecret, async (req, res) => {
  req.body.vote = 'approve';
  req.body.notes = req.body.notes || null;
  req.url = req.url.replace('/approve', '/vote');
  router.handle(req, res);
});

router.post('/admin/coach-applications/:id/reject', requireSecret, async (req, res) => {
  req.body.vote = 'reject';
  req.body.notes = req.body.notes || null;
  req.url = req.url.replace('/reject', '/vote');
  router.handle(req, res);
});

module.exports = router;
