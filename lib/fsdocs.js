/**
 * The Founder's Sprint — invoice / receipt PDF renderer.
 *
 * A document is only ever a *rendering of a row* in `invoices`. Nothing is
 * stored: we generate on demand from the record, so a corrected bill-to or a
 * fixed line item propagates the next time the document is sent, and there is
 * no stale PDF in a bucket quietly disagreeing with the ledger.
 *
 * Brand: paper ground (#EFE7D8), V6 "Pentagonal Convergence" mark drawn as
 * vector geometry per DESIGN.md §4, ink blocks as the dark anchors.
 *
 * Coordinates here run TOP-DOWN (PDFKit's native origin), unlike the reference
 * Python renderer which ran bottom-up.
 */
const PDFDocument = require('pdfkit');

// ── Brand ────────────────────────────────────────────────────────────────────
const INK = '#1A1A1A';
const PAPER = '#EFE7D8';
const TERRA = '#C8531F';
const OCHRE = '#C9923A';
const MUTED = '#635C50';   // darkened for legibility on paper (4.9:1 at 8pt)
const RULE = '#BDB4A2';

const MM = 72 / 25.4;
const W = 595.28;          // A4
const H = 841.89;
const M = 20 * MM;
const MARK = 15 * MM;
const GUTTER = 7 * MM;

// V6 mark — five lozenges, 72° apart, one per discipline.
const V6_PETAL = [[50, 8], [57, 50], [50, 92], [43, 50]];
const V6_PETALS = [
  ['#C8531F', 0.85],  // Marketing & Branding
  ['#C9923A', 0.80],  // Financial Modelling
  ['#8AAB5C', 0.78],  // Investment Readiness
  ['#3D4A2E', 0.82],  // Strategy & Team
  ['#777770', 0.75],  // Product Dev & Pricing
];

const COMPANY = {
  name: "T H E   F O U N D E R ' S   S P R I N T",
  address: ['Plot 62 Kanjokya Street', '4th Floor, Kanjokya House', 'Kampala, Uganda'],
  ids: 'Reg. No. 80046655157080   ·   TIN 1059394544',
  contact: 'hello@founderssprint.co   ·   founderssprint.co',
};

// ── Formatting ───────────────────────────────────────────────────────────────
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function money(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

/** Dates on these documents are calendar facts, not instants — render the
 *  date component as written, never shifted by the server's timezone. */
function longDate(value) {
  if (!value) return '';
  const s = String(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function shortDate(value) {
  if (!value) return '';
  const s = String(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1].slice(0, 3)} ${m[1]}`;
}

// ── Primitives ───────────────────────────────────────────────────────────────
function paperGround(doc) {
  doc.save().rect(0, 0, W, H).fill(PAPER).restore();
}

/** Mark with its top-left at (x, y), drawn as real vector geometry so it stays
 *  sharp at any print size. onDark flips the centre circle / inner dot. */
function v6Mark(doc, x, y, size, onDark = false) {
  const s = size / 100;
  const pt = (px, py) => [x + px * s, y + py * s];

  V6_PETALS.forEach(([hex, alpha], i) => {
    const a = (i * 72) * Math.PI / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    doc.save().fillOpacity(alpha).fillColor(hex);
    V6_PETAL.forEach(([px, py], j) => {
      const dx = px - 50, dy = py - 50;
      const [rx, ry] = pt(50 + dx * cos - dy * sin, 50 + dx * sin + dy * cos);
      j === 0 ? doc.moveTo(rx, ry) : doc.lineTo(rx, ry);
    });
    doc.closePath().fill().restore();
  });

  const [cx, cy] = pt(50, 50);
  doc.save()
    .circle(cx, cy, 4.5 * s).fill(onDark ? PAPER : INK)
    .circle(cx, cy, 2 * s).fill(onDark ? INK : PAPER)
    .restore();
}

/** PDFKit places the TOP of a line at y. `lh` is the advance to the next line. */
function line(doc, str, x, y, { font = 'Helvetica', size = 9, color = INK, align, width } = {}) {
  doc.font(font).fontSize(size).fillColor(color);
  if (align === 'right') doc.text(str, x - (width || 260), y, { width: width || 260, align: 'right', lineBreak: false });
  else doc.text(str, x, y, { lineBreak: false });
}

function rule(doc, y, x0 = M, x1 = W - M, color = RULE, weight = 0.7) {
  doc.save().moveTo(x0, y).lineTo(x1, y).lineWidth(weight).stroke(color).restore();
}

function letterhead(doc, title, number, meta) {
  paperGround(doc);
  v6Mark(doc, M, M, MARK);

  const tx = M + MARK + GUTTER;
  let y = M;
  line(doc, COMPANY.name, tx, y, { font: 'Helvetica-Bold', size: 7, color: TERRA });
  y += 15;
  COMPANY.address.forEach(l => { line(doc, l, tx, y, { size: 8.5 }); y += 11; });
  line(doc, COMPANY.ids, tx, y, { size: 8, color: MUTED }); y += 11;
  line(doc, COMPANY.contact, tx, y, { size: 8, color: MUTED });
  const leftBottom = y + 11;

  let ry = M - 5;
  line(doc, title, W - M, ry, { font: 'Helvetica-Bold', size: 20, align: 'right' });
  ry += 24;
  line(doc, number, W - M, ry, { font: 'Helvetica-Bold', size: 11, color: TERRA, align: 'right' });
  ry += 15;
  meta.forEach(([label, val]) => {
    line(doc, `${label}  ${val}`, W - M, ry, { size: 8.5, color: MUTED, align: 'right' });
    ry += 11;
  });

  const y2 = Math.max(leftBottom, ry) + 14;
  rule(doc, y2);
  return y2 + 22;
}

function billTo(doc, y, inv) {
  line(doc, 'B I L L   T O', M, y, { font: 'Helvetica-Bold', size: 7, color: MUTED });
  y += 14;
  // A company is the correct bill-to for a B2B engagement; fall back to the
  // person only when we genuinely hold no company.
  line(doc, inv.bill_to_company || inv.bill_to_name || '—', M, y, { font: 'Helvetica-Bold', size: 11 });
  y += 13;
  if (inv.bill_to_company && inv.bill_to_name) {
    line(doc, `Attn: ${inv.bill_to_name}`, M, y, { size: 9 }); y += 12;
  }
  if (inv.bill_to_email) { line(doc, inv.bill_to_email, M, y, { size: 9, color: MUTED }); y += 12; }
  return y + 20;
}

function reference(doc, y, text) {
  if (!text) return y;
  line(doc, `Ref:  ${text}`, M, y, { size: 8, color: MUTED });
  return y + 18;
}

function footer(doc, note) {
  const fy = H - M - 30;
  rule(doc, fy, M, W - M, RULE, 0.5);
  line(doc, note, M, fy + 10, { size: 7.5, color: MUTED });
  line(doc, 'Queries: hello@founderssprint.co', M, fy + 20, { size: 7.5, color: MUTED });
  line(doc, 'Build with direction.', W - M, fy + 10,
    { font: 'Helvetica-Oblique', size: 7.5, color: TERRA, align: 'right' });
}

// ── Documents ────────────────────────────────────────────────────────────────
const CUR = inv => (inv.currency || 'UGX');

function renderInvoice(doc, inv) {
  const paid = Number(inv.amount_paid || 0);
  const total = Number(inv.total || 0);
  const due = total - paid;

  let y = letterhead(doc, 'INVOICE', inv.number, [
    ['Issued', longDate(inv.issued_at)],
    ['Status', due <= 0 ? 'Paid in full' : (paid > 0 ? 'Part paid' : 'Due')],
  ]);
  y = billTo(doc, y, inv);
  y = reference(doc, y, inv.reference_note);

  // Table header — an ink block, the dark anchor on the paper ground.
  doc.save().rect(M, y, W - 2 * M, 20).fill(INK).restore();
  line(doc, 'D E S C R I P T I O N', M + 8, y + 6, { font: 'Helvetica-Bold', size: 7, color: PAPER });
  line(doc, `A M O U N T   ( ${CUR(inv)} )`, W - M - 8, y + 6,
    { font: 'Helvetica-Bold', size: 7, color: PAPER, align: 'right' });
  y += 32;

  (inv.line_items || []).forEach(item => {
    line(doc, item.description || '', M + 8, y, { font: 'Helvetica-Bold', size: 10 });
    line(doc, money(item.amount), W - M - 8, y, { font: 'Helvetica-Bold', size: 10, align: 'right' });
    y += 14;
    if (item.detail) {
      // Split on sentence boundaries so a long detail wraps as written rather
      // than as a ragged paragraph.
      String(item.detail).split(/\.\s+/).filter(Boolean).forEach(part => {
        line(doc, part.replace(/\.$/, ''), M + 8, y, { size: 8.5, color: MUTED });
        y += 11;
      });
    }
    y += 6;
  });

  y += 4; rule(doc, y, M + 8, W - M - 8, RULE, 0.5); y += 16;

  const lx = W - M - 175;
  line(doc, 'Subtotal', lx, y, { size: 9, color: MUTED });
  line(doc, money(inv.subtotal ?? total), W - M - 8, y, { size: 9, align: 'right' }); y += 15;
  line(doc, 'VAT', lx, y, { size: 8, color: MUTED });
  line(doc, Number(inv.vat_amount || 0) > 0 ? money(inv.vat_amount) : 'Not applicable',
    W - M - 8, y, { size: 8, color: MUTED, align: 'right' }); y += 11;
  if (!Number(inv.vat_amount)) {
    line(doc, "The Founder's Sprint is not VAT-registered", lx, y,
      { font: 'Helvetica-Oblique', size: 7.5, color: MUTED });
    y += 14;
  }
  rule(doc, y, lx, W - M - 8, INK, 1); y += 8;
  line(doc, 'Total', lx, y, { font: 'Helvetica-Bold', size: 12 });
  line(doc, `${CUR(inv)} ${money(total)}`, W - M - 8, y, { font: 'Helvetica-Bold', size: 12, align: 'right' });
  y += 30;

  const payments = inv.payments || [];
  if (payments.length) {
    line(doc, 'P A Y M E N T S   R E C E I V E D', M, y, { font: 'Helvetica-Bold', size: 7, color: MUTED });
    y += 15;
    payments.forEach(p => {
      line(doc, shortDate(p.on), M, y, { size: 9, color: MUTED });
      line(doc, p.type === 'deposit' ? 'Deposit' : (p.label || 'Balance'), M + 75, y, { size: 9 });
      if (p.receipt) line(doc, p.receipt, M + 175, y, { size: 8, color: MUTED });
      line(doc, money(p.amount), W - M - 8, y, { size: 9, align: 'right' });
      y += 14;
    });
    y += 3; rule(doc, y, lx, W - M - 8, RULE, 0.5); y += 10;
    line(doc, 'Total paid', lx, y, { font: 'Helvetica-Bold', size: 10 });
    line(doc, `${CUR(inv)} ${money(paid)}`, W - M - 8, y, { font: 'Helvetica-Bold', size: 10, align: 'right' });
    y += 16;
    line(doc, 'Balance due', lx, y, { font: 'Helvetica-Bold', size: 10, color: TERRA });
    line(doc, due <= 0 ? 'NIL' : money(due), W - M - 8, y,
      { font: 'Helvetica-Bold', size: 10, color: TERRA, align: 'right' });
  }

  footer(doc, due <= 0
    ? 'Thank you — this invoice is settled in full. No payment is due.'
    : `Payable to The Founder's Sprint. Balance outstanding: ${CUR(inv)} ${money(due)}.`);
}

/**
 * How much had been paid against the invoice *as at this receipt* — not as at
 * today. A deposit receipt re-sent after the balance lands must still read
 * "balance outstanding", or it contradicts itself as a historical record.
 * Walks the invoice's payment list in order and stops at this receipt's payment.
 */
function paidThrough(parentInvoice, rcp) {
  const mine = (rcp.payments || [])[0] || {};
  let running = 0;
  for (const p of (parentInvoice.payments || [])) {
    running += Number(p.amount || 0);
    const sameReceipt = p.receipt && rcp.number && p.receipt === rcp.number;
    const samePayment = String(p.on) === String(mine.on) && Number(p.amount) === Number(mine.amount);
    if (sameReceipt || samePayment) return running;
  }
  // No match in the parent's list — fall back to the invoice's own tally rather
  // than reporting a balance we cannot substantiate.
  return Number(parentInvoice.amount_paid || 0);
}

function renderReceipt(doc, rcp, parentInvoice = null) {
  const amount = Number(rcp.total || rcp.amount_paid || 0);
  const kind = ((rcp.payments || [])[0] || {}).type === 'deposit' ? 'Deposit' : 'Balance';

  let y = letterhead(doc, 'RECEIPT', rcp.number, [
    ['Received', longDate(rcp.paid_on || rcp.issued_at)],
    ['Method', rcp.method === 'offline' ? 'Bank / mobile transfer' : (rcp.method || 'Mobile money')],
  ]);
  y = billTo(doc, y, rcp);
  y = reference(doc, y, rcp.reference_note);

  // The amount received is the whole point of a receipt — give it the ink block.
  doc.save().rect(M, y, W - 2 * M, 66).fill(INK).restore();
  line(doc, 'A M O U N T   R E C E I V E D', M + 14, y + 14,
    { font: 'Helvetica-Bold', size: 7, color: PAPER });
  line(doc, `${CUR(rcp)} ${money(amount)}`, M + 14, y + 30,
    { font: 'Helvetica-Bold', size: 26, color: PAPER });
  line(doc, kind, W - M - 14, y + 42, { size: 8.5, color: OCHRE, align: 'right' });
  y += 88;

  const item = (rcp.line_items || [])[0] || {};
  if (item.description) {
    line(doc, item.description, M, y, { font: 'Helvetica-Bold', size: 10 }); y += 20;
  }

  if (parentInvoice) {
    const invTotal = Number(parentInvoice.total || 0);
    const after = Math.max(0, invTotal - paidThrough(parentInvoice, rcp));
    line(doc, after === 0
      ? 'Account settled in full — nothing further is due.'
      : `Balance of ${CUR(rcp)} ${money(after)} remains outstanding.`, M, y, { size: 9 });
    y += 24;

    const lx = W - M - 175;
    line(doc, 'Invoice total', lx, y, { size: 9, color: MUTED });
    line(doc, money(invTotal), W - M - 8, y, { size: 9, align: 'right' }); y += 14;
    line(doc, 'This payment', lx, y, { size: 9, color: MUTED });
    line(doc, money(amount), W - M - 8, y, { size: 9, align: 'right' }); y += 14;
    line(doc, 'Outstanding after', lx, y, { size: 9, color: MUTED });
    line(doc, after === 0 ? 'NIL' : money(after), W - M - 8, y,
      { size: 9, color: after === 0 ? TERRA : INK, align: 'right' });
  }

  footer(doc, 'This receipt acknowledges the payment shown above.');
}

// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Render an `invoices` row to a PDF Buffer.
 * @param {object} row       the invoices row (doc_type drives the layout)
 * @param {object} [parent]  for receipts: the parent invoice, for the running balance
 * @returns {Promise<Buffer>}
 */
function renderDocument(row, parent = null) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0, info: {
        Title: `${row.doc_type === 'receipt' ? 'Receipt' : 'Invoice'} ${row.number} — The Founder's Sprint`,
        Author: "The Founder's Sprint",
      } });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      if (row.doc_type === 'receipt') renderReceipt(doc, row, parent);
      else renderInvoice(doc, row);

      doc.end();
    } catch (e) { reject(e); }
  });
}

function documentFilename(row) {
  // Numbers are already safe (FS-INV-0001), but never trust a DB string to
  // build a filename — a stray slash or quote lands in a mail header.
  const safe = String(row.number || 'document').replace(/[^A-Za-z0-9._-]/g, '');
  return `${safe}.pdf`;
}

module.exports = { renderDocument, documentFilename, COMPANY, INK, PAPER, TERRA, MUTED };
