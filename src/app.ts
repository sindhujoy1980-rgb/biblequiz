// ============================================================
// src/app.ts — Express Application Setup
// ============================================================
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

import flowRouter from './routes/flow.route';
import cronRouter from './routes/cron.route';

const app = express();

// Parse JSON body
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
// WhatsApp Flow data exchange endpoint
// Meta calls this when user interacts with the Flow
app.use('/api/flow', flowRouter);

// Cron job endpoints (called by cron-job.org daily)
app.use('/api/cron', cronRouter);

// ── 404 fallback ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

export default app;
