/**
 * ioTec Pay API client — verified against the official OpenAPI spec
 * (https://pay.iotec.io/swagger/v1/swagger.json — "ioTec Pay v1", OpenAPI 3.0.4).
 *
 * Endpoints (verified):
 *   Auth     POST https://id.iotec.io/connect/token        (form-urlencoded, client_credentials)
 *   Collect  POST https://pay.iotec.io/api/collections/collect
 *   Status   GET  https://pay.iotec.io/api/collections/status/{id}
 *
 * Environment variables (set in Vercel):
 *   IOTEC_CLIENT_ID, IOTEC_CLIENT_SECRET  — from id.iotec.io (your ioTec app)
 *   IOTEC_WALLET_ID                       — the wallet to credit (uuid, from the Pay portal)
 *   IOTEC_TOKEN_URL                       — default https://id.iotec.io/connect/token
 *   IOTEC_BASE_URL                        — default https://pay.iotec.io/api
 *   IOTEC_CALLBACK_SECRET                 — the STATIC value you set as the wallet's callback
 *                                           "Authentication header" in the ioTec portal.
 *
 * ⚠️ Callbacks are NOT cryptographically signed by ioTec (the spec has no HMAC/signature).
 *    ioTec only sends back the static security header you configured per-wallet, and the
 *    callback body is identical to the Get-Status response. So the secure pattern is:
 *      (1) verify the static header (verifyCallbackHeader), then
 *      (2) re-fetch the transaction with getTransaction() and trust THAT, not the POST body.
 *    The webhook handler must never credit a registration from the callback body alone.
 *
 * Payment flow:
 *   1. requestCollection() → STK push to the customer's MTN/Airtel phone
 *   2. customer enters their mobile money PIN
 *   3. ioTec POSTs the result to our callback URL (/api/iotec/webhook), configured in the portal
 *   4. webhook verifies the header, re-fetches status, and (if Success + amount matches) marks paid
 *   5. the 6-hourly reconcile cron is the safety net for any missed callback
 */

const crypto = require('crypto');

const TOKEN_URL = process.env.IOTEC_TOKEN_URL || 'https://id.iotec.io/connect/token';
const BASE_URL  = process.env.IOTEC_BASE_URL  || 'https://pay.iotec.io/api';

// In-memory token cache — ioTec tokens are short-lived (~5 min); refresh 30 s early.
let _tokenCache = null;

/** OAuth2 client-credentials token from id.iotec.io (form-urlencoded). */
async function getAccessToken() {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now) return _tokenCache.token;

  const clientId     = process.env.IOTEC_CLIENT_ID;
  const clientSecret = process.env.IOTEC_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('ioTec credentials not configured. Set IOTEC_CLIENT_ID and IOTEC_CLIENT_SECRET in Vercel env.');
  }

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`ioTec auth failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  _tokenCache = {
    token:     data.access_token,
    expiresAt: now + (((data.expires_in || 300) - 30) * 1000),
  };
  return _tokenCache.token;
}

/**
 * Map ioTec's RequestStatus enum → our internal status + whether it's terminal.
 * Verified enum: Pending, SentToVendor, Success, Failed, AwaitingApproval,
 *                RolledBack, Scheduled, Cancelled, Rejected.
 * Non-terminal states (Pending/SentToVendor/AwaitingApproval/Scheduled) must NOT
 * resolve a payment_request — ioTec sends a callback on SentToVendor too, and resolving
 * early would block the later Success via the idempotency guard.
 */
const TERMINAL = {
  Success:   'success',
  Failed:    'failed',
  Cancelled: 'cancelled',
  Rejected:  'failed',
  RolledBack:'failed',
};
function mapStatus(raw) {
  const internal = TERMINAL[raw];
  if (internal) return { internal, terminal: true };
  return { internal: 'pending', terminal: false };
}

/**
 * Request a mobile-money collection (STK push to the customer's phone).
 * @param {object} p
 * @param {string} p.phone       customer MSISDN (0XXXXXXXXX or 256XXXXXXXXX)
 * @param {number} p.amount      UGX integer, must be >= 500
 * @param {string} p.externalId  our reference (e.g. "FS-DEPOSIT-123"); ioTec does NOT
 *                               require it to be unique — we key on the returned `id`.
 * @param {string} [p.note]      short note shown to the payer (<=100 chars)
 * @returns {{ id:string, status:string, internal:string, statusMessage:string, raw:object }}
 */
async function requestCollection({ phone, amount, externalId, note }) {
  const token    = await getAccessToken();
  const walletId = process.env.IOTEC_WALLET_ID;
  if (!walletId) throw new Error('IOTEC_WALLET_ID not configured. Set it to your ioTec Pay collection wallet id.');

  const response = await fetch(`${BASE_URL}/collections/collect`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      category:  'MobileMoney',
      currency:  process.env.IOTEC_CURRENCY || 'UGX',   // set IOTEC_CURRENCY=ITX for the sandbox wallet; UGX for production
      walletId,
      externalId,
      payer:     normalisePhone(phone),
      payerNote: (note || '').slice(0, 100),
      amount,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`ioTec collection request failed (${response.status}): ${JSON.stringify(data)}`);
  }

  const { internal } = mapStatus(data.status);
  return {
    id:            data.id,            // ioTec's canonical transaction id (uuid)
    status:        data.status,        // RequestStatus enum (e.g. "Pending")
    internal,
    statusMessage: data.statusMessage || data.statusCode || 'Request is being processed',
    raw:           data,
  };
}

/**
 * Get the authoritative status of a transaction by ioTec's `id`.
 * This is the source of truth — the webhook re-fetches via this before crediting.
 * @returns {{ id, status, internal, terminal, amount, currency, raw }}
 */
async function getTransaction(id) {
  const token = await getAccessToken();
  const response = await fetch(`${BASE_URL}/collections/status/${encodeURIComponent(id)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`ioTec status check failed (${response.status}): ${JSON.stringify(data)}`);
  }
  const m = mapStatus(data.status);
  return {
    id:       data.id,
    status:   data.status,
    internal: m.internal,
    terminal: m.terminal,
    amount:   data.amount,
    currency: data.currency,
    raw:      data,
  };
}

/**
 * Verify an inbound ioTec callback's STATIC security header.
 * ioTec does NOT sign callbacks (no HMAC in the spec) — the only auth is the header
 * value you configured on the wallet's callback URL in the portal. Compare constant-time.
 * The caller MUST still re-fetch the transaction (getTransaction) and trust that, not the body.
 * @param {object} req  the Express request (uses req.headers)
 * @returns {boolean}
 */
function verifyCallbackHeader(req) {
  const secret = process.env.IOTEC_CALLBACK_SECRET;
  if (!secret) {
    // Fail CLOSED in production — never let an unauthenticated POST mark a payment.
    if (process.env.NODE_ENV === 'production') {
      console.error('[ioTec] IOTEC_CALLBACK_SECRET not set in production — rejecting callback');
      return false;
    }
    console.warn('[ioTec] IOTEC_CALLBACK_SECRET not set — skipping header check (non-production only)');
    return true;
  }
  const presented = String(req.headers['authorization'] || req.headers['x-callback-token'] || '')
    .replace(/^Bearer\s+/i, '');
  try {
    const a = Buffer.from(presented);
    const b = Buffer.from(secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Normalise a Ugandan phone to 256XXXXXXXXX. Accepts 0712…, +256712…, 256712…. */
function normalisePhone(phone) {
  if (!phone) throw new Error('Phone number is required');
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('256') && digits.length === 12) return digits;
  if (digits.startsWith('0')   && digits.length === 10) return '256' + digits.slice(1);
  if (digits.length === 9)                               return '256' + digits;
  return digits;
}

/** MTN vs Airtel from a normalised number (for payment instructions). */
function detectNetwork(phone) {
  const n = normalisePhone(phone);
  if (/^256(77|78|76|31|39)/.test(n)) return 'MTN';
  if (/^256(70|75|74|72|73)/.test(n)) return 'Airtel';
  return 'Unknown';
}

module.exports = {
  getAccessToken,
  requestCollection,
  getTransaction,
  // Back-compat alias: cron + any old callers that imported checkTransactionStatus
  checkTransactionStatus: getTransaction,
  verifyCallbackHeader,
  mapStatus,
  normalisePhone,
  detectNetwork,
};
