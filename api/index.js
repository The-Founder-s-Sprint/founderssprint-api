const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const registerRoutes        = require('../routes/register');
const adminRoutes           = require('../routes/admin');
const cronRoutes            = require('../routes/cron');
const confirmPaymentRoutes  = require('../routes/confirm-payment');
const paymentRequestRoutes  = require('../routes/payment-request');
const iotecWebhookRoutes    = require('../routes/iotec-webhook');
const materialsRoutes       = require('../routes/materials');
const coachApplicationRoutes = require('../routes/coach-application');
const sessionRoutes           = require('../routes/sessions');
const presentationRoutes      = require('../routes/presentations');
const courseMaterialRoutes    = require('../routes/course-materials');
const waitlistRoutes          = require('../routes/waitlist');
const rsvpRoutes              = require('../routes/rsvp');
const directoryLifecycleRoutes = require('../routes/directory-lifecycle');
const staffRoutes              = require('../routes/staff');

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.ALLOWED_ORIGIN || 'https://tmsruge.com',
  'https://www.tmsruge.com',
  'https://founderssprint.co',
  'https://www.founderssprint.co',
  'https://learn.founderssprint.co',
  'https://api.founderssprint.co',
  'http://localhost:3000',
  'http://localhost:5500',
];

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (server-to-server, Vercel cron)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

// Capture the exact raw body so webhook HMAC signatures verify against the bytes
// the sender signed (re-stringifying the parsed body would not match).
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = (buf && buf.length) ? buf.toString('utf8') : ''; } }));

// ── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,   // revisit when dashboard moves to React
  crossOriginEmbedderPolicy: false,
}));

// ── Rate limiting ────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,           // 1 minute
  max: 100,                       // 100 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use(generalLimiter);

// Stricter limits on public-facing endpoints
const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment requests, please try again later.' },
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// ── Routes (strict rate limits on public endpoints) ──────────────────────────
app.use('/api/register',          strictLimiter);
app.use('/api/waitlist',          strictLimiter);
app.use('/api/rsvp',             strictLimiter);
app.use('/api/coach-application', strictLimiter);
app.use('/api/coach-upload',      strictLimiter);
app.use('/api/payment-request',   paymentLimiter);
app.use('/api/confirm-payment',   paymentLimiter);

app.use('/api',                   registerRoutes);
app.use('/api/admin',             adminRoutes);
app.use('/api/cron',              cronRoutes);
app.post('/api/confirm-payment',  confirmPaymentRoutes);
app.post('/api/payment-request',  paymentRequestRoutes);
app.post('/api/iotec/webhook',    iotecWebhookRoutes);
app.use('/api/materials',         materialsRoutes);
app.use('/api',                   coachApplicationRoutes);
app.use('/api/sessions',          sessionRoutes);
app.use('/api/presentations',     presentationRoutes);
app.use('/api/course-materials',  courseMaterialRoutes);
app.use('/api',                   waitlistRoutes);
app.use('/api',                   rsvpRoutes);
app.use('/api',                   directoryLifecycleRoutes);

// Staff onboarding (super-admin only; the route validates the JWT + admin role).
const staffLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/staff',             staffLimiter, staffRoutes);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
