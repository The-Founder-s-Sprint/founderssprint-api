/**
 * Server-side mirror of the L3 specialty taxonomy (founderssprint-site/beta/taxonomy.js).
 * Used to validate what a founder actually purchased at /api/register so a booking
 * can never claim a Pick-3 price for one session, or store bogus specialty slugs.
 *
 * KEEP IN SYNC with beta/taxonomy.js. 49 leaves:
 *   marketing 9 · finance 10 · investment 9 · strategy 11 · product 10
 */
const L3_SLUGS = [
  // Marketing & Branding (9)
  'brand-positioning', 'messaging-architecture', 'visual-identity', 'market-entry',
  'channel-mix', 'launch-sequencing', 'content-strategy', 'seo-and-discoverability',
  'customer-research',
  // Financial Modelling (10)
  'cac-and-ltv', 'payback-period', 'contribution-margin', 'revenue-forecasting',
  'burn-rate-and-runway', 'cash-flow-management', 'tax-and-compliance', 'valuation-methods',
  'cap-table-design', 'term-sheet-analysis',
  // Investment Readiness (9)
  'pitch-deck-structure', 'investor-narrative', 'executive-summary', 'investor-targeting',
  'due-diligence-prep', 'data-room', 'pre-seed-rounds', 'seed-rounds', 'grants-and-dfis',
  // Strategy & Team Building (11)
  'market-analysis', 'positioning-and-moats', 'scenario-planning', 'hiring-strategy',
  'culture-design', 'org-structure', 'payroll-and-hr-compliance', 'process-design',
  'okrs-and-kpis', 'decision-frameworks', 'legal-and-registration',
  // Product Dev & Pricing (10)
  'problem-validation', 'solution-testing', 'pmf-signals', 'mvp-design', 'roadmapping',
  'iteration-cycles', 'payments-and-mobile-money', 'value-based-pricing',
  'competitive-pricing', 'price-testing',
];

const L3_SET = new Set(L3_SLUGS);

// How many L3 specialties each track includes. cohort = the whole programme.
// vip1on1 is intentionally omitted: it's a bespoke premium package (all disciplines,
// private), not an à-la-carte specialty count — so no count is enforced for it.
const REQUIRED_COUNT = {
  single:  1,
  pick3:   3,
  cohort:  L3_SLUGS.length,
};

/**
 * Validate a purchase's specialty selection against its track.
 * Returns { ok:true, clean:[...] } or { ok:false, error }.
 * Dedupes + normalises slugs. Only enforced when specialties are supplied
 * (the legacy discipline-based register.html flow omits them).
 */
function validateSpecialties(track, specialties) {
  if (!Array.isArray(specialties)) {
    return { ok: false, error: 'enrolledSpecialties must be an array.' };
  }
  const clean = [...new Set(
    specialties.map(s => String(s || '').trim().toLowerCase()).filter(Boolean)
  )];
  const bad = clean.filter(s => !L3_SET.has(s));
  if (bad.length) {
    return { ok: false, error: `Unknown specialties: ${bad.slice(0, 5).join(', ')}` };
  }
  const need = REQUIRED_COUNT[track];
  if (need != null && clean.length !== need) {
    return {
      ok: false,
      error: `${track} requires exactly ${need} specialt${need === 1 ? 'y' : 'ies'}, got ${clean.length}.`,
    };
  }
  return { ok: true, clean };
}

module.exports = { L3_SLUGS, L3_SET, REQUIRED_COUNT, validateSpecialties };
