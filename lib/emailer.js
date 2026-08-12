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
  const BASE           = 'https://founderssprint.co';
  const isVip          = reg.track === 'vip' || reg.track === 'vip1on1';
  const balanceDueDate = cohort ? fmtBalanceDueDate(cohort.start_date) : 'Scheduled after your deposit';
  const icsAttachment  = cohort ? generateICS(cohort, reg) : null;
  const cohortName     = cohort ? cohort.name : 'VIP Leadership';
  const cohortDates    = cohort ? (cohort.dates || `${cohort.start_date} – ${cohort.end_date}`) : 'Scheduling follows your deposit';
  const trackLabel     = { group:'Full Cohort', oneOnOne:'1-on-1 Session', vip:'VIP Leadership', vip1on1:'VIP Leadership', single:'1-on-1 Session', pick3:'Pick 3 Bundle', cohort:'Full Cohort' }[reg.track] || reg.track;

  const row = (k, v) => `<tr><td style="padding:7px 0;font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#5A564F;">${k}</td><td align="right" style="padding:7px 0;font-family:'Inter',Arial,sans-serif;font-size:14px;color:#1A1A1A;">${v}</td></tr>`;
  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${reg.first_name},</p>
    <p style="margin:0 0 22px;">Your place in <strong style="color:#1A1A1A">${cohortName}</strong> is confirmed. Here are the details for your records.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="fspd" style="background:#E6DCC7;border-radius:0 0 20px 0;margin:0 0 22px;">
      <tr><td style="height:3px;line-height:3px;font-size:0;background:#C8531F;">&nbsp;</td></tr>
      <tr><td style="padding:16px 22px;">
        <div style="font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#5A564F;margin-bottom:6px;">Your booking</div>
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;color:#1A1A1A;margin-bottom:8px;">${trackLabel} · Booking #${reg.id}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${cohort ? row('Dates', cohortDates) : ''}
          ${row('Full fee', fmt(reg.full_fee))}
          ${row('Deposit', fmt(reg.deposit_amount))}
          ${row('Balance', fmt(reg.balance_amount))}
          ${row('Balance due', balanceDueDate)}
        </table>
      </td></tr>
    </table>
    <p style="margin:0 0 22px;">Log in any time to see your programme, your coaching sessions with their Google Meet links, and your data room. Your balance is due by <strong style="color:#1A1A1A">${balanceDueDate}</strong>${cohort ? ' — 48 hours before your first session' : ''}.</p>
    ${emailBtn('Go to your dashboard', BASE + '/login-founder.html')}
  `;
  const html = fsEmailShell({
    eyebrow:  'Registration confirmed',
    headline: `You're in, ${reg.first_name}.`,
    bodyHtml,
  });
  return sendEmail({
    to:             reg.email,
    subject:        isVip ? `Your VIP Leadership place is confirmed · The Founder's Sprint`
                          : `You're registered · ${cohortName} · The Founder's Sprint`,
    html,
    template:       isVip ? 'confirmation_vip' : 'confirmation',
    registrationId: reg.id,
    attachments:    icsAttachment ? [icsAttachment] : [],
  });
}

// ── Brand email shell (The Founder's Sprint design system) ────────────────────
// Email-safe (table layout, inline styles). Ink header band with the V6 mark +
// wordmark, a discipline/accent rule, a Cormorant-italic headline, paper body, and
// the tagline footer. The inline SVG mark renders in Apple Mail/most clients and is
// silently dropped (no broken-image icon) in the few that strip SVG.
// Fonts follow DESIGN.md: Josefin Sans (labels), Cormorant Garamond (display),
// Inter (body) — each with a document-safe fallback (Arial / Georgia).
function fsEmailShell({ accent = '#C8531F', eyebrow = '', eyebrowBg = 'rgba(200,83,31,0.15)', eyebrowColor = '#9A3E16', headline = '', bodyHtml = '' }) {
  const mark = `<svg width="30" height="30" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="display:block">
    <polygon points="50,8 57,50 50,92 43,50" fill="#C8531F" opacity="0.85"/>
    <polygon points="50,8 57,50 50,92 43,50" fill="#C9923A" opacity="0.80" transform="rotate(72 50 50)"/>
    <polygon points="50,8 57,50 50,92 43,50" fill="#8AAB5C" opacity="0.78" transform="rotate(144 50 50)"/>
    <polygon points="50,8 57,50 50,92 43,50" fill="#3D4A2E" opacity="0.82" transform="rotate(216 50 50)"/>
    <polygon points="50,8 57,50 50,92 43,50" fill="#777770" opacity="0.75" transform="rotate(288 50 50)"/>
    <circle cx="50" cy="50" r="4.5" fill="#EFE7D8"/><circle cx="50" cy="50" r="2" fill="#1A1A1A"/></svg>`;
  const eyebrowBlock = eyebrow ? `<tr><td style="padding:0 0 16px"><span style="display:inline-block;background:${eyebrowBg};color:${eyebrowColor};font-family:'Josefin Sans',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;padding:7px 13px;">${eyebrow}</span></td></tr>` : '';
  const headlineBlock = headline ? `<tr><td class="fs-h1" style="font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-weight:400;font-size:33px;line-height:1.16;color:#1A1A1A;padding:0 0 20px">${headline}</td></tr>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Josefin+Sans:wght@400;600;700&family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400;1,600&family=Inter:wght@400;500;600&display=swap');
    :root{color-scheme:light dark;supported-color-schemes:light dark;}
    body{margin:0;padding:0;} a{color:#C8531F;text-decoration:none;}
    @media (max-width:600px){ .fs-pad{padding-left:24px!important;padding-right:24px!important;} .fs-h1{font-size:28px!important;} }
    @media (prefers-color-scheme: dark){ .fsp{background:#EFE7D8!important;} .fspd{background:#E6DCC7!important;} }
  </style></head>
  <body style="margin:0;padding:0;background:#D8CFBE;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#D8CFBE;"><tr><td align="center" style="padding:30px 10px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="fsp" style="width:600px;max-width:600px;background:#EFE7D8;">
      <tr><td style="background:#1A1A1A;padding:22px 40px;" class="fs-pad">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="34" valign="middle" style="width:34px;">${mark}</td>
          <td valign="middle" style="padding-left:12px;font-family:'Josefin Sans',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:3px;color:#EFE7D8;">THE&nbsp;FOUNDER'S&nbsp;SPRINT</td>
        </tr></table>
      </td></tr>
      <tr><td style="height:3px;line-height:3px;font-size:0;background:${accent};">&nbsp;</td></tr>
      <tr><td style="padding:38px 40px 30px;" class="fs-pad">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${eyebrowBlock}${headlineBlock}
          <tr><td style="font-family:'Inter',Arial,sans-serif;font-size:15px;line-height:1.7;color:#2A2826;">${bodyHtml}</td></tr>
        </table>
      </td></tr>
      <tr><td style="background:#1A1A1A;padding:20px 40px;" class="fs-pad">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="middle" style="font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2.5px;color:rgba(239,231,216,0.6);">THE&nbsp;FOUNDER'S&nbsp;SPRINT&nbsp;·&nbsp;KAMPALA</td>
          <td valign="middle" align="right" style="font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-size:15px;color:#C8531F;">Build with direction.</td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

// ── Shared brand button + balance-reminder body (used by the rebuilt emails) ──
function emailBtn(label, href, bg = '#C8531F', fg = '#EFE7D8') {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 2px;"><tr><td bgcolor="${bg}" style="border-radius:0 0 14px 0;"><a href="${href}" style="display:inline-block;font-family:'Josefin Sans',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${fg};text-decoration:none;padding:14px 26px;">${label}</a></td></tr></table>`;
}
function balanceReminderHtml(reg, cohort, { eyebrow, headline, urgent, leadPara }) {
  const BASE = 'https://founderssprint.co';
  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${reg.first_name},</p>
    <p style="margin:0 0 20px;">${leadPara}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="fspd" style="background:#E6DCC7;border-radius:0 0 20px 0;margin:0 0 20px;">
      <tr><td style="height:3px;line-height:3px;font-size:0;background:${urgent ? '#9A3E16' : '#C8531F'};">&nbsp;</td></tr>
      <tr><td style="padding:18px 22px;text-align:center;">
        <div style="font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#5A564F;margin-bottom:6px;">Balance due</div>
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:34px;color:#1A1A1A;">${fmt(reg.balance_amount)}</div>
      </td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td style="border-left:3px solid #C8531F;padding:12px 18px;font-family:'Inter',Arial,sans-serif;font-size:13.5px;line-height:1.6;color:#2A2826;">
      Pay via <strong>MTN Mobile Money</strong> or <strong>Airtel Money</strong> to <strong>${AIRTEL_NUMBER()}</strong> (Teddy Mbusa Sondota), reference <strong>FS-${reg.id}</strong>. Forward your confirmation SMS to <a href="mailto:${ADMIN_EMAIL}" style="color:#9A3E16;">${ADMIN_EMAIL}</a>.
    </td></tr></table>
    ${urgent ? '<p style="margin:0 0 20px;"><strong style="color:#9A3E16">Unpaid places are released 48 hours before Day 1.</strong> Please complete payment today to keep your spot.</p>' : ''}
    ${emailBtn('Manage your booking', BASE + '/login-founder.html')}
  `;
  return fsEmailShell({ accent: urgent ? '#9A3E16' : '#C8531F', eyebrow, eyebrowColor: '#9A3E16', headline, bodyHtml });
}

// ── Preview-launch reservation — the sales-forward founder email ──────────────
// Structure: dark constellation hero → reservation details → five-disciplines
// teaser → course products + pricing → mentors/directory CTA → footer. Every
// section is a selling surface. Email-safe (tables, inline styles); the inline SVG
// hero/mark render in Apple Mail and drop cleanly (no broken icon) where stripped.
async function sendReservationConfirmation(reg, cohort) {
  const BASE = 'https://founderssprint.co';
  const trackLabel = { group: 'Group', oneOnOne: '1-on-1', vip: 'VIP Leadership', vip1on1: 'VIP Leadership', single: '1-on-1 Session', pick3: 'Pick 3 Bundle', cohort: 'Full Cohort' }[reg.track] || reg.track;
  const cohortMeta = cohort ? `<div style="font-family:'Inter',Arial,sans-serif;font-size:13px;color:#5A564F;margin-top:5px;">${cohort.name} · ${cohort.dates || `${cohort.start_date} – ${cohort.end_date}`}</div>` : '';

  // Primary CTA button (bulletproof-ish: bgcolor on the cell renders in Outlook too). Sharp corners per brand.
  const btn = (label, href, bg = '#C8531F', fg = '#EFE7D8') =>
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:2px 0 0;"><tr><td bgcolor="${bg}"><a href="${href}" style="display:inline-block;font-family:'Josefin Sans',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${fg};text-decoration:none;padding:14px 26px;">${label}</a></td></tr></table>`;

  const sectionEyebrow = (text, color) =>
    `<div style="font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:${color};margin-bottom:12px;">${text}</div>`;

  const disciplines = [
    ['Marketing &amp; Branding',   '#C8531F', 'Position, message, and go to market.',            BASE + '/method/marketing.html'],
    ['Financial Modelling',        '#C9923A', 'Unit economics and the numbers that raise.',      BASE + '/method/finance.html'],
    ['Investment Readiness',       '#8AAB5C', 'Pitch, data room, and fundraising strategy.',     BASE + '/method/investment.html'],
    ['Strategy &amp; Team Building','#3D4A2E', 'Org design, competitive strategy, team plan.',    BASE + '/method/strategy.html'],
    ['Product Dev &amp; Pricing',  '#8C8C84', 'Roadmap, product-market fit, and pricing.',       BASE + '/method/product.html'],
  ].map(([name, color, blurb, href]) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="16" valign="top" style="width:16px;padding:11px 0 0;"><div style="width:9px;height:9px;background:${color};border-radius:50%;line-height:9px;font-size:0;">&nbsp;</div></td>
      <td style="padding:9px 0 10px 12px;border-bottom:1px solid rgba(239,231,216,0.12);">
        <a href="${href}" style="font-family:'Josefin Sans',Arial,sans-serif;font-size:14px;font-weight:600;color:#EFE7D8;text-decoration:none;">${name}</a>
        <div style="font-family:'Inter',Arial,sans-serif;font-size:12.5px;line-height:1.5;color:rgba(239,231,216,0.55);margin-top:2px;">${blurb}</div>
      </td>
    </tr></table>`).join('');

  const products = [
    ['One-on-One',     'UGX 500K', 'One specialty · one 2-hour 1:1 deep-dive.',        BASE + '/book/?tier=single'],
    ['Pick 3 Bundle',  'UGX 1M',   'Any three specialties — save roughly a third.',    BASE + '/book/?tier=pick3'],
    ['Full Cohort',    'UGX 2.5M', 'All five disciplines · 5 weeks · 12 founders.',     BASE + '/book/?tier=cohort'],
    ['VIP Leadership', 'UGX 5M',   'Private, for your whole leadership team.',          BASE + '/book/?tier=vip1on1'],
  ].map(([name, price, note, href]) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="fsp" style="background:#EFE7D8;border-radius:0 0 16px 0;margin:0 0 12px;">
      <tr><td style="height:3px;line-height:3px;font-size:0;background:#C8531F;">&nbsp;</td></tr>
      <tr><td style="padding:14px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-family:'Josefin Sans',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#1A1A1A;">${name}</td>
          <td align="right" style="font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;color:#1A1A1A;white-space:nowrap;">${price}</td>
        </tr></table>
        <div style="font-family:'Inter',Arial,sans-serif;font-size:12.5px;color:#5A564F;margin:4px 0 10px;">${note}</div>
        <a href="${href}" style="font-family:'Josefin Sans',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#9A3E16;text-decoration:none;">Reserve &rarr;</a>
      </td></tr>
    </table>`).join('');

  const heroConstellation = `<svg width="600" height="150" viewBox="0 0 600 150" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:auto;">
    <line x1="60" y1="40" x2="180" y2="96" stroke="#c8531f" stroke-width="0.6" opacity="0.4"/>
    <line x1="180" y1="96" x2="300" y2="54" stroke="#c9923a" stroke-width="0.5" opacity="0.35"/>
    <line x1="300" y1="54" x2="430" y2="110" stroke="#8aab5c" stroke-width="0.5" opacity="0.3"/>
    <line x1="430" y1="110" x2="545" y2="60" stroke="#3d4a2e" stroke-width="0.5" opacity="0.35"/>
    <circle cx="60" cy="40" r="3" fill="#c8531f" opacity="0.6"/><circle cx="60" cy="40" r="7" fill="#c8531f" opacity="0.1"/>
    <circle cx="180" cy="96" r="3.5" fill="#c9923a" opacity="0.55"/><circle cx="180" cy="96" r="8" fill="#c9923a" opacity="0.09"/>
    <circle cx="300" cy="54" r="2.5" fill="#8aab5c" opacity="0.5"/><circle cx="300" cy="54" r="6" fill="#8aab5c" opacity="0.09"/>
    <circle cx="430" cy="110" r="4" fill="#3d4a2e" opacity="0.5"/><circle cx="430" cy="110" r="9" fill="#3d4a2e" opacity="0.09"/>
    <circle cx="545" cy="60" r="3" fill="#777770" opacity="0.5"/><circle cx="545" cy="60" r="7" fill="#777770" opacity="0.08"/></svg>`;

  const markSm = `<svg width="11" height="11" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;">
    <polygon points="50,8 57,50 50,92 43,50" fill="#C8531F" opacity="0.9"/><polygon points="50,8 57,50 50,92 43,50" fill="#C8531F" opacity="0.55" transform="rotate(72 50 50)"/><polygon points="50,8 57,50 50,92 43,50" fill="#C8531F" opacity="0.5" transform="rotate(144 50 50)"/><polygon points="50,8 57,50 50,92 43,50" fill="#C8531F" opacity="0.55" transform="rotate(216 50 50)"/><polygon points="50,8 57,50 50,92 43,50" fill="#C8531F" opacity="0.5" transform="rotate(288 50 50)"/></svg>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Josefin+Sans:wght@300;400;600;700&family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400;1,600&family=Inter:wght@400;500;600&display=swap');
    :root{color-scheme:light dark;supported-color-schemes:light dark;}
    body{margin:0;padding:0;} a{text-decoration:none;}
    @media (max-width:600px){ .fs-pad{padding-left:24px!important;padding-right:24px!important;} .fs-hh{font-size:34px!important;} }
    /* Apple Mail (macOS) dark mode muddies light backgrounds — re-assert the brand paper tones. */
    @media (prefers-color-scheme: dark){
      .fsp{background:#EFE7D8!important;} .fspd{background:#E6DCC7!important;}
      .t-ink{color:#1A1A1A!important;} .t-body{color:#2A2826!important;} .t-mute{color:#5A564F!important;}
    }
  </style></head>
  <body style="margin:0;padding:0;background:#0f0d0a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f0d0a;"><tr><td align="center" style="padding:0;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">

      <tr><td style="background:#0f0d0a;padding:8px 0 0;">${heroConstellation}</td></tr>
      <tr><td style="background:#0f0d0a;padding:6px 44px 44px;" class="fs-pad">
        <div style="font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:3.5px;text-transform:uppercase;color:#C8531F;margin-bottom:22px;">${markSm}&nbsp;&nbsp;Booking&nbsp;reserved</div>
        <div class="fs-hh" style="font-family:'Josefin Sans',Arial,sans-serif;font-weight:300;font-size:46px;line-height:1.05;letter-spacing:-0.03em;color:#EFE7D8;">Your place is <span style="color:#C8531F;font-weight:400;">reserved</span>.</div>
        <div style="font-family:'Inter',Arial,sans-serif;font-size:15px;line-height:1.6;color:rgba(239,231,216,0.62);max-width:46ch;margin-top:18px;">We've saved your ${trackLabel} to your account — no payment today. When booking opens, we'll email you to complete it.</div>
        <div style="width:80px;height:1px;background:#C8531F;margin:26px 0 22px;"></div>
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-size:18px;color:#C8531F;">Build with direction.</div>
      </td></tr>

      <tr><td style="background:#EFE7D8;padding:36px 44px 30px;" class="fs-pad fsp">
        <p style="margin:0 0 16px;font-family:'Inter',Arial,sans-serif;font-size:15px;line-height:1.7;color:#2A2826;" class="t-body">Hi ${reg.first_name},</p>
        <p style="margin:0 0 22px;font-family:'Inter',Arial,sans-serif;font-size:15px;line-height:1.7;color:#2A2826;" class="t-body">Thanks for reserving your <strong style="color:#1A1A1A">${trackLabel}</strong> place — it's saved to your account, and <strong style="color:#1A1A1A">you haven't been charged anything today.</strong></p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="fspd" style="background:#E6DCC7;border-radius:0 0 20px 0;margin:0 0 22px;">
          <tr><td style="height:3px;line-height:3px;font-size:0;background:#C8531F;">&nbsp;</td></tr>
          <tr><td style="padding:16px 22px;">
            <div style="font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#5A564F;margin-bottom:6px;">Your booking</div>
            <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;color:#1A1A1A;">${trackLabel} · Booking #${reg.id}</div>
            ${cohortMeta}
          </td></tr>
        </table>
        <p style="margin:0 0 22px;font-family:'Inter',Arial,sans-serif;font-size:15px;line-height:1.7;color:#2A2826;">We're finalising secure mobile-money payments. The moment booking opens, we'll email you to pay your <strong style="color:#1A1A1A">10% deposit (${fmt(reg.deposit_amount)})</strong> and lock in your spot. Log in any time to explore your dashboard — and just reply here with any feedback.</p>
        ${btn('Go to your dashboard', BASE + '/login-founder.html')}
      </td></tr>

      <tr><td style="background:#171310;padding:34px 44px;" class="fs-pad">
        ${sectionEyebrow('The method', '#C8531F')}
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-size:27px;line-height:1.2;color:#EFE7D8;margin-bottom:6px;">Five coaches. Five disciplines.</div>
        <p style="margin:0 0 18px;font-family:'Inter',Arial,sans-serif;font-size:14px;line-height:1.6;color:rgba(239,231,216,0.6);">Forty-nine specialties across the five disciplines every founder has to master. Explore what each one covers.</p>
        ${disciplines}
        <div style="margin-top:20px;">${btn('Explore the method', BASE + '/index.html#method')}</div>
      </td></tr>

      <tr><td style="background:#E6DCC7;padding:34px 44px;" class="fs-pad fspd">
        ${sectionEyebrow('Ways in', '#9A3E16')}
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-size:27px;line-height:1.2;color:#1A1A1A;margin-bottom:6px;">Start where you are.</div>
        <p style="margin:0 0 20px;font-family:'Inter',Arial,sans-serif;font-size:14px;line-height:1.6;color:#5A564F;">One session to solve a specific problem, or the full cohort to build an investor-ready foundation. Every booking reserves with a 10% deposit.</p>
        ${products}
        <div style="margin-top:16px;">${btn('See full pricing', BASE + '/pricing.html')}</div>
      </td></tr>

      <tr><td style="background:#0f0d0a;padding:34px 44px;" class="fs-pad">
        ${sectionEyebrow('Beyond the curriculum', '#C9923A')}
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-size:26px;line-height:1.22;color:#EFE7D8;margin-bottom:10px;">Need an operator, not a curriculum?</div>
        <p style="margin:0 0 8px;font-family:'Inter',Arial,sans-serif;font-size:14px;line-height:1.65;color:rgba(239,231,216,0.62);">Sit down with a mentor who's built, scaled, and exited — over coffee in Kampala or on a Zoom. Or find a vetted service provider to get the work done.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr>
          <td style="padding-right:10px;">${btn('Meet the mentors', BASE + '/mentors.html', '#C8531F', '#EFE7D8')}</td>
          <td>${btn('Find a provider', BASE + '/directory.html', '#2A2826', '#EFE7D8')}</td>
        </tr></table>
      </td></tr>

      <tr><td style="background:#1A1A1A;padding:22px 44px;" class="fs-pad">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="middle" style="font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2.5px;color:rgba(239,231,216,0.6);">THE&nbsp;FOUNDER'S&nbsp;SPRINT&nbsp;·&nbsp;KAMPALA</td>
          <td valign="middle" align="right" style="font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-size:15px;color:#C8531F;">Build with direction.</td>
        </tr></table>
        <div style="margin-top:8px;font-family:'Inter',Arial,sans-serif;font-size:11px;color:rgba(239,231,216,0.4);">You're receiving this because you reserved a place at The Founder's Sprint. Reply any time — <a href="mailto:${ADMIN_EMAIL}" style="color:rgba(239,231,216,0.6);">${ADMIN_EMAIL}</a></div>
      </td></tr>

    </table>
  </td></tr></table></body></html>`;
  return sendEmail({
    to:             reg.email,
    subject:        `Your place is reserved · The Founder's Sprint`,
    html,
    registrationId: reg.id,
    template:       'reservation_preview',
  });
}

// ── Admin new-registration notification (brand shell, ochre = ops accent) ─────
async function sendNewRegistrationAdmin(reg, cohort, isPreview = false) {
  const trackLabel = { group: 'Group', oneOnOne: '1-on-1', vip: 'VIP Leadership', vip1on1: 'VIP Leadership', single: '1-on-1 Session', pick3: 'Pick 3 Bundle', cohort: 'Full Cohort' }[reg.track] || reg.track;
  // Accurate context (fixes the old "VIP 1-on-1 (no cohort)" mislabel for standalone tracks).
  const cohortCtx    = cohort ? cohort.name : null;
  const subjectCtx   = cohortCtx || `${trackLabel} · no cohort`;
  const contextLine  = cohortCtx ? `Cohort: ${cohortCtx}` : `Standalone ${trackLabel} — not cohort-bound`;

  const rows = [
    ['Name',             `${reg.first_name} ${reg.last_name}`],
    ['Email',            `<a href="mailto:${reg.email}" style="color:#9A3E16">${reg.email}</a>`],
    ['Phone / WhatsApp', reg.phone || '—'],
    ['Business',         reg.company || '—'],
    ['Track',            trackLabel],
    ['Full fee',         fmt(reg.full_fee)],
    ['Deposit due',      `<strong style="color:#1A1A1A">${fmt(reg.deposit_amount)}</strong>`],
    ['Booking ID',       `#${reg.id}`],
  ];
  const tableRows = rows.map((r, i) =>
    `<tr class="${i % 2 ? 'fsp' : 'fspd'}" style="background:${i % 2 ? '#EFE7D8' : '#E6DCC7'}">
      <td style="padding:10px 14px;font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#5A564F;white-space:nowrap;">${r[0]}</td>
      <td style="padding:10px 14px;font-family:'Inter',Arial,sans-serif;font-size:14px;color:#1A1A1A;">${r[1]}</td>
    </tr>`).join('');

  const bodyHtml = `
    <p style="margin:0 0 18px;font-family:'Inter',Arial,sans-serif;font-size:13px;color:#5A564F;">${contextLine}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:0 0 18px 0;overflow:hidden;">${tableRows}</table>
    <p style="margin:20px 0 0;font-family:'Inter',Arial,sans-serif;font-size:13px;line-height:1.6;color:#5A564F;">${isPreview
      ? 'Preview interest booking — no payment expected. When booking opens, the founder is emailed to pay their deposit.'
      : 'Once payment arrives, mark the deposit received via the admin console.'}</p>`;

  const html = fsEmailShell({
    accent: '#C9923A',                       // ochre — the ops/Command-Centre accent
    eyebrow: isPreview ? 'Preview · interest · no payment' : trackLabel,
    eyebrowBg: 'rgba(201,146,58,0.16)', eyebrowColor: '#8A6420',
    headline: isPreview ? 'New reserved booking.' : 'New registration.',
    bodyHtml,
  });

  return sendEmail({
    to:             ADMIN_EMAIL,
    subject:        `${isPreview ? 'Reserved' : 'New'} ${trackLabel} ${isPreview ? 'booking' : 'registration'}: ${reg.first_name} ${reg.last_name} · ${subjectCtx}`,
    html,
    registrationId: reg.id,
    template:       'admin_new_registration',
  });
}

// ── Reminders ─────────────────────────────────────────────────────────────────
async function sendReminder14d(reg, cohort) {
  const dates = cohort.dates || `${cohort.start_date} – ${cohort.end_date}`;
  const html = balanceReminderHtml(reg, cohort, {
    eyebrow:  '14 days to go',
    headline: `Two weeks to ${cohort.name}.`,
    urgent:   false,
    leadPara: `Your programme runs ${dates}. A friendly reminder that your balance is due before Day 1 — settling it early locks in your place.`,
  });
  return sendEmail({ to: reg.email, subject: `14 days to go · Balance due soon · ${cohort.name}`, html, template: 'reminder_14d', registrationId: reg.id });
}

async function sendReminder7d(reg, cohort) {
  const dates = cohort.dates || `${cohort.start_date} – ${cohort.end_date}`;
  const html = balanceReminderHtml(reg, cohort, {
    eyebrow:  'One week away',
    headline: `${cohort.name} starts in a week.`,
    urgent:   false,
    leadPara: `You're on the roster for ${dates}. Please complete your balance so your seat is fully secured before we open the materials.`,
  });
  return sendEmail({ to: reg.email, subject: `One week away · ${cohort.name} · The Founder's Sprint`, html, template: 'reminder_7d', registrationId: reg.id });
}

async function sendReminder96h(reg, cohort) {
  const html = balanceReminderHtml(reg, cohort, {
    eyebrow:  '96 hours left',
    headline: `Four days to ${cohort.name}.`,
    urgent:   true,
    leadPara: `${cohort.name} begins ${cohort.start_date}. Your balance must be settled to keep your place — here's how to pay.`,
  });
  return sendEmail({ to: reg.email, subject: `96 hours left to pay your balance · ${cohort.name}`, html, template: 'reminder_96h', registrationId: reg.id });
}

// ── Auto-move / forfeit ───────────────────────────────────────────────────────
async function sendMovedNotification(reg, oldCohort, newCohort) {
  const BASE = 'https://founderssprint.co';
  const newDates = newCohort.dates || `${newCohort.start_date} – ${newCohort.end_date}`;
  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${reg.first_name},</p>
    <p style="margin:0 0 22px;">Everything you've paid has been carried over to the next cohort — your place is held and nothing is lost.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="fspd" style="background:#E6DCC7;border-radius:0 0 20px 0;margin:0 0 22px;">
      <tr><td style="height:3px;line-height:3px;font-size:0;background:#C8531F;">&nbsp;</td></tr>
      <tr><td style="padding:16px 22px;">
        <div style="font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#5A564F;margin-bottom:6px;">Your new cohort</div>
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;color:#1A1A1A;">${newCohort.name}</div>
        <div style="font-family:'Inter',Arial,sans-serif;font-size:13px;color:#5A564F;margin-top:4px;">${newDates}</div>
      </td></tr>
    </table>
    <p style="margin:0 0 22px;">Your balance of <strong style="color:#1A1A1A">${fmt(reg.balance_amount)}</strong> is now due before the new start date — you'll get a reminder in good time. Everything already paid stays credited.</p>
    ${emailBtn('Go to your dashboard', BASE + '/login-founder.html')}
  `;
  const html = fsEmailShell({ eyebrow: 'Moved to the next cohort', headline: `You're rolled into ${newCohort.name}.`, bodyHtml });
  return sendEmail({ to: reg.email, subject: `Your place has moved to ${newCohort.name} · The Founder's Sprint`, html, template: 'moved', registrationId: reg.id });
}

async function sendForfeitNotification(reg, cohort) {
  const BASE = 'https://founderssprint.co';
  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${reg.first_name},</p>
    <p style="margin:0 0 20px;">The balance for <strong style="color:#1A1A1A">${cohort.name}</strong> wasn't completed by the deadline and we weren't able to reach you, so your seat has been released. As agreed at booking, the 10% deposit (${fmt(reg.deposit_amount)}) is non-refundable.</p>
    <p style="margin:0 0 22px;">We'd still love to have you — you can book any upcoming cohort whenever you're ready.</p>
    ${emailBtn('See upcoming cohorts', BASE + '/pricing.html')}
  `;
  const html = fsEmailShell({ accent: '#9A3E16', eyebrow: 'Booking closed', eyebrowColor: '#9A3E16', headline: 'Your seat has been released.', bodyHtml });
  return sendEmail({ to: reg.email, subject: `Your booking for ${cohort.name} has closed · The Founder's Sprint`, html, template: 'forfeited', registrationId: reg.id });
}

// ── Balance grace — the founder's roll-vs-refund choice email ─────────────────
async function sendBalanceGraceChoice(reg, cohort, nextCohort, choiceUrl, deadline) {
  const deadlineStr = new Date(deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const deposit     = Number(reg.deposit_amount || 0);
  const paid        = Number(reg.amount_paid || 0);
  const refundable  = Math.max(0, paid - deposit);
  const nextDates   = nextCohort ? (nextCohort.dates || `${nextCohort.start_date} – ${nextCohort.end_date}`) : null;

  const optionCard = (tag, title, blurb, btnHtml, accent) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="fspd" style="background:#E6DCC7;border-radius:0 0 18px 0;margin:0 0 14px;">
      <tr><td style="height:3px;line-height:3px;font-size:0;background:${accent};">&nbsp;</td></tr>
      <tr><td style="padding:16px 20px;">
        <div style="font-family:'Josefin Sans',Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${accent};margin-bottom:6px;">${tag}</div>
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:21px;color:#1A1A1A;margin-bottom:6px;">${title}</div>
        <p style="margin:0 0 12px;font-family:'Inter',Arial,sans-serif;font-size:13.5px;line-height:1.6;color:#2A2826;">${blurb}</p>
        ${btnHtml}
      </td></tr>
    </table>`;

  const rollCard = nextCohort ? optionCard(
    'Option 1 · Recommended',
    `Roll to ${nextCohort.name}`,
    `Keep your place and carry your full <strong style="color:#1A1A1A">${fmt(paid)}</strong> paid over to the next cohort (${nextDates}). Nothing lost — just a later start.`,
    emailBtn('Roll to the next cohort', `${choiceUrl}&choice=roll`),
    '#C8531F') : '';

  const refundCard = optionCard(
    nextCohort ? 'Option 2' : 'Your options',
    'Request a refund',
    `We'll refund <strong style="color:#1A1A1A">${refundable > 0 ? fmt(refundable) : 'any amount paid above the deposit'}</strong> — the 10% deposit (${fmt(deposit)}) is non-refundable, as agreed at booking.`,
    emailBtn('Request a refund', `${choiceUrl}&choice=refund`, '#2A2826'),
    '#9A3E16');

  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${reg.first_name},</p>
    <p style="margin:0 0 22px;">We didn't receive the balance for <strong style="color:#1A1A1A">${cohort.name}</strong> by the deadline, so we've <strong style="color:#1A1A1A">held your place instead of cancelling it</strong>. Choose how you'd like to proceed by <strong style="color:#1A1A1A">${deadlineStr}</strong>:</p>
    ${rollCard}
    ${refundCard}
    <p style="margin:14px 0 0;font-family:'Inter',Arial,sans-serif;font-size:13px;line-height:1.6;color:#5A564F;">If we don't hear from you by ${deadlineStr}, we'll ${nextCohort ? `roll everything to ${nextCohort.name} automatically` : 'hold your credit and be in touch'} — you won't lose what you've paid.</p>
  `;
  const html = fsEmailShell({ eyebrow: 'A quick decision needed', headline: `Your ${cohort.name} balance is outstanding.`, bodyHtml });
  return sendEmail({ to: reg.email, subject: `Action needed · your ${cohort.name} place · The Founder's Sprint`, html, template: 'balance_grace_choice', registrationId: reg.id });
}

// ── Refund acknowledgement (founder) ─────────────────────────────────────────
async function sendRefundRequestedFounder(reg, refundAmount) {
  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${reg.first_name},</p>
    <p style="margin:0 0 22px;">${refundAmount > 0
      ? `We've logged your refund request for <strong style="color:#1A1A1A">${fmt(refundAmount)}</strong>. Our team will process it to your original payment method within a few business days.`
      : `We've released your place. As agreed at booking the 10% deposit is non-refundable, so there's no refundable balance on your booking — but you're welcome back for any upcoming cohort.`}</p>
    <p style="margin:0;">Any questions, just reply to this email.<br>— Teddy</p>
  `;
  const html = fsEmailShell({ accent: '#9A3E16', eyebrow: 'Refund request received', eyebrowColor: '#9A3E16', headline: "We've got your request.", bodyHtml });
  return sendEmail({ to: reg.email, subject: `Your refund request · The Founder's Sprint`, html, template: 'refund_requested', registrationId: reg.id });
}

// ── Refund to process (ops alert — money is issued by finance, not the system) ─
async function sendRefundOpsAlert(reg, cohort, refundAmount) {
  const row = (k, v) => `<tr><td style="padding:6px 0;font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#5A564F;">${k}</td><td align="right" style="padding:6px 0;font-family:'Inter',Arial,sans-serif;font-size:14px;color:#1A1A1A;">${v}</td></tr>`;
  const bodyHtml = `
    <p style="margin:0 0 18px;">A founder chose a refund. Issue it through the payment provider, then mark it paid in the Command Centre.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="fspd" style="background:#E6DCC7;border-radius:0 0 18px 0;margin:0 0 18px;">
      <tr><td style="height:3px;line-height:3px;font-size:0;background:#C9923A;">&nbsp;</td></tr>
      <tr><td style="padding:14px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${row('Founder', `${reg.first_name} ${reg.last_name}`)}
        ${row('Email', reg.email)}
        ${row('Phone', reg.phone || '—')}
        ${row('Cohort', cohort ? cohort.name : '—')}
        ${row('Booking', `#${reg.id} · ${reg.track}`)}
        ${row('Total paid', fmt(reg.amount_paid || 0))}
        ${row('Deposit (retained)', fmt(reg.deposit_amount || 0))}
        ${row('<strong>Refund to issue</strong>', `<strong>${fmt(refundAmount)}</strong>`)}
      </table></td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#5A564F;">Send to the founder's MTN/Airtel number on file, then update the refund status.</p>
  `;
  const html = fsEmailShell({ accent: '#C9923A', eyebrow: 'Refund to process', eyebrowColor: '#8A6D1F', eyebrowBg: 'rgba(201,146,58,0.18)', headline: 'A refund needs issuing.', bodyHtml });
  return sendEmail({ to: ADMIN_EMAIL, subject: `Refund to issue · ${fmt(refundAmount)} · ${reg.first_name} ${reg.last_name}`, html, template: 'refund_ops_alert' });
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

  const BASE = 'https://founderssprint.co';
  const bodyHtml = `
    <p style="margin:0 0 20px;">Hi ${reg.first_name},</p>
    <p style="margin:0 0 20px;">We've received your ${isDeposit ? 'deposit' : 'full balance'} — your place is ${isDeposit ? 'secured' : 'fully confirmed'}.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="fspd" style="background:#E6DCC7;border-radius:0 0 20px 0;margin:0 0 22px;">
      <tr><td style="height:3px;line-height:3px;font-size:0;background:#8AAB5C;">&nbsp;</td></tr>
      <tr><td style="padding:20px 22px;text-align:center;">
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:38px;color:#1A1A1A;line-height:1;">${fmt(amount)}</div>
        <div style="font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#3D4A2E;margin-top:8px;">${isDeposit ? 'Deposit received' : 'Balance received — fully paid'}</div>
      </td></tr>
    </table>
    ${isDeposit
      ? `<p style="margin:0 0 22px;">Your balance of <strong style="color:#1A1A1A">${fmt(reg.balance_amount)}</strong> is due before Day 1 of ${cohort.name}. We'll remind you closer to the date.</p>`
      : `<p style="margin:0 0 22px;">You're fully paid up — nothing else owed. Your session details and materials will arrive two days before you start.</p>`}
    ${emailBtn('Go to your dashboard', BASE + '/login-founder.html')}
  `;
  const html = fsEmailShell({
    accent:       '#8AAB5C',
    eyebrow:      isDeposit ? 'Deposit received' : 'Payment complete',
    eyebrowColor: '#3D4A2E',
    eyebrowBg:    'rgba(138,171,92,0.18)',
    headline:     isDeposit ? 'Your place is secured.' : `You're fully paid, ${reg.first_name}.`,
    bodyHtml,
  });
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

  const html = balanceReminderHtml(reg, cohort, {
    eyebrow:  urgent ? 'Balance due in 48 hours' : 'Balance due in 1 week',
    headline: urgent ? `Final call for ${cohort.name}.` : `${cohort.name} balance due soon.`,
    urgent,
    leadPara: `Your balance for <strong style="color:#1A1A1A">${cohort.name}</strong> (starts ${cohort.start_date}) is due ${urgent ? 'within the next 48 hours' : 'in one week'}.`,
  });

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
  const BASE = 'https://founderssprint.co';
  const expiryStr = new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const trackLabel = { group:'Full Cohort', oneOnOne:'1-on-1 Session', vip:'VIP Leadership', vip1on1:'VIP Leadership', single:'1-on-1 Session', pick3:'Pick 3 Bundle', cohort:'Full Cohort' }[reg.track] || reg.track;

  const step = (n, text) => `<tr>
      <td width="26" valign="top" style="width:26px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="22" height="22" align="center" valign="middle" bgcolor="#C8531F" style="width:22px;height:22px;font-family:'Josefin Sans',Arial,sans-serif;font-size:11px;font-weight:700;color:#EFE7D8;">${n}</td></tr></table></td>
      <td style="padding:1px 0 12px 12px;font-family:'Inter',Arial,sans-serif;font-size:14px;line-height:1.55;color:#2A2826;">${text}</td>
    </tr>`;

  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${reg.first_name},</p>
    <p style="margin:0 0 22px;">You're fully paid and <strong style="color:#1A1A1A">${cohort.name}</strong> begins in <strong style="color:#1A1A1A">two days</strong>. Everything for your ${trackLabel} — your discipline decks, your scheduled sessions with their Google Meet links, prep materials, and your data room — is ready in your dashboard.</p>
    ${emailBtn('Open your dashboard', BASE + '/login-founder.html')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="fspd" style="background:#E6DCC7;border-radius:0 0 20px 0;margin:22px 0;">
      <tr><td style="height:3px;line-height:3px;font-size:0;background:#C8531F;">&nbsp;</td></tr>
      <tr><td style="padding:18px 22px 8px;">
        <div style="font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#5A564F;margin-bottom:14px;">How to log in</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${step(1, `Tap the button above, or go to <strong>founderssprint.co</strong> and choose <strong>Founder login</strong>.`)}
          ${step(2, `Sign in with your email — <strong>${reg.email}</strong> — and the password you set when you booked.`)}
          ${step(3, `Forgotten it? Use <strong>Reset password</strong> on the login page and we'll email you a link.`)}
          ${step(4, `Bookmark your dashboard — it's home for your sessions, materials, and data room.`)}
        </table>
      </td></tr>
    </table>
    <div style="font-family:'Josefin Sans',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#5A564F;margin:0 0 10px;">What's inside</div>
    <p style="margin:0 0 7px;"><strong style="color:#1A1A1A">Discipline decks</strong> — the teaching materials for every session you're enrolled in.</p>
    <p style="margin:0 0 7px;"><strong style="color:#1A1A1A">Your session schedule</strong> — each coaching session with its Google Meet link and prep notes.</p>
    <p style="margin:0 0 20px;"><strong style="color:#1A1A1A">Your data room</strong> — deliverables and templates that build into an investor-ready vault.</p>
    <p style="margin:0 0 20px;font-size:13px;color:#5A564F;">Your access runs through the end of your programme (${expiryStr}). Keep this email — you can log in any time.</p>
    <p style="margin:0;">See you on Day 1,<br>— Teddy</p>
  `;
  const html = fsEmailShell({
    eyebrow:  "You're fully paid",
    headline: `Your programme is ready, ${reg.first_name}.`,
    bodyHtml,
  });
  return sendEmail({
    to:             reg.email,
    subject:        `Your programme is ready · ${cohort.name} · The Founder's Sprint`,
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
      <a href="https://founderssprint.co/directory.html" style="color:#C8531F;text-decoration:none">View Directory</a> · <a href="mailto:hello@founderssprint.co" style="color:#C8531F;text-decoration:none">Contact Us</a>
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
  const renewUrl = `https://founderssprint.co/apply-directory.html`;

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
  const renewUrl = `https://founderssprint.co/apply-directory.html`;

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
  sendBalanceGraceChoice,
  sendRefundRequestedFounder,
  sendRefundOpsAlert,
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
