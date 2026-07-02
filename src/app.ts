// ============================================================
// src/app.ts — Express Application Setup
// ============================================================
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config();

import flowRouter from './routes/flow.route';
import cronRouter from './routes/cron.route';
import webhookRouter from './routes/webhook.route';

const app = express();

// ── Security: Helmet (HTTP headers) ──────────────────────────
app.use(helmet());

// ── Security: CORS ───────────────────────────────────────────
// Only allow requests from the admin dashboard domain
const allowedOrigins = [
  process.env.ADMIN_DASHBOARD_URL || 'https://bqa-admin.vercel.app',
  'http://localhost:3000', // local dev
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow no-origin requests (server-to-server, Vercel edge, Meta webhook)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: Origin not allowed'));
  },
  credentials: true,
}));

// ── Security: Rate limiting ───────────────────────────────────
// General: 100 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Flow endpoint: 20 requests per minute (WhatsApp sends bursts)
const flowLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Flow rate limit exceeded.' },
});

app.use(generalLimiter);
app.use(express.json());

// ── Health check ─────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    status: '✅ CyFam Bible Quiz Backend is running',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── Routes ───────────────────────────────────────────────────
// WhatsApp Flow data exchange (Meta → backend)
app.use('/api/flow', flowLimiter, flowRouter);

// WhatsApp Webhook (incoming messages, delivery receipts)
app.use('/api/webhook', webhookRouter);

// Cron job endpoints (called by cron-job.org daily)
app.use('/api/cron', cronRouter);

// ── 404 fallback ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

export default app;
