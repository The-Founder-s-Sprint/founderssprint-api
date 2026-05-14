const express = require('express');
const cors    = require('cors');

const registerRoutes        = require('../routes/register');
const adminRoutes           = require('../routes/admin');
const cronRoutes            = require('../routes/cron');
const confirmPaymentRoutes  = require('../routes/confirm-payment');
const paymentRequestRoutes  = require('../routes/payment-request');
const iotecWebhookRoutes    = require('../routes/iotec-webhook');
const materialsRoutes       = require('../routes/materials');
const coachApplicationRoutes = require('../routes/coach-application');

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.ALLOWED_ORIGIN || 'https://tmsruge.com',
  'https://www.tmsruge.com',
  'https://founderssprint.co',
  'https://www.founderssprint.co',
  'http://localhost:3000',
  'http://localhost:5500',
];

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (server-to-server, Vercel cron)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  credentials: true,
}));

app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api',                   registerRoutes);
app.use('/api/admin',             adminRoutes);
app.use('/api/cron',              cronRoutes);
app.post('/api/confirm-payment',  confirmPaymentRoutes);
app.post('/api/payment-request',  paymentRequestRoutes);
app.post('/api/iotec/webhook',    iotecWebhookRoutes);
app.use('/api/materials',         materialsRoutes);
app.use('/api',                   coachApplicationRoutes);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
