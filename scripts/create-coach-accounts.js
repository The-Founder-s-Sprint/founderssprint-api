#!/usr/bin/env node
/**
 * create-coach-accounts.js
 *
 * One-time script to create Supabase Auth accounts for the founding coaches
 * so they can log into the admin dashboard and review coach applications.
 *
 * Usage:
 *   node scripts/create-coach-accounts.js
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in environment
 * (load via .env or export before running).
 *
 * Each coach gets a temporary password. On first login the dashboard will
 * work immediately. Coaches should reset their password via the Supabase
 * password reset flow (or you can trigger it from the admin endpoint).
 */

// Load .env if available (install dotenv locally, or export env vars before running)
try { require('dotenv').config(); } catch { /* dotenv not installed — using exported env vars */ }
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Founding coaches ─────────────────────────────────────────────────────────
// Teddy already has an account. These are the other four founding coaches.
const COACHES = [
  {
    email: 'bwojega@hivecolab.com',
    full_name: 'Barry Wojega',
    role: 'Financial Modelling & Business Finance',
  },
  {
    email: 'mengwau@gmail.com',
    full_name: 'Moses Engwau Okudu',
    role: 'Strategy & Team Building',
  },
  {
    email: 'joe.kalema@gmail.com',
    full_name: 'Joseph Kalema',
    role: 'Investment Readiness & Fundraising',
  },
  {
    email: 'patrick.ngolobe@aels.co.ug',
    full_name: 'Patrick Ngolobe',
    role: 'Product Development & Pricing',
  },
];

// Generate a random temporary password (16 chars)
function tempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  let pw = '';
  for (let i = 0; i < 16; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

async function main() {
  console.log('Creating Supabase Auth accounts for founding coaches…\n');

  for (const coach of COACHES) {
    const password = tempPassword();

    const { data, error } = await supabase.auth.admin.createUser({
      email: coach.email,
      password,
      email_confirm: true, // auto-confirm so they can log in immediately
      user_metadata: {
        full_name: coach.full_name,
        role: coach.role,
        founding_coach: true,
      },
    });

    if (error) {
      if (error.message.includes('already been registered') || error.message.includes('already exists')) {
        console.log(`  ✓ ${coach.full_name} (${coach.email}) — account already exists, skipping`);
      } else {
        console.error(`  ✗ ${coach.full_name} (${coach.email}) — ERROR: ${error.message}`);
      }
      continue;
    }

    console.log(`  ✓ ${coach.full_name} (${coach.email})`);
    console.log(`    User ID:  ${data.user.id}`);
    console.log(`    Temp PW:  ${password}`);
    console.log(`    → Share this password securely (WhatsApp DM). Coach should change it on first login.\n`);
  }

  console.log('\nDone. Coaches can now sign in at the dashboard with their email + temporary password.');
  console.log('To trigger a password reset email, use: POST /api/admin/reset-password { email }');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
