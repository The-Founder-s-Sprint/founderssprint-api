/**
 * ioTec Pay API Client
 * Docs: https://pay.iotec.io/api-docs/index.html
 *
 * Sign up at https://pay.iotec.io to get your Client ID and Client Secret.
 * Set these environment variables in Vercel:
 *   IOTEC_CLIENT_ID      — your ioTec Pay client ID
 *   IOTEC_CLIENT_SECRET  — your ioTec Pay client secret
 *   IOTEC_BASE_URL       — defaults to https://pay.iotec.io/api/v1
 *
 * Payment flow:
 *   1. requestCollection() → sends STK push to customer's phone
 *   2. Customer enters their mobile money PIN
 *   3. ioTec POSTs to our webhook URL (/api/iotec/webhook)
 *   4. Webhook marks the registration as paid
 */

const BASE_URL = process.env.IOTEC_BASE_URL || 'https://pay.iotec.io/api/v1';

// In-memory token cache — reuse until 60 s before expiry
let _tokenCache = null;

/**
 * Get a valid OAuth2 access token (client credentials grant).
 * Tokens are cached in-process and refreshed automatically.
 */
async function getAccessToken() {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now) {
    return _tokenCache.token;
  }

  const clientId     = process.env.IOTEC_CLIENT_ID;
  const clientSecret = process.env.IOTEC_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'ioTec credentials not configured. Set IOTEC_CLIENT_ID and IOTEC_CLIENT_SECRET in Vercel env.'
    );
  }

  const response = await fetch(`${BASE_URL}/oauth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ioTec auth failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  // Cache: expires_in is in seconds; back off by 60 s for safety
  _tokenCache = {
    token:     data.access_token,
    expiresAt: now + (data.expires_in - 60) * 1000,
  };

  return _tokenCache.token;
}

/**
 * Request a mobile money collection (STK push to customer's phone).
 *
 * @param {object} params
 * @param {string} params.phone        - Phone in international format: 256XXXXXXXXX
 * @param {number} params.amount       - Amount in UGX (integer)
 * @param {string} params.reference    - Your internal reference (e.g. "FS-DEP-123")
 * @param {string} params.description  - Description shown on the phone prompt
 * @param {string} params.callbackUrl  - Webhook URL ioTec will POST the result to
 * @returns {{ transactionId: string, status: string, message: string }}
 */
async function requestCollection({ phone, amount, reference, description, callbackUrl }) {
  const token = await getAccessToken();

  const response = await fetch(`${BASE_URL}/collections/request`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      phone_number: normalisePhone(phone),
      amount,
      currency:     'UGX',
      reference,
      description,
      callback_url: callbackUrl,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `ioTec collection request failed (${response.status}): ${JSON.stringify(data)}`
    );
  }

  return {
    transactionId: data.transaction_id || data.transactionId || data.id,
    status:        data.status || 'pending',
    message:       data.message || 'Payment request sent to phone.',
    raw:           data,
  };
}

/**
 * Check the status of a previously initiated transaction (optional polling fallback).
 *
 * @param {string} transactionId
 * @returns {{ status: string, raw: object }}
 */
async function checkTransactionStatus(transactionId) {
  const token = await getAccessToken();

  const response = await fetch(`${BASE_URL}/collections/${transactionId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `ioTec status check failed (${response.status}): ${JSON.stringify(data)}`
    );
  }

  return { status: data.status, raw: data };
}

/**
 * Verify a webhook signature from ioTec.
 * ioTec signs requests with HMAC-SHA256 using your IOTEC_WEBHOOK_SECRET.
 * The signature arrives in the X-Iotec-Signature header as "sha256=<hex>".
 *
 * @param {string} rawBody       - Raw request body string (before JSON.parse)
 * @param {string} signatureHeader - Value of X-Iotec-Signature header
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.IOTEC_WEBHOOK_SECRET;
  if (!secret) {
    // If no secret is configured, skip verification (not recommended for production)
    console.warn('[ioTec] IOTEC_WEBHOOK_SECRET not set — skipping signature verification');
    return true;
  }

  const crypto = require('crypto');
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(signatureHeader || '', 'utf8')
    );
  } catch {
    return false;
  }
}

/**
 * Normalise a Ugandan phone number to 256XXXXXXXXX format.
 * Accepts: 0712345678, +256712345678, 256712345678
 */
function normalisePhone(phone) {
  if (!phone) throw new Error('Phone number is required');
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('256') && digits.length === 12) return digits;
  if (digits.startsWith('0')   && digits.length === 10) return '256' + digits.slice(1);
  if (digits.length === 9)                               return '256' + digits;
  // Already correct or unknown — return as-is and let ioTec validate
  return digits;
}

/**
 * Determine if a normalised phone belongs to MTN or Airtel Uganda.
 * Useful for showing the right payment instructions in emails.
 */
function detectNetwork(phone) {
  const n = normalisePhone(phone);
  // MTN prefixes: 256 + 77x, 78x, 76x, 31x, 39x
  if (/^256(77|78|76|31|39)/.test(n)) return 'MTN';
  // Airtel prefixes: 256 + 70x, 75x, 74x, 72x, 73x
  if (/^256(70|75|74|72|73)/.test(n)) return 'Airtel';
  return 'Unknown';
}

module.exports = {
  getAccessToken,
  requestCollection,
  checkTransactionStatus,
  verifyWebhookSignature,
  normalisePhone,
  detectNetwork,
};
