const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Track pricing — loaded from DB, with hardcoded fallback ───────────────────
const TRACKS_FALLBACK = {
  single:  { label: '1-on-1 Session',  fullFee:  500000,  depositPct: 10 },
  pick3:   { label: 'Pick 3 Bundle',   fullFee: 1000000, depositPct: 10 },
  cohort:  { label: 'Full Cohort',     fullFee: 2500000, depositPct: 10 },
  vip1on1: { label: 'VIP 1-on-1',      fullFee: 5000000, depositPct: 10 },
};

let _tracksCache = null;
let _tracksCacheTime = 0;
const TRACKS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getTrackPricing() {
  // Return cached if fresh
  if (_tracksCache && (Date.now() - _tracksCacheTime < TRACKS_CACHE_TTL)) {
    return _tracksCache;
  }
  try {
    const { data, error } = await supabase
      .from('track_pricing')
      .select('track_key, label, full_fee, deposit_pct, is_active')
      .eq('is_active', true)
      .order('sort_order');

    if (error) throw error;
    const tracks = {};
    for (const row of (data || [])) {
      tracks[row.track_key] = {
        label:      row.label,
        fullFee:    row.full_fee,
        depositPct: row.deposit_pct,
      };
    }
    _tracksCache = Object.keys(tracks).length ? tracks : TRACKS_FALLBACK;
    _tracksCacheTime = Date.now();
    return _tracksCache;
  } catch (err) {
    console.error('[DB] Failed to load track pricing, using fallback:', err.message);
    return TRACKS_FALLBACK;
  }
}

// Synchronous accessor for backward compatibility (uses cache or fallback)
const TRACKS = new Proxy(TRACKS_FALLBACK, {
  get(target, prop) {
    if (_tracksCache && _tracksCache[prop]) return _tracksCache[prop];
    return target[prop];
  },
  has(target, prop) {
    if (_tracksCache) return prop in _tracksCache;
    return prop in target;
  },
});

// Column name for each track's counter
const TRACK_FIELD = {
  single:  'single_taken',
  pick3:   'pick3_taken',
  cohort:  'cohort_taken',
  vip1on1: 'vip1on1_taken',
  // Legacy keys (old registrations still reference these)
  group:    'group_taken',
  oneOnOne: 'one_on_one_taken',
  vip:      'vip_taken',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function daysUntil(dateStr) {
  const target = new Date(dateStr + 'T00:00:00Z');
  const now    = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return Math.round((target - now) / 86400000);
}

// ── Cohorts ───────────────────────────────────────────────────────────────────
async function getOpenCohorts() {
  const { data, error } = await supabase
    .from('cohorts')
    .select('*')
    .eq('status', 'open')
    .order('id');
  if (error) throw error;
  return data || [];
}

async function getCohort(id) {
  const { data, error } = await supabase
    .from('cohorts')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function getNextOpenCohort(currentCohortId) {
  const { data, error } = await supabase
    .from('cohorts')
    .select('*')
    .eq('status', 'open')
    .gt('id', currentCohortId)
    .order('id')
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

// ── Registrations ─────────────────────────────────────────────────────────────
// Canonical discipline keys used across the platform (founder dashboard, course progress, enrollment).
const DISCIPLINE_KEYS = ['marketing','financial','investment','strategy','product'];
function normalizeDisciplines(track, disciplines) {
  // Cohort/group = all five; otherwise use what was selected (normalising the legacy 'finance' key).
  if (track === 'cohort' || track === 'group') return DISCIPLINE_KEYS.slice();
  if (!Array.isArray(disciplines)) return [];
  return disciplines
    .map(d => (d === 'finance' ? 'financial' : d))
    .filter(d => DISCIPLINE_KEYS.includes(d));
}

async function createRegistration({ cohortId, track, firstName, lastName, email, phone, company, sector, timeslot, disciplines }) {
  const tracks = await getTrackPricing();
  const t = tracks[track];
  if (!t) throw new Error(`Unknown track: ${track}`);

  const depositPct = t.depositPct || 10;
  const depositAmt = Math.round(t.fullFee * depositPct / 100);
  const balanceAmt = t.fullFee - depositAmt;

  const { data, error } = await supabase
    .from('registrations')
    .insert({
      cohort_id:      cohortId,
      track,
      first_name:     firstName,
      last_name:      lastName,
      email:          email.toLowerCase().trim(),
      phone:          phone    || null,
      company:        company  || null,
      sector:         sector   || null,
      timeslot:       timeslot || null,
      disciplines:    normalizeDisciplines(track, disciplines),
      full_fee:       t.fullFee,
      deposit_amount: depositAmt,
      balance_amount: balanceAmt,
    })
    .select()
    .single();
  if (error) throw error;

  // Increment the track counter on the cohort (skip for VIP — not cohort-bound)
  if (cohortId) {
    await supabase.rpc('increment_cohort_count', {
      p_cohort_id: cohortId,
      p_field:     TRACK_FIELD[track],
    });
  }

  return data;
}

async function getRegistration(id) {
  const { data, error } = await supabase
    .from('registrations')
    .select('*, cohort:cohorts!registrations_cohort_id_fkey(*)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function getRegistrationsForCohort(cohortId) {
  const { data, error } = await supabase
    .from('registrations')
    .select('*')
    .eq('cohort_id', cohortId)
    .eq('forfeited', false)
    .order('created_at');
  if (error) throw error;
  return data || [];
}

async function markDepositPaid(registrationId, adminNote) {
  const { data, error } = await supabase
    .from('registrations')
    .update({ deposit_paid: true, admin_note: adminNote || null })
    .eq('id', registrationId)
    .select('*, cohort:cohorts!registrations_cohort_id_fkey(*)')
    .single();
  if (error) throw error;
  return data;
}

async function markFullyPaid(registrationId) {
  const { data, error } = await supabase
    .from('registrations')
    .update({ balance_paid: true })
    .eq('id', registrationId)
    .select('*, cohort:cohorts!registrations_cohort_id_fkey(*)')
    .single();
  if (error) throw error;
  return data;
}

// ── Scheduler helpers ─────────────────────────────────────────────────────────

/** Registrations with deposit paid, balance unpaid, not forfeited — for reminders */
async function getDepositPaidUnpaidBalance(cohortId) {
  const { data, error } = await supabase
    .from('registrations')
    .select('*, cohort:cohorts!registrations_cohort_id_fkey(*)')
    .eq('cohort_id', cohortId)
    .eq('deposit_paid', true)
    .eq('balance_paid', false)
    .eq('forfeited', false);
  if (error) throw error;
  return data || [];
}

/** Registrations with deposit NOT paid, not yet forfeited (for auto-move at T-48h) */
async function getUnpaidDepositForCohort(cohortId) {
  const { data, error } = await supabase
    .from('registrations')
    .select('*, cohort:cohorts!registrations_cohort_id_fkey(*)')
    .eq('cohort_id', cohortId)
    .eq('deposit_paid', false)
    .eq('forfeited', false);
  if (error) throw error;
  return data || [];
}

/** Move a registration to another cohort */
async function moveRegistration(registrationId, newCohortId) {
  // Get the registration first so we can update cohort counters
  const { data: reg, error: fetchErr } = await supabase
    .from('registrations')
    .select('cohort_id, track')
    .eq('id', registrationId)
    .single();
  if (fetchErr) throw fetchErr;

  const { error } = await supabase
    .from('registrations')
    .update({ cohort_id: newCohortId, moved_to_cohort: newCohortId })
    .eq('id', registrationId);
  if (error) throw error;

  // Keep counters in sync
  const field = TRACK_FIELD[reg.track] || 'group_taken';
  await supabase.rpc('decrement_cohort_count', { p_cohort_id: reg.cohort_id, p_field: field });
  await supabase.rpc('increment_cohort_count', { p_cohort_id: newCohortId,    p_field: field });
}

/** Forfeit a registration (no-show / no deposit) */
async function forfeitRegistration(registrationId) {
  const { data: reg, error: fetchErr } = await supabase
    .from('registrations')
    .select('cohort_id, track')
    .eq('id', registrationId)
    .single();
  if (fetchErr) throw fetchErr;

  const { error } = await supabase
    .from('registrations')
    .update({ forfeited: true })
    .eq('id', registrationId);
  if (error) throw error;

  // Free up the slot
  const field = TRACK_FIELD[reg.track] || 'group_taken';
  await supabase.rpc('decrement_cohort_count', { p_cohort_id: reg.cohort_id, p_field: field });
}

// ── Email log ─────────────────────────────────────────────────────────────────
async function logEmail(registrationId, emailType, success = true, errorMessage = null) {
  const { error } = await supabase
    .from('email_log')
    .insert({
      registration_id: registrationId,
      email_type:      emailType,
      success,
      error_message:   errorMessage,
    });
  if (error) console.error('[DB] Failed to log email:', error.message);
}

// ── Coaches ──────────────────────────────────────────────────────────────────
async function getCoaches({ role } = {}) {
  let query = supabase
    .from('coaches')
    .select('id, first_name, last_name, email, phone, sector_l1, role, status, founderssprint_email')
    .eq('status', 'active')
    .order('id');
  if (role) query = query.eq('role', role);
  const { data, error } = await query;
  if (error) throw new Error('[DB] getCoaches: ' + error.message);
  return data || [];
}

// ── Coach Applications ──────────────────────────────────────────────────────
async function createCoachApplication(data) {
  const { data: app, error } = await supabase
    .from('coach_applications')
    .insert(data)
    .select()
    .single();
  if (error) throw new Error('[DB] createCoachApplication: ' + error.message);
  return app;
}

async function getCoachApplications({ status } = {}) {
  let query = supabase
    .from('coach_applications')
    .select('*')
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new Error('[DB] getCoachApplications: ' + error.message);
  return data || [];
}

async function getCoachApplication(id) {
  const { data, error } = await supabase
    .from('coach_applications')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw new Error('[DB] getCoachApplication: ' + error.message);
  return data;
}

async function updateCoachApplication(id, updates) {
  const { data, error } = await supabase
    .from('coach_applications')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error('[DB] updateCoachApplication: ' + error.message);
  return data;
}

async function createCoachFromApplication(app) {
  const { data: coach, error } = await supabase
    .from('coaches')
    .insert({
      first_name:    app.first_name,
      last_name:     app.last_name,
      email:         app.email,
      phone:         app.phone ? (app.country_code || '+256') + ' ' + app.phone : null,
      sector_l1:     app.taxonomy_l1,
      role:          'coach',
      status:        'active',
      headline:      app.headline,
      bio:           app.bio,
      linkedin_url:  app.linkedin_url,
      twitter_url:   app.twitter_url,
      instagram_url: app.instagram_url,
      website_url:   app.website_url,
      profile_photo_url: app.profile_photo_path,
      taxonomy_l2:   app.taxonomy_l2,
      taxonomy_l3:   app.taxonomy_l3,
      assigned_day:  app.assigned_day,
      session_types: app.session_types,
      time_slots:    app.time_slots,
      application_id: app.id,
    })
    .select()
    .single();
  if (error) throw new Error('[DB] createCoachFromApplication: ' + error.message);
  return coach;
}

// ── Coach auth account creation (on approval) ────────────────────────────────
async function createCoachAuthAccount(application, coachId) {
  const tempPassword = crypto.randomBytes(12).toString('base64url').slice(0, 16);

  // 1. Create Supabase auth account
  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email: application.email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: {
      full_name: `${application.first_name} ${application.last_name}`,
      role: 'coach',
      coach_id: coachId,
    },
  });
  if (authError) throw new Error('[Auth] createCoachAuthAccount: ' + authError.message);

  const userId = authUser.user.id;

  // 2. Seed user_roles table
  const { error: roleError } = await supabase
    .from('user_roles')
    .insert({
      user_id: userId,
      role: 'coach',
      email: application.email,
    });
  if (roleError) throw new Error('[DB] seed user_roles: ' + roleError.message);

  // 3. Link auth user ID back to coaches table
  const { error: linkError } = await supabase
    .from('coaches')
    .update({ user_id: userId })
    .eq('id', coachId);
  if (linkError) console.error('[DB] link coach user_id (non-fatal):', linkError.message);

  return { userId, tempPassword };
}

// ── Coach approval votes ───────────────────────────────────────────────────
async function createApprovalVote({ applicationId, reviewerEmail, reviewerName, vote, rejectionReason, notes }) {
  const { data, error } = await supabase
    .from('coach_approval_votes')
    .upsert({
      application_id:   applicationId,
      reviewer_email:   reviewerEmail,
      reviewer_name:    reviewerName || reviewerEmail,
      vote,
      rejection_reason: rejectionReason || null,
      notes:            notes || null,
    }, { onConflict: 'application_id,reviewer_email' })
    .select()
    .single();
  if (error) throw new Error('[DB] createApprovalVote: ' + error.message);
  return data;
}

async function getApprovalVotes(applicationId) {
  const { data, error } = await supabase
    .from('coach_approval_votes')
    .select('*')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: true });
  if (error) throw new Error('[DB] getApprovalVotes: ' + error.message);
  return data || [];
}

// ── Supabase Storage helpers ────────────────────────────────────────────────
async function uploadCoachFile(bucket, filePath, buffer, contentType) {
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(filePath, buffer, { contentType, upsert: true });
  if (error) throw new Error('[Storage] upload: ' + error.message);
  return data.path;
}

module.exports = {
  supabase,
  TRACKS,
  getTrackPricing,
  daysUntil,
  getOpenCohorts,
  getCohort,
  getNextOpenCohort,
  createRegistration,
  getRegistration,
  getRegistrationsForCohort,
  markDepositPaid,
  markFullyPaid,
  getDepositPaidUnpaidBalance,
  getUnpaidDepositForCohort,
  moveRegistration,
  forfeitRegistration,
  logEmail,
  getCoaches,
  createCoachApplication,
  getCoachApplications,
  getCoachApplication,
  updateCoachApplication,
  createCoachFromApplication,
  createCoachAuthAccount,
  createApprovalVote,
  getApprovalVotes,
  uploadCoachFile,
};
