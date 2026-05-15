const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Track definitions — deposit is always 10% of full fee ─────────────────────
const TRACKS = {
  group:    { label: 'Group Sprint',     fullFee:  500000 },
  oneOnOne: { label: '1-on-1 Intensive', fullFee: 1500000 },
  vip:      { label: 'VIP All-Access',   fullFee: 5000000 },
};

// Column name for each track's counter
const TRACK_FIELD = {
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
async function createRegistration({ cohortId, track, firstName, lastName, email, phone, company, sector, timeslot }) {
  const t = TRACKS[track];
  if (!t) throw new Error(`Unknown track: ${track}`);

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
      full_fee:       t.fullFee,
      deposit_amount: Math.round(t.fullFee * 0.10),
      balance_amount: t.fullFee - Math.round(t.fullFee * 0.10),
    })
    .select()
    .single();
  if (error) throw error;

  // Increment the track counter on the cohort
  await supabase.rpc('increment_cohort_count', {
    p_cohort_id: cohortId,
    p_field:     TRACK_FIELD[track],
  });

  return data;
}

async function getRegistration(id) {
  const { data, error } = await supabase
    .from('registrations')
    .select('*, cohort:cohorts(*)')
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
    .select('*, cohort:cohorts(*)')
    .single();
  if (error) throw error;
  return data;
}

async function markFullyPaid(registrationId) {
  const { data, error } = await supabase
    .from('registrations')
    .update({ balance_paid: true })
    .eq('id', registrationId)
    .select('*, cohort:cohorts(*)')
    .single();
  if (error) throw error;
  return data;
}

// ── Scheduler helpers ─────────────────────────────────────────────────────────

/** Registrations with deposit paid, balance unpaid, not forfeited — for reminders */
async function getDepositPaidUnpaidBalance(cohortId) {
  const { data, error } = await supabase
    .from('registrations')
    .select('*, cohort:cohorts(*)')
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
    .select('*, cohort:cohorts(*)')
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
