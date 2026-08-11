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
    ['Marketing &amp; Branding',   '#C8531F', 'Position, message, and go to market.',            BASE + '/beta/method/marketing.html'],
    ['Financial Modelling',        '#C9923A', 'Unit economics and the numbers that raise.',      BASE + '/beta/method/finance.html'],
    ['Investment Readiness',       '#8AAB5C', 'Pitch, data room, and fundraising strategy.',     BASE + '/beta/method/investment.html'],
    ['Strategy &amp; Team Building','#3D4A2E', 'Org design, competitive strategy, team plan.',    BASE + '/beta/method/strategy.html'],
    ['Product Dev &amp; Pricing',  '#8C8C84', 'Roadmap, product-market fit, and pricing.',       BASE + '/beta/method/product.html'],
  ].map(([name, color, blurb, href]) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="16" valign="top" style="width:16px;padding:11px 0 0;"><div style="width:9px;height:9px;background:${color};border-radius:50%;line-height:9px;font-size:0;">&nbsp;</div></td>
      <td style="padding:9px 0 10px 12px;border-bottom:1px solid rgba(239,231,216,0.12);">
        <a href="${href}" style="font-family:'Josefin Sans',Arial,sans-serif;font-size:14px;font-weight:600;color:#EFE7D8;text-decoration:none;">${name}</a>
        <div style="font-family:'Inter',Arial,sans-serif;font-size:12.5px;line-height:1.5;color:rgba(239,231,216,0.55);margin-top:2px;">${blurb}</div>
      </td>
    </tr></table>`).join('');

  const products = [
    ['One-on-One',     'UGX 500K', 'One specialty · one 2-hour 1:1 deep-dive.',        BASE + '/beta/book/?tier=single'],
    ['Pick 3 Bundle',  'UGX 1M',   'Any three specialties — save roughly a third.',    BASE + '/beta/book/?tier=pick3'],
    ['Full Cohort',    'UGX 2.5M', 'All five disciplines · 5 weeks · 12 founders.',     BASE + '/beta/book/?tier=cohort'],
    ['VIP Leadership', 'UGX 5M',   'Private, for your whole leadership team.',          BASE + '/beta/book/?tier=vip1on1'],
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
        ${btn('Go to your dashboard', BASE + '/beta/login-founder.html')}
      </td></tr>

      <tr><td style="background:#171310;padding:34px 44px;" class="fs-pad">
        ${sectionEyebrow('The method', '#C8531F')}
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-size:27px;line-height:1.2;color:#EFE7D8;margin-bottom:6px;">Five coaches. Five disciplines.</div>
        <p style="margin:0 0 18px;font-family:'Inter',Arial,sans-serif;font-size:14px;line-height:1.6;color:rgba(239,231,216,0.6);">Forty-nine specialties across the five disciplines every founder has to master. Explore what each one covers.</p>
        ${disciplines}
        <div style="margin-top:20px;">${btn('Explore the method', BASE + '/beta/index.html#method')}</div>
      </td></tr>

      <tr><td style="background:#E6DCC7;padding:34px 44px;" class="fs-pad fspd">
        ${sectionEyebrow('Ways in', '#9A3E16')}
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-size:27px;line-height:1.2;color:#1A1A1A;margin-bottom:6px;">Start where you are.</div>
        <p style="margin:0 0 20px;font-family:'Inter',Arial,sans-serif;font-size:14px;line-height:1.6;color:#5A564F;">One session to solve a specific problem, or the full cohort to build an investor-ready foundation. Every booking reserves with a 10% deposit.</p>
        ${products}
        <div style="margin-top:16px;">${btn('See full pricing', BASE + '/beta/pricing.html')}</div>
      </td></tr>

      <tr><td style="background:#0f0d0a;padding:34px 44px;" class="fs-pad">
        ${sectionEyebrow('Beyond the curriculum', '#C9923A')}
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-size:26px;line-height:1.22;color:#EFE7D8;margin-bottom:10px;">Need an operator, not a curriculum?</div>
        <p style="margin:0 0 8px;font-family:'Inter',Arial,sans-serif;font-size:14px;line-height:1.65;color:rgba(239,231,216,0.62);">Sit down with a mentor who's built, scaled, and exited — over coffee in Kampala or on a Zoom. Or find a vetted service provider to get the work done.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr>
          <td style="padding-right:10px;">${btn('Meet the mentors', BASE + '/mentors.html', '#C8531F', '#EFE7D8')}</td>
          <td>${btn('Find a provider', BASE + '/beta/directory.html', '#2A2826', '#EFE7D8')}</td>
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
