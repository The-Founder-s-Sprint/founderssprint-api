/**
 * GET /api/cron/send-reminders
 * Called daily by Vercel Cron. Sends balance-due reminders:
 *   - 7 days before cohort start → to founders with deposit paid but balance unpaid
 *   - 48 hours before cohort start → same condition (urgent)
 */
const { createClient } = require('@supabase/supabase-js');
const { sendBalanceDueReminder } = require('../lib/emailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  // Secure the cron endpoint — Vercel passes this header, or we use a secret
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today     = new Date();
  const in7days   = new Date(today); in7days.setDate(today.getDate() + 7);
  const in2days   = new Date(today); in2days.setDate(today.getDate() + 2);

  const toISO = (d) => d.toISOString().slice(0, 10);

  // Fetch cohorts starting in exactly 7 days or 2 days
  const { data: cohorts } = await supabase
    .from('cohorts')
    .select('*')
    .in('start_date', [toISO(in7days), toISO(in2days)]);

  if (!cohorts || cohorts.length === 0) {
    return res.json({ ok: true, sent: 0, message: 'No cohorts due for reminders today' });
  }

  let sent = 0;
  const errors = [];

  for (const cohort of cohorts) {
    const daysUntil = cohort.start_date === toISO(in2days) ? 2 : 7;

    // Fetch registrations: deposit paid, balance NOT paid, not forfeited
    const { data: regs } = await supabase
      .from('registrations')
      .select('*')
      .eq('cohort_id', cohort.id)
      .eq('deposit_paid', true)
      .eq('balance_paid', false)
      .eq('forfeited', false);

    if (!regs || regs.length === 0) continue;

    for (const reg of regs) {
      try {
        await sendBalanceDueReminder(reg, cohort, daysUntil);
        sent++;
      } catch (err) {
        errors.push(`reg#${reg.id}: ${err.message}`);
      }
    }
  }

  console.log(`[send-reminders] Sent ${sent} reminders. Errors: ${errors.length}`);
  return res.json({ ok: true, sent, errors });
};
