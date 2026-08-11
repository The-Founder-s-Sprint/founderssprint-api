const { Resend }  = require('resend');
const fs          = require('fs');
const path        = require('path');
const { logEmail } = require('./db');

// Transactional email via Resend. Free tier (3k/mo) covers ITM volume; the sender
// domain (founderssprint.co) must be verified in Resend for `hello@founderssprint.co`.
const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_EMAIL    = process.env.FROM_EMAIL    || 'hello@founderssprint.co';
const FROM_NAME     = process.env.FROM_NAME     || "The Founder's Sprint";
const ADMIN_EMAIL   = process.env.ADMIN_EMAIL   || 'hello@founderssprint.co';
const AIRTEL_NUMBER = () => process.env.AIRTEL_NUMBER || '0752-XXXXXX';

// ── Template loader ───────────────────────────────────────────────────────────
function loadTemplate(name, vars = {}) {
  const file = path.join(__dirname, '..', 'templates', `${name}.html`);
  let html = fs.readFileSync(file, 'utf8');
  for (const [key, val] of Object.entries(vars)) {
    html = html.replaceAll(`{{${key}}}`, val ?? '');
  }
  return html;
}

function fmt(n) {
  return 'UGX ' + Number(n).toLocaleString('en-UG');
}

// ── Balance due date: 48h before cohort start ─────────────────────────────────
function fmtBalanceDueDate(startDate) {
  if (!startDate) return '48 hours before Day 1';
  try {
    const d = new Date(startDate + 'T00:00:00');
    d.setDate(d.getDate() - 2);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return '48 hours before Day 1';
  }
}

// ── Calendar invite (.ics) attachment ─────────────────────────────────────────
function generateICS(cohort, reg) {
  if (!cohort.start_date || !cohort.end_date) return null;
  try {
    const dtStart = cohort.start_date.replace(/-/g, '');
    const endD    = new Date(cohort.end_date + 'T00:00:00');
    endD.setDate(endD.getDate() + 1);
    const dtEnd   = endD.toISOString().slice(0, 10).replace(/-/g, '');

    const trackLabel = reg.track === 'vip' ? 'VIP All-Access'
                     : reg.track === 'oneOnOne' ? '1-on-1 Coaching' : 'Group Mentoring';
    const uid  = `founders-sprint-${reg.id}@tmsruge.com`;
    const now  = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      "PRODID:-//The Founder's Sprint//EN",
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${dtStart}`,
      `DTEND;VALUE=DATE:${dtEnd}`,
      `SUMMARY:The Founder's Sprint — ${cohort.name} (${trackLabel})`,
      `DESCRIPTION:Your 5-week coaching programme with TMS Ruge.\\n` +
        `Deposit & payment instructions are in your confirmation email.\\n` +
        `Questions? Email hello@founderssprint.co`,
      'LOCATION:Kampala\\, Uganda',
      `ORGANIZER;CN=TMS Ruge:mailto:${FROM_EMAIL}`,
      `ATTENDEE;ROLE=REQ-PARTICIPANT;CN=${reg.first_name} ${reg.last_name}:mailto:${reg.email}`,
      // 48-hour reminder
      'BEGIN:VALARM',
      'TRIGGER:-P2D',
      'ACTION:DISPLAY',
      "DESCRIPTION:The Founder's Sprint starts in 48 hours — balance payment due today!",
      'END:VALARM',
      // 4-hour reminder
      'BEGIN:VALARM',
      'TRIGGER:-PT4H',
      'ACTION:DISPLAY',
      "DESCRIPTION:The Founder's Sprint starts in 4 hours — see you soon!",
      'END:VALARM',
      // 15-minute reminder
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      "DESCRIPTION:The Founder's Sprint starts in 15 minutes — join the session now!",
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    return {
      type:    'text/calendar; method=REQUEST',
      name:    `founders-sprint-${cohort.name.toLowerCase().replace(/\s+/g, '-')}.ics`,
      content: Buffer.from(ics).toString('base64'),
    };
  } catch (err) {
    console.error('[Email] ICS generation failed:', err.message);
    return null;
  }
}

// ── Core send ─────────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html, registrationId = null, template, attachments = [] }) {
  try {
    const payload = {
      from:    `${FROM_NAME} <${FROM_EMAIL}>`,
      to:      [to],
      subject,
      html,
    };
    // Map our internal attachment shape ({type,name,base64 content}) → Resend's.
    if (attachments && attachments.length > 0) {
      payload.attachments = attachments.map(a => ({
        filename:     a.filename || a.name,
        content:      Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content, 'base64'),
        content_type: a.content_type || a.type,
      }));
    }

    const { data, error } = await resend.emails.send(payload);
    const ok = !error && !!(data && data.id);
    const errMsg = ok ? null : JSON.stringify(error || 'Resend returned no message id');
    await logEmail(registrationId, template, ok, errMsg);
    if (!ok) console.error(`[Email] Resend rejected "${template}" to ${to}:`, error);
    return { ok, id: data?.id };
  } catch (err) {
    await logEmail(registrationId, template, false, err.message);
    console.error(`[Email] Failed to send "${template}" to ${to}:`, err.message);
    return { ok: false, error: err.message };
  }
}

// ── Safe template wrapper — ensures template errors go to email_log ───────────
async function sendWithTemplate(templateName, vars, sendOpts) {
  let html;
  try {
    html = loadTemplate(templateName, vars);
  } catch (err) {
    const errMsg = `Template load error [${templateName}]: ${err.message}`;
    console.error('[Email]', errMsg);
    await logEmail(sendOpts.registrationId ?? null, templateName, false, errMsg);
    return { ok: false, error: errMsg };
  }
  return sendEmail({ ...sendOpts, html, template: templateName });
}

// ── Confirmation (registrant) ─────────────────────────────────────────────────
async function sendConfirmation(reg, cohort) {
  const isVip          = reg.track === 'vip' || reg.track === 'vip1on1';
  const templateName   = isVip ? 'confirmation_vip' : 'confirmation';
  const balanceDueDate = cohort ? fmtBalanceDueDate(cohort.start_date) : 'To be scheduled';
  const icsAttachment  = cohort ? generateICS(cohort, reg) : null;

  const cohortName  = cohort ? cohort.name : 'VIP 1-on-1';
  const cohortDates = cohort ? (cohort.dates || `${cohort.start_date} – ${cohort.end_date}`) : 'Scheduling follows after deposit';

  return sendWithTemplate(templateName, {
    FIRST_NAME:       reg.first_name,
    COHORT_NAME:      cohortName,
    COHORT_DATES:     cohortDates,
    FULL_FEE:         fmt(reg.full_fee),
    DEPOSIT:          fmt(reg.deposit_amount),
    BALANCE:          fmt(reg.balance_amount),
    BALANCE_DUE_DATE: balanceDueDate,
    AIRTEL_NUMBER:    AIRTEL_NUMBER(),
    ADMIN_EMAIL,
    TRACK:            isVip ? 'VIP 1-on-1' : (reg.track === 'oneOnOne' ? '1-on-1 Coaching' : 'Group'),
    INTAKE_FORM_URL:  process.env.VIP_INTAKE_FORM_URL || 'https://founderssprint.co/vip-intake',
  }, {
    to:             reg.email,
    subject:        isVip
      ? `Your VIP spot is reserved · The Founder's Sprint`
      : `You're registered · ${cohortName} · The Founder's Sprint`,
    registrationId: reg.id,
    attachments:    icsAttachment ? [icsAttachment] : [],
  });
}

// ── Preview-launch reservation (payments not live yet — no deposit instructions) ─
// Sent instead of sendConfirmation when a booking is saved as interest. Confirms the
// place is held on the founder's account and sets the expectation: no charge today,
// we'll email them to pay their 10% deposit the moment booking opens.
async function sendReservationConfirmation(reg, cohort) {
  const trackLabel = { group: 'Group', oneOnOne: '1-on-1', vip: 'VIP Leadership', vip1on1: 'VIP Leadership', single: '1-on-1 Session', pick3: 'Pick 3 Bundle', cohort: 'Full Cohort' }[reg.track] || reg.track;
  const cohortLine = cohort ? `<p style="margin:0 0 14px">Cohort: <strong>${cohort.name}</strong> · ${cohort.dates || `${cohort.start_date} – ${cohort.end_date}`}</p>` : '';
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>body{margin:0;background:#0f0d0a;font-family:Arial,Helvetica,sans-serif}
  .wrap{max-width:600px;margin:0 auto;background:#171310;color:#efe7d8}
  .header{padding:34px 40px 24px;border-bottom:1px solid rgba(201,146,58,0.3);text-align:center}
  .header h1{color:#fff;font-size:22px;margin:0}.header p{color:#b9a98f;font-size:13px;margin:8px 0 0}
  .body{padding:32px 40px}
  p{margin:0 0 14px;font-size:15px;line-height:1.7;color:#e7ddca}
  .card{background:#1f1a15;border:1px solid rgba(201,146,58,0.28);border-radius:0 0 16px 0;padding:18px 22px;margin:20px 0}
  .card .k{color:#b9a98f;font-size:12px;letter-spacing:.06em;text-transform:uppercase}
  .card .v{color:#fff;font-size:16px;font-weight:600;margin-top:2px}
  .tag{display:inline-block;background:rgba(201,146,58,0.16);color:#E8A94B;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:6px 12px;border-radius:4px}
  .footer{padding:20px 40px;border-top:1px solid rgba(201,146,58,0.2);text-align:center}
  .footer p{color:#b9a98f;font-size:12px;margin:4px 0}</style></head><body><div class="wrap">
  <div class="header"><h1>Your place is reserved</h1><p>The Founder's Sprint</p></div>
  <div class="body">
    <p>Hi ${reg.first_name},</p>
    <p><span class="tag">Booking opens soon</span></p>
    <p>Thanks for reserving your <strong>${trackLabel}</strong> place — it's now saved to your account. <strong>You haven't been charged anything today.</strong></p>
    <div class="card"><div class="k">Your booking</div><div class="v">${trackLabel} · Booking #${reg.id}</div></div>
    ${cohortLine}
    <p>We're putting the final pieces in place on secure mobile-money payments. The moment booking opens, we'll email you to pay your <strong>10% deposit (${fmt(reg.deposit_amount)})</strong> and lock in your spot.</p>
    <p>In the meantime, explore the platform and log in to your dashboard any time. Have thoughts? Just reply to this email — your feedback shapes what we ship next.</p>
    <p>— Teddy &amp; the Founder's Sprint team</p>
  </div>
  <div class="footer"><p><strong style="color:#E8A94B">The Founder's Sprint</strong> · Build with direction.</p>
  <p><a href="mailto:${ADMIN_EMAIL}" style="color:#E8A94B">${ADMIN_EMAIL}</a></p></div></div></body></html>`;
  return sendEmail({
    to:             reg.email,
    subject:        `Your place is reserved · The Founder's Sprint`,
    html,
    registrationId: reg.id,
    template:       'reservation_preview',
  });
}

// ── Admin new-registration notification (inline HTML, no template file) ───────
async function sendNewRegistrationAdmin(reg, cohort, isPreview = false) {
  const trackLabel = { group: 'Group', oneOnOne: '1-on-1', vip: 'VIP All-Access', vip1on1: 'VIP 1-on-1', single: '1-on-1 Session', pick3: 'Pick 3 Bundle', cohort: 'Full Cohort' }[reg.track] || reg.track;
  const cohortName = cohort ? cohort.name : 'VIP 1-on-1 (no cohort)';
  const previewBadge = isPreview
    ? `<p style="margin:0 0 12px"><span style="display:inline-block;background:#C9923A;color:#fff;font-weight:bold;font-size:12px;letter-spacing:.5px;padding:5px 10px;border-radius:4px">PREVIEW · INTEREST (NO PAYMENT)</span></p>`
    : '';
  const html = `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:40px auto;color:#222;line-height:1.6">
  <h2 style="color:#1B4332;margin-bottom:4px">${isPreview ? '📝 New Reserved Booking' : '🎉 New Registration'}</h2>
  <p style="color:#666;margin-top:0">${cohortName} · The Founder's Sprint</p>
  ${previewBadge}
  <table style="border-collapse:collapse;width:100%;margin-top:16px">
    <tr style="background:#f5f5f5"><td style="padding:10px 14px;border:1px solid #ddd;font-weight:bold">Name</td><td style="padding:10px 14px;border:1px solid #ddd">${reg.first_name} ${reg.last_name}</td></tr>
    <tr><td style="padding:10px 14px;border:1px solid #ddd;font-weight:bold">Email</td><td style="padding:10px 14px;border:1px solid #ddd"><a href="mailto:${reg.email}">${reg.email}</a></td></tr>
    <tr style="background:#f5f5f5"><td style="padding:10px 14px;border:1px solid #ddd;font-weight:bold">Phone / WhatsApp</td><td style="padding:10px 14px;border:1px solid #ddd">${reg.phone || '—'}</td></tr>
    <tr><td style="padding:10px 14px;border:1px solid #ddd;font-weight:bold">Business</td><td style="padding:10px 14px;border:1px solid #ddd">${reg.company || '—'}</td></tr>
    <tr style="background:#f5f5f5"><td style="padding:10px 14px;border:1px solid #ddd;font-weight:bold">Track</td><td style="padding:10px 14px;border:1px solid #ddd">${trackLabel}</td></tr>
    <tr><td style="padding:10px 14px;border:1px solid #ddd;font-weight:bold">Full Fee</td><td style="padding:10px 14px;border:1px solid #ddd">${fmt(reg.full_fee)}</td></tr>
    <tr style="background:#f5f5f5"><td style="padding:10px 14px;border:1px solid #ddd;font-weight:bold">Deposit Due</td><td style="padding:10px 14px;border:1px solid #ddd"><strong>${fmt(reg.deposit_amount)}</strong></td></tr>
    <tr><td style="padding:10px 14px;border:1px solid #ddd;font-weight:bold">Registration ID</td><td style="padding:10px 14px;border:1px solid #ddd">#${reg.id}</td></tr>
  </table>
  <p style="margin-top:24px;color:#555;font-size:14px">${isPreview
    ? 'Preview interest booking — no payment expected. When booking opens, the founder will be emailed to pay their deposit.'
    : 'Once payment arrives via Airtel Money, mark the deposit received via the admin API.'}</p>
</body></html>`;

  return sendEmail({
    to:             ADMIN_EMAIL,
    subject:        `${isPreview ? '📝 Reserved' : '🎉 New'} ${trackLabel} ${isPreview ? 'booking' : 'registration'}: ${reg.first_name} ${reg.last_name} · ${cohortName}`,
    html,
    registrationId: reg.id,
    template:       'admin_new_registration',
  });
}

// ── Reminders ─────────────────────────────────────────────────────────────────
async function sendReminder14d(reg, cohort) {
  return sendWithTemplate('reminder_14d', {
    FIRST_NAME:    reg.first_name,
    COHORT_NAME:   cohort.name,
    COHORT_DATES:  cohort.dates || `${cohort.start_date} – ${cohort.end_date}`,
    BALANCE:       fmt(reg.balance_amount),
    AIRTEL_NUMBER: AIRTEL_NUMBER(),
    ADMIN_EMAIL,
  }, { to: reg.email, subject: `14 days to go · Balance due soon · ${cohort.name}`, registrationId: reg.id });
}

async function sendReminder7d(reg, cohort) {
  return sendWithTemplate('reminder_7d', {
    FIRST_NAME:    reg.first_name,
    COHORT_NAME:   cohort.name,
    COHORT_DATES:  cohort.dates || `${cohort.start_date} – ${cohort.end_date}`,
    BALANCE:       fmt(reg.balance_amount),
    AIRTEL_NUMBER: AIRTEL_NUMBER(),
    ADMIN_EMAIL,
  }, { to: reg.email, subject: `One week away · ${cohort.name} · The Founder's Sprint`, registrationId: reg.id });
}

async function sendReminder96h(reg, cohort) {
  return sendWithTemplate('reminder_96h', {
    FIRST_NAME:    reg.first_name,
    COHORT_NAME:   cohort.name,
    START_DATE:    cohort.start_date,
    BALANCE:       fmt(reg.balance_amount),
    AIRTEL_NUMBER: AIRTEL_NUMBER(),
    ADMIN_EMAIL,
  }, { to: reg.email, subject: `⚠️ 96 hours left to pay your balance · ${cohort.name}`, registrationId: reg.id });
}

// ── Auto-move / forfeit ───────────────────────────────────────────────────────
async function sendMovedNotification(reg, oldCohort, newCohort) {
  return sendWithTemplate('moved', {
    FIRST_NAME:       reg.first_name,
    OLD_COHORT:       oldCohort.name,
    NEW_COHORT_NAME:  newCohort.name,
    NEW_COHORT_DATES: newCohort.dates || `${newCohort.start_date} – ${newCohort.end_date}`,
    BALANCE:          fmt(reg.balance_amount),
    AIRTEL_NUMBER:    AIRTEL_NUMBER(),
    ADMIN_EMAIL,
  }, {
    to:             reg.email,
    subject:        `Your spot has been moved to ${newCohort.name} · The Founder's Sprint`,
    registrationId: reg.id,
  });
}

async function sendForfeitNotification(reg, cohort) {
  return sendWithTemplate('forfeited', {
    FIRST_NAME:  reg.first_name,
    COHORT_NAME: cohort.name,
    DEPOSIT:     fmt(reg.deposit_amount),
    ADMIN_EMAIL,
  }, {
    to:             reg.email,
    subject:        `Your deposit has been forfeited · The Founder's Sprint`,
    registrationId: reg.id,
  });
}

// ── Admin weekly report ───────────────────────────────────────────────────────
async function sendAdminReport(cohort, registrations) {
  const groupCount    = registrations.filter(r => r.track === 'group').length;
  const oneOnOneCount = registrations.filter(r => r.track === 'oneOnOne').length;
  const vipCount      = registrations.filter(r => r.track === 'vip').length;
  const fullyPaid     = registrations.filter(r => r.deposit_paid && r.balance_paid).length;
  const depositOnly   = registrations.filter(r => r.deposit_paid && !r.balance_paid).length;

  const rosterRows = registrations.map(r =>
    `<tr>
      <td>${r.first_name} ${r.last_name}</td>
      <td>${r.email}</td>
      <td>${r.track === 'oneOnOne' ? '1-on-1' : r.track}</td>
      <td>${r.balance_paid ? 'Fully paid' : r.deposit_paid ? 'Deposit only' : 'Unpaid'}</td>
      <td>${r.phone || '—'}</td>
      <td>${r.company || '—'}</td>
    </tr>`
  ).join('\n');

  return sendWithTemplate('admin_report', {
    COHORT_NAME:      cohort.name,
    START_DATE:       cohort.start_date,
    GROUP_COUNT:      groupCount,
    ONE_ON_ONE_COUNT: oneOnOneCount,
    VIP_COUNT:        vipCount,
    FULLY_PAID:       fullyPaid,
    DEPOSIT_ONLY:     depositOnly,
    TOTAL:            groupCount + oneOnOneCount + vipCount,
    ROSTER_ROWS:      rosterRows,
  }, {
    to:      ADMIN_EMAIL,
    subject: `📋 Pre-cohort report: ${cohort.name} starts ${cohort.start_date}`,
  });
}

// ── Payment confirmation ──────────────────────────────────────────────────────
async function sendPaymentConfirmation(reg, cohort, paymentType) {
  const isDeposit = paymentType === 'deposit';
  const amount    = isDeposit ? reg.deposit_amount : reg.balance_amount;
  const subject   = isDeposit
    ? `Deposit confirmed · ${cohort.name} · The Founder's Sprint`
    : `Full payment confirmed · ${cohort.name} · The Founder's Sprint`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>body{margin:0;background:#0B1810;font-family:Arial,sans-serif}
  .wrap{max-width:600px;margin:0 auto;background:#0f1e11;color:#e8e2d6}
  .header{padding:32px 40px 24px;border-bottom:1px solid rgba(201,160,54,0.3);text-align:center}
  .header h1{color:#fff;font-size:22px;margin:0}
  .header p{color:#8a9a88;font-size:13px;margin:8px 0 0}
  .body{padding:32px 40px}
  .amount{font-size:36px;font-weight:700;color:#C9A036;text-align:center;margin:24px 0 4px}
  .amount-label{text-align:center;color:#8a9a88;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:24px}
  p{margin:0 0 14px;font-size:15px;line-height:1.7}
  .footer{padding:20px 40px;border-top:1px solid rgba(201,160,54,0.2);text-align:center}
  .footer p{color:#8a9a88;font-size:12px;margin:4px 0}
  </style></head><body><div class="wrap">
  <div class="header"><h1>${isDeposit ? 'Deposit received ✓' : 'Payment complete ✓'}</h1>
  <p>${cohort.name} · The Founder's Sprint</p></div>
  <div class="body">
  <p>Hi ${reg.first_name},</p>
  <p>We've received your ${isDeposit ? 'deposit' : 'full balance'} — your spot is ${isDeposit ? 'secured' : 'fully confirmed'}.</p>
  <div class="amount">${fmt(amount)}</div>
  <div class="amount-label">${isDeposit ? 'Deposit received' : 'Balance received — fully paid'}</div>
  ${isDeposit ? `<p>Your balance of <strong>${fmt(reg.balance_amount)}</strong> is due before Day 1 of ${cohort.name}. You'll receive a reminder closer to the date.</p>` : '<p>You are fully paid up — nothing else owed. See you on Day 1!</p>'}
  <p>Questions? Reply directly to this email.</p>
  <p>— Teddy</p>
  </div>
  <div class="footer"><p><strong style="color:#C9A036">The Founder's Sprint</strong></p>
  <p><a href="mailto:${ADMIN_EMAIL}" style="color:#C9A036">${ADMIN_EMAIL}</a></p></div>
  </div></body></html>`;

  return sendEmail({
    to:             reg.email,
    subject,
    html,
    template:       `payment_confirmation_${paymentType}`,
    registrationId: reg.id,
  });
}

// ── Balance due reminder (1 week / 48h) ──────────────────────────────────────
async function sendBalanceDueReminder(reg, cohort, daysUntilDue) {
  const urgent  = daysUntilDue <= 2;
  const subject = urgent
    ? `⚠️ Balance due in 48 hours · ${cohort.name} · The Founder's Sprint`
    : `Reminder: Balance due in 1 week · ${cohort.name} · The Founder's Sprint`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>body{margin:0;background:#0B1810;font-family:Arial,sans-serif}
  .wrap{max-width:600px;margin:0 auto;background:#0f1e11;color:#e8e2d6}
  .header{padding:32px 40px 24px;border-bottom:1px solid rgba(201,160,54,0.3);text-align:center}
  .header h1{color:#fff;font-size:22px;margin:0}
  .header p{color:#8a9a88;font-size:13px;margin:8px 0 0}
  .body{padding:32px 40px}
  .amount{font-size:36px;font-weight:700;color:#C9A036;text-align:center;margin:24px 0 4px}
  .amount-label{text-align:center;color:#8a9a88;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:24px}
  .alert{background:rgba(201,160,54,0.08);border-left:3px solid #C9A036;padding:14px 18px;margin:20px 0;font-size:14px}
  p{margin:0 0 14px;font-size:15px;line-height:1.7}
  .footer{padding:20px 40px;border-top:1px solid rgba(201,160,54,0.2);text-align:center}
  .footer p{color:#8a9a88;font-size:12px;margin:4px 0}
  </style></head><body><div class="wrap">
  <div class="header"><h1>${urgent ? '⚠️ Balance due in 48 hours' : 'Balance due in 1 week'}</h1>
  <p>${cohort.name} · starts ${cohort.start_date}</p></div>
  <div class="body">
  <p>Hi ${reg.first_name},</p>
  <p>This is a reminder that your balance payment for <strong>${cohort.name}</strong> is due ${urgent ? 'within the next 48 hours' : 'in one week'}.</p>
  <div class="amount">${fmt(reg.balance_amount)}</div>
  <div class="amount-label">Balance due</div>
  <div class="alert">Send via <strong>MTN Mobile Money</strong> or <strong>Airtel Money</strong> to <strong>${AIRTEL_NUMBER()}</strong> (Teddy Mbusa Sondota). Use reference: <strong>FS-${reg.id}</strong>. Forward confirmation SMS to <a href="mailto:${ADMIN_EMAIL}" style="color:#C9A036">${ADMIN_EMAIL}</a>.</div>
  ${urgent ? '<p><strong>Unpaid spots are released back to the waitlist 48 hours before Day 1.</strong> Please pay today to secure your place.</p>' : '<p>Bank transfer details available on request — just reply to this email.</p>'}
  <p>— Teddy</p>
  </div>
  <div class="footer"><p><strong style="color:#C9A036">The Founder's Sprint</strong></p>
  <p><a href="mailto:${ADMIN_EMAIL}" style="color:#C9A036">${ADMIN_EMAIL}</a></p></div>
  </div></body></html>`;

  return sendEmail({
    to:             reg.email,
    subject,
    html,
    template:       `balance_reminder_${daysUntilDue}d`,
    registrationId: reg.id,
  });
}

// ── Course materials access link ─────────────────────────────────────────────
async function sendMaterialsAccess(reg, cohort, portalUrl, expiresAt) {
  const expiryStr = new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const trackLabel = { group: 'Group Sprint', oneOnOne: '1-on-1 Intensive', vip: 'VIP All-Access' }[reg.track] || reg.track;
  const CURRICULUM_URL = process.env.CURRICULUM_URL || 'https://founders-sprint-curriculum.vercel.app/login';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>body{margin:0;background:#0B1810;font-family:Arial,sans-serif}
  .wrap{max-width:600px;margin:0 auto;background:#142B1E;color:#e8e2d6}
  .header{padding:36px 40px 28px;border-bottom:1px solid rgba(201,160,54,0.25);text-align:center}
  .header-eyebrow{font-family:'Josefin Sans',sans-serif;color:#C9A036;font-size:10px;letter-spacing:4px;text-transform:uppercase;font-weight:600;margin:0 0 10px}
  .header h1{color:#ffffff;font-size:22px;margin:0;font-weight:700;letter-spacing:0.06em;text-transform:uppercase}
  .header p{color:rgba(255,255,255,0.5);font-size:13px;margin:8px 0 0}
  .deco-line{display:flex;align-items:center;justify-content:center;gap:10px;margin:18px 0 0}
  .deco-line span{display:block;height:1px;width:48px;background:#C9A036}
  .deco-diamond{width:6px;height:6px;background:#C9A036;transform:rotate(45deg)}
  .body{padding:40px;font-size:16px;line-height:1.75}
  .body p{margin:0 0 16px}
  .cta{display:block;text-align:center;background:#B85A2E;color:#fff!important;padding:18px 32px;font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;text-decoration:none;margin:32px 0 16px}
  .cta:hover{background:#9A4A24}
  .cta-secondary{display:block;text-align:center;border:1px solid rgba(201,160,54,0.4);color:#C9A036!important;padding:14px 28px;font-size:12px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;text-decoration:none;margin:0 0 28px}
  .how-box{background:rgba(201,160,54,0.06);border-left:3px solid #C9A036;padding:20px 24px;margin:24px 0}
  .how-box-title{font-family:'Josefin Sans',sans-serif;color:#C9A036;font-size:10px;letter-spacing:3px;text-transform:uppercase;margin:0 0 14px;font-weight:700}
  .step{display:flex;align-items:flex-start;gap:14px;margin-bottom:12px}
  .step:last-child{margin-bottom:0}
  .step-num{background:#C9A036;color:#0B1810;font-family:'Josefin Sans',sans-serif;font-weight:700;font-size:11px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px}
  .step-text{color:rgba(255,255,255,0.7);font-size:14px;line-height:1.6}
  .step-text strong{color:#ffffff}
  .includes-box{background:rgba(255,255,255,0.04);padding:20px 24px;margin:20px 0}
  .includes-box p{margin:0 0 6px;font-size:14px;color:rgba(255,255,255,0.6)}
  .includes-box strong{color:#C9A036}
  .note{font-size:13px;color:rgba(255,255,255,0.4);margin:20px 0}
  .footer{background:#0B1810;padding:28px 40px;text-align:center;border-top:1px solid rgba(201,160,54,0.2)}
  .footer p{color:rgba(255,255,255,0.35);font-size:10px;letter-spacing:0.12em;text-transform:uppercase;margin:4px 0}
  .footer a{color:#C9A036;text-decoration:none}
  </style></head><body><div class="wrap">
  <div class="header">
    <p class="header-eyebrow">The Founder's Sprint</p>
    <h1>You're fully paid.</h1>
    <p>${cohort.name} · ${trackLabel}</p>
    <div class="deco-line"><span></span><div class="deco-diamond"></div><span></span></div>
  </div>
  <div class="body">
  <p>Hi ${reg.first_name},</p>
  <p>Your payment is complete and your programme begins in <strong>2 days</strong>. All 5 weeks of curriculum, downloadable templates, the Founder's Resource Directory, and your launch checklist are now ready for you.</p>

  <a class="cta" href="${CURRICULUM_URL}">Access Your Curriculum</a>

  <div class="how-box">
    <p class="how-box-title">How to log in</p>
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-text">Click <strong>Access Your Curriculum</strong> above</div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-text">Enter your email: <strong>${reg.email}</strong></div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-text">Check your inbox for a <strong>secure login link</strong> (no password needed)</div>
    </div>
    <div class="step">
      <div class="step-num">4</div>
      <div class="step-text">Click the link and you're in — <strong>bookmark the page</strong> for easy access</div>
    </div>
  </div>

  <div class="includes-box">
    <p><strong>Week 1-5 Modules</strong> — structured curriculum with exercises and deliverables</p>
    <p><strong>Founder's Toolkit</strong> — resource directory, launch checklist, downloadable templates</p>
    <p><strong>Templates</strong> — financial model, cap table, co-founder agreement, pitch deck, and more</p>
    <p><strong>Government Links</strong> — URSB, URA, KCCA, UNBS, and other regulatory resources</p>
  </div>

  <p class="note">Your curriculum access is available until <strong style="color:rgba(255,255,255,0.65)">${expiryStr}</strong> (end of the course). Save this email — you can use the link above any time to log in.</p>

  <p>See you on Day 1!</p>
  <p>— Teddy</p>
  </div>
  <div class="footer">
    <p><strong style="color:#C9A036">The Founder's Sprint</strong></p>
    <p>5 weeks · from idea to strategy</p>
    <p style="margin-top:10px"><a href="mailto:${ADMIN_EMAIL}">${ADMIN_EMAIL}</a></p>
    <p>&copy; 2026 TMS Ruge. All rights reserved.</p>
  </div>
  </div></body></html>`;

  return sendEmail({
    to:             reg.email,
    subject:        `Your course materials are ready · ${cohort.name} · The Founder's Sprint`,
    html,
    template:       'materials_access',
    registrationId: reg.id,
  });
}

// ── L1 taxonomy label map ────────────────────────────────────────────────────
const L1_LABELS = {
  marketing_branding:        'Marketing & Branding',
  financial_modelling:       'Financial Modelling & Business Finance',
  strategy_team:             'Strategy & Team Building',
  investment_readiness:      'Investment Readiness & Fundraising',
  product_development:       'Product Development & Pricing',
};

function l1Label(val) {
  return L1_LABELS[val] || val;
}

// ── Coach confirmation (sent to applicant on submission) ─────────────────────
async function sendCoachConfirmation(application) {
  return sendWithTemplate('coach_application_received', {
    FIRST_NAME: application.first_name,
    L1_LABEL:   l1Label(application.taxonomy_l1),
    HEADLINE:   application.headline || '',
  }, {
    to:       application.email,
    subject:  "Application received · The Founder's Sprint Coach Network",
  });
}

// ── Admin notification (sent to admin when new application arrives) ──────────
async function sendCoachAdminNotification(application) {
  const dashboardUrl = process.env.ADMIN_DASHBOARD_URL
    || 'https://founderssprint.co/admin-portals.html';

  return sendWithTemplate('coach_application_admin', {
    FULL_NAME:          `${application.first_name} ${application.last_name}`,
    EMAIL:              application.email,
    PHONE:              `${application.country_code || '+256'} ${application.phone || '—'}`,
    L1_LABEL:           l1Label(application.taxonomy_l1),
    L2_LIST:            Array.isArray(application.taxonomy_l2)
                          ? application.taxonomy_l2.join(', ') : (application.taxonomy_l2 || '—'),
    HEADLINE:           application.headline || '—',
    CURRENT_ROLE:       application.current_role || '—',
    SESSION_TYPES:      Array.isArray(application.session_types)
                          ? application.session_types.join(', ') : (application.session_types || '—'),
    SUBMITTED_AT:       new Date(application.created_at || Date.now())
                          .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    EXPERIENCE_EXCERPT: (application.experience || '').slice(0, 300) + ((application.experience || '').length > 300 ? '…' : ''),
    DASHBOARD_URL:      dashboardUrl,
  }, {
    to:      ADMIN_EMAIL,
    subject: `New coach application: ${application.first_name} ${application.last_name}`,
  });
}

// ── Coach approval (sent to applicant when approved) ─────────────────────────
async function sendCoachApproval(application, loginInfo = {}) {
  const { tempPassword, loginUrl } = loginInfo;

  // Build login credentials block (only if auth account was created)
  let loginBlock = '';
  if (tempPassword && loginUrl) {
    loginBlock = `
    <div style="background:#1A1A1A;border:1px solid rgba(200,83,31,0.35);padding:28px;margin:28px 0">
      <p style="font-family:'Josefin Sans',sans-serif;color:#C8531F;font-size:10px;letter-spacing:3px;text-transform:uppercase;margin:0 0 16px;font-weight:700">Your Login Credentials</p>
      <p style="color:rgba(239,231,216,0.7);font-size:15px;line-height:1.65;margin:0 0 8px"><strong style="color:#EFE7D8">Email:</strong> ${application.email}</p>
      <p style="color:rgba(239,231,216,0.7);font-size:15px;line-height:1.65;margin:0 0 16px"><strong style="color:#EFE7D8">Temporary password:</strong> <code style="background:rgba(200,83,31,0.15);padding:2px 8px;font-family:monospace;color:#C8531F">${tempPassword}</code></p>
      <p style="color:rgba(239,231,216,0.5);font-size:13px;line-height:1.5;margin:0">Please change your password after your first login.</p>
      <a href="${loginUrl}" style="display:inline-block;margin-top:16px;padding:14px 28px;background:#C8531F;color:#EFE7D8;font-family:'Josefin Sans',sans-serif;font-size:11px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;text-decoration:none">Sign In to Dashboard</a>
    </div>`;
  }

  return sendWithTemplate('coach_approved', {
    FIRST_NAME:   application.first_name,
    L1_LABEL:     l1Label(application.taxonomy_l1),
    ASSIGNED_DAY: application.assigned_day || 'To be confirmed',
    LOGIN_BLOCK:  loginBlock,
  }, {
    to:      application.email,
    subject: "Welcome to the coaching network · The Founder's Sprint",
  });
}

// ── Coach rejection (sent to applicant when declined) ────────────────────────
async function sendCoachRejection(application, reason) {
  const reasonBlock = reason
    ? `<div class="highlight-box"><strong>Feedback from our team</strong><br><span style="color:rgba(255,255,255,0.6); font-size:15px;">${reason}</span></div>`
    : '';

  return sendWithTemplate('coach_rejected', {
    FIRST_NAME:   application.first_name,
    REASON_BLOCK: reasonBlock,
  }, {
    to:      application.email,
    subject: "Application update · The Founder's Sprint Coach Network",
  });
}

// ── Directory provider lifecycle emails ──────────────────────────────────────

const TIER_LABELS = { basic: 'Basic', verified: 'Verified Partner', corporate: 'Programme Sponsor', programme_partner: 'Programme Partner', strategic_partner: 'Strategic Partner' };
const TIER_PRICES = { basic: 'Free', verified: 'UGX 500,000/quarter', corporate: 'UGX 25,000,000/year', programme_partner: 'UGX 50,000,000/year', strategic_partner: 'Custom' };

function directoryEmailShell(title, body) {
  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:40px auto;color:#1A1A1A;line-height:1.6;background:#EFE7D8">
  <div style="padding:32px 28px">
    <div style="font-family:'Josefin Sans',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#C8531F;margin-bottom:24px">The Founder's Sprint</div>
    <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:400;color:#1A1A1A;margin:0 0 20px">${title}</h2>
    ${body}
    <div style="margin-top:32px;padding-top:20px;border-top:1px solid rgba(26,26,26,0.12);font-size:12px;color:#5A564F">
      <a href="https://founderssprint.co/beta/directory.html" style="color:#C8531F;text-decoration:none">View Directory</a> · <a href="mailto:hello@founderssprint.co" style="color:#C8531F;text-decoration:none">Contact Us</a>
    </div>
  </div>
</body></html>`;
}

async function sendDirectoryReminder(provider, type) {
  const daysLeft = type === '14d' ? 14 : 3;
  const urgency = type === '3d' ? 'Your listing expires in 3 days' : 'Your listing expires soon';
  const expiryDate = new Date(provider.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const tierLabel = TIER_LABELS[provider.tier] || provider.tier;
  const tierPrice = TIER_PRICES[provider.tier] || '';

  // TODO: Replace with actual renewal link when ioTec payment is connected
  const renewUrl = `https://founderssprint.co/beta/apply-directory.html`;

  const body = `
    <p>Hi ${provider.contact_name || 'there'},</p>
    <p>Your <strong>${tierLabel}</strong> listing for <strong>${provider.company_name}</strong> on The Founder's Sprint directory expires on <strong>${expiryDate}</strong> — that's ${daysLeft} days from now.</p>
    <p>To keep your listing visible to our founder community, renew before it expires:</p>
    <div style="margin:24px 0">
      <a href="${renewUrl}" style="display:inline-block;background:#C8531F;color:#EFE7D8;font-family:Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:14px 28px;text-decoration:none">Renew Listing</a>
    </div>
    <p style="font-size:14px;color:#5A564F">Renewal rate: ${tierPrice}</p>
    ${type === '3d' ? '<p style="color:#C8531F;font-weight:600">After expiry, your listing will be removed from the public directory. You can renew at any time to reactivate it.</p>' : ''}`;

  const html = directoryEmailShell(urgency, body);

  return sendEmail({
    to:       provider.email,
    subject:  `${urgency} · ${provider.company_name} · The Founder's Sprint Directory`,
    html,
    template: `directory_reminder_${type}`,
  });
}

async function sendDirectoryExpired(provider) {
  const tierLabel = TIER_LABELS[provider.tier] || provider.tier;
  const tierPrice = TIER_PRICES[provider.tier] || '';
  const renewUrl = `https://founderssprint.co/beta/apply-directory.html`;

  const body = `
    <p>Hi ${provider.contact_name || 'there'},</p>
    <p>Your <strong>${tierLabel}</strong> listing for <strong>${provider.company_name}</strong> has expired and is no longer visible on The Founder's Sprint directory.</p>
    <p>Your listing data is preserved — renew at any time to reactivate it instantly:</p>
    <div style="margin:24px 0">
      <a href="${renewUrl}" style="display:inline-block;background:#C8531F;color:#EFE7D8;font-family:Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:14px 28px;text-decoration:none">Renew & Reactivate</a>
    </div>
    <p style="font-size:14px;color:#5A564F">Renewal rate: ${tierPrice}</p>
    <p style="font-size:13px;color:#5A564F">If you no longer wish to be listed, no action is needed. Your data will be retained for 90 days in case you change your mind.</p>`;

  const html = directoryEmailShell('Your listing has expired', body);

  return sendEmail({
    to:       provider.email,
    subject:  `Listing expired · ${provider.company_name} · The Founder's Sprint Directory`,
    html,
    template: 'directory_expired',
  });
}

async function sendDirectoryRenewalConfirmation(provider, newExpiresAt) {
  const tierLabel = TIER_LABELS[provider.tier] || provider.tier;
  const newExpiry = new Date(newExpiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const body = `
    <p>Hi ${provider.contact_name || 'there'},</p>
    <p>Your <strong>${tierLabel}</strong> listing for <strong>${provider.company_name}</strong> has been renewed and is live on the directory.</p>
    <p><strong>New expiry date:</strong> ${newExpiry}</p>
    <p>Thank you for continuing to serve our founder community.</p>`;

  const html = directoryEmailShell('Listing renewed', body);

  return sendEmail({
    to:       provider.email,
    subject:  `Listing renewed · ${provider.company_name} · The Founder's Sprint Directory`,
    html,
    template: 'directory_renewal_confirmation',
  });
}

// ── Staff onboarding invite (Admin & Ops) ────────────────────────────────────
async function sendStaffInvite({ to, name, roleLabel, rolePlural, actionUrl, existingAccount }) {
  const introLine = existingAccount
    ? "Your access to The Founder's Sprint platform has been updated. Use the secure link below to set a new password and sign in."
    : "You've been added to The Founder's Sprint platform team. Welcome aboard — let's get your account set up.";
  const html = loadTemplate('staff_invite', {
    NAME:        name || 'Hi',
    ROLE_LABEL:  roleLabel || '—',
    ROLE_PLURAL: rolePlural ? 's' : '',
    INTRO_LINE:  introLine,
    ACTION_URL:  actionUrl,
    ACTION_VERB: existingAccount ? 'Set a new password' : 'Set your password',
  });
  return sendEmail({
    to,
    subject: existingAccount
      ? "Your Founder's Sprint access has been updated"
      : "You've been granted access to The Founder's Sprint",
    html,
    template: 'staff_invite',
  });
}

// ── Mentor session payment (post-approval) ───────────────────────────────────
function mentorLabel(mentor) {
  if (!mentor) return 'your mentor';
  return mentor.name + (mentor.title ? ` · ${mentor.title}` : '');
}
function mentorShell(title, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>body{margin:0;background:#0B1810;font-family:Arial,sans-serif}
  .wrap{max-width:600px;margin:0 auto;background:#0f1e11;color:#e8e2d6}
  .header{padding:32px 40px 24px;border-bottom:1px solid rgba(201,160,54,0.3);text-align:center}
  .header h1{color:#fff;font-size:22px;margin:0}.header p{color:#8a9a88;font-size:13px;margin:8px 0 0}
  .body{padding:32px 40px}.amount{font-size:34px;font-weight:700;color:#C9A036;text-align:center;margin:22px 0 4px}
  .amount-label{text-align:center;color:#8a9a88;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:22px}
  p{margin:0 0 14px;font-size:15px;line-height:1.7}
  .footer{padding:20px 40px;border-top:1px solid rgba(201,160,54,0.2);text-align:center}
  .footer p{color:#8a9a88;font-size:12px;margin:4px 0}</style></head><body><div class="wrap">
  <div class="header"><h1>${title}</h1><p>Mentor session · The Founder's Sprint</p></div>
  <div class="body">${bodyHtml}</div>
  <div class="footer"><p><strong style="color:#C9A036">The Founder's Sprint</strong></p>
  <p><a href="mailto:${ADMIN_EMAIL}" style="color:#C9A036">${ADMIN_EMAIL}</a></p></div></div></body></html>`;
}

// Founder: a mobile-money prompt has been sent — approve it to pay.
async function sendMentorPaymentRequested(reqRow, mentor) {
  const amount = reqRow.amount_charged || reqRow.quoted_fee;
  const fmtLabel = reqRow.format === 'coffee' ? 'coffee sit-down' : 'Zoom call';
  const html = mentorShell('Approve your payment', `
    <p>Hi ${reqRow.founder_name || 'there'},</p>
    <p>Your ${fmtLabel} with <strong>${mentorLabel(mentor)}</strong> is confirmed pending payment.</p>
    <div class="amount">${fmt(amount)}</div><div class="amount-label">Session fee</div>
    <p>We've sent a mobile-money prompt to <strong>${reqRow.founder_phone || 'your phone'}</strong>. Enter your PIN to confirm — we'll email you the moment it lands and sort out the timing with you.</p>
    <p>— Teddy</p>`);
  return sendEmail({ to: reqRow.founder_email, subject: `Approve your payment · Mentor session · The Founder's Sprint`, html, template: 'mentor_payment_requested' });
}

// Founder + admin: payment landed — session confirmed.
async function sendMentorConfirmed(reqRow, mentor) {
  const amount = reqRow.amount_charged || reqRow.quoted_fee;
  const fmtLabel = reqRow.format === 'coffee' ? 'coffee sit-down' : 'Zoom call';
  const founderHtml = mentorShell('Payment received ✓', `
    <p>Hi ${reqRow.founder_name || 'there'},</p>
    <p>Your ${fmtLabel} with <strong>${mentorLabel(mentor)}</strong> is booked and paid.</p>
    <div class="amount">${fmt(amount)}</div><div class="amount-label">Paid in full</div>
    <p>We'll be in touch shortly to lock the exact time and share the details. Come with your sharpest questions.</p>
    <p>— Teddy</p>`);
  const adminHtml = mentorShell('Mentor session PAID', `
    <p><strong>${reqRow.founder_name}</strong> (${reqRow.founder_email}${reqRow.founder_phone ? ' · ' + reqRow.founder_phone : ''}) paid ${fmt(amount)} for a ${fmtLabel} with <strong>${mentorLabel(mentor)}</strong>.</p>
    <p>Coordinate the scheduling between them. Request ref: ${reqRow.id}</p>`);
  const [f, a] = await Promise.allSettled([
    sendEmail({ to: reqRow.founder_email, subject: `Session confirmed · ${mentorLabel(mentor)} · The Founder's Sprint`, html: founderHtml, template: 'mentor_confirmed' }),
    sendEmail({ to: ADMIN_EMAIL, subject: `Mentor session PAID · ${reqRow.founder_name} ↔ ${mentor ? mentor.name : 'mentor'}`, html: adminHtml, template: 'mentor_confirmed_admin' }),
  ]);
  if (f.status === 'rejected') console.error('[emailer] mentor founder confirm failed:', f.reason);
  if (a.status === 'rejected') console.error('[emailer] mentor admin confirm failed:', a.reason);
  return true;
}

// ── Mentor recommendation → auto-invite the nominee to self-register ──────────
// Sent to a recommended operator so they can set up their own mentor profile.
// Best-effort, cold-but-courteous: clear "no obligation, ignore if not for you".
async function sendMentorRecommendationInvite({ email, prospect_name, recommender_name }) {
  const applyUrl = 'https://founderssprint.co/mentor-apply.html';
  const intro = recommender_name
    ? `${recommender_name} recommended you as a mentor for The Founder's Sprint.`
    : `You've been recommended as a mentor for The Founder's Sprint.`;
  const html = `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:40px auto;color:#1A1A1A;line-height:1.65;background:#EFE7D8">
  <div style="padding:34px 30px">
    <div style="font-family:'Josefin Sans',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#C8531F;margin-bottom:22px">The Founder's Sprint</div>
    <h2 style="font-family:Georgia,serif;font-size:23px;font-weight:400;margin:0 0 18px">You've been recommended as a mentor</h2>
    <p style="margin:0 0 14px">Hi ${prospect_name || 'there'},</p>
    <p style="margin:0 0 14px">${intro} We connect Uganda's founders with operators who've actually done it — built, scaled, raised, or exited — for a paid coffee or Zoom to pick their brain.</p>
    <p style="margin:0 0 14px">Setting up your profile takes about five minutes. You set your own fees and formats, pick the specialties you'll take, and go live once we approve you.</p>
    <div style="margin:26px 0">
      <a href="${applyUrl}" style="display:inline-block;background:#C8531F;color:#EFE7D8;font-family:Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:15px 30px;text-decoration:none">Become a mentor &rarr;</a>
    </div>
    <p style="font-size:13px;color:#5A564F;margin:0">No obligation — if it's not for you, just ignore this email. Questions? Reply and we'll help.</p>
    <div style="margin-top:30px;padding-top:18px;border-top:1px solid rgba(26,26,26,0.12);font-size:12px;color:#5A564F">
      <a href="${applyUrl}" style="color:#C8531F;text-decoration:none">founderssprint.co/mentor-apply.html</a> · <a href="mailto:hello@founderssprint.co" style="color:#C8531F;text-decoration:none">hello@founderssprint.co</a>
    </div>
  </div>
</body></html>`;
  return sendEmail({ to: email, subject: `You've been recommended as a mentor · The Founder's Sprint`, html, template: 'mentor_recommendation_invite' });
}

module.exports = {
  sendStaffInvite,
  sendMentorRecommendationInvite,
  sendMentorPaymentRequested,
  sendMentorConfirmed,
  sendConfirmation,
  sendReservationConfirmation,
  sendNewRegistrationAdmin,
  sendReminder14d,
  sendReminder7d,
  sendReminder96h,
  sendMovedNotification,
  sendForfeitNotification,
  sendAdminReport,
  sendPaymentConfirmation,
  sendBalanceDueReminder,
  sendMaterialsAccess,
  // Coach application pipeline
  sendCoachConfirmation,
  sendCoachAdminNotification,
  sendCoachApproval,
  sendCoachRejection,
  // Directory provider lifecycle
  sendDirectoryReminder,
  sendDirectoryExpired,
  sendDirectoryRenewalConfirmation,
};
