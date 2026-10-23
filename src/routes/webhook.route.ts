// ============================================================
// src/routes/webhook.route.ts
// WhatsApp Webhook Handler
//
// GET  /api/webhook  ← Meta verification challenge
// POST /api/webhook  ← Incoming messages / delivery receipts
//
// IMPORTANT: On Vercel serverless, all async work (Supabase inserts)
// MUST happen BEFORE res.json() — the function is killed after response.
// ============================================================

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── GET: Webhook verification (one-time setup by Meta) ───────────
router.get('/', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    console.log('[Webhook] ✅ Verification successful');
    return res.status(200).send(challenge);
  }

  console.warn('[Webhook] ❌ Verification failed');
  return res.status(403).json({ error: 'Forbidden' });
});

// ── POST: Incoming events from Meta ────────────────────────
// NOTE: All Supabase inserts happen BEFORE res.json() to avoid
// Vercel killing the function after the response is sent.
router.post('/', async (req: Request, res: Response) => {
  const body = req.body;

  // Must respond within 5s to Meta — but we process first (inserts are fast)
  if (!body || body.object !== 'whatsapp_business_account') {
    return res.status(200).json({ status: 'ok' });
  }

  // Process all events synchronously BEFORE sending response
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;

      const value = change.value;

      // Incoming messages (user texting the business)
      for (const message of value.messages || []) {
        console.log(`[Webhook] Incoming msg type=${message.type} from=${message.from}`);
        try {
          await supabase.from('flow_debug_logs').insert({
            step: 'WH_MSG_IN',
            action: message.type || 'text',
            screen: message.from || '',
            body_keys: message.id || '',
            notes: (message.text?.body || '').slice(0, 100),
          });
        } catch (_) {}
        handleIncomingMessage(message, value.metadata).catch(console.error);
      }

      // Delivery & read receipts — key for diagnosing message delivery
      for (const status of value.statuses || []) {
        const errorsStr = status.errors ? JSON.stringify(status.errors) : '';
        console.log(`[Webhook] Status wamid=${status.id} status=${status.status} recipient=${status.recipient_id} errors=${errorsStr}`);
        try {
          await supabase.from('flow_debug_logs').insert({
            step: 'WH_STATUS',
            action: status.status || 'unknown',
            screen: status.recipient_id || '',
            body_keys: status.id || '',
            error_msg: errorsStr,
            notes: `ts=${status.timestamp} pricing=${status.pricing?.pricing_model || ''}`,
          });
        } catch (e: any) {
          console.error('[Webhook] Failed to log status:', e.message);
        }
      }
    }
  }

  // Respond AFTER processing — all inserts are done before this point
  return res.status(200).json({ status: 'ok' });
});

// ── Signature verification ─────────────────────────────────
function verifySignature(rawBody: Buffer | string | any, signature: string): boolean {
  if (!signature || !process.env.WHATSAPP_APP_SECRET) {
    return true; // Don't block if secret isn't configured
  }
  try {
    const bodyBuffer = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));
    const expectedSig = 'sha256=' + crypto
      .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
      .update(bodyBuffer)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
  } catch (_) {
    return false;
  }
}

// ── Handle incoming user messages ───────────────────────────
async function handleIncomingMessage(message: any, metadata: any): Promise<void> {
  const from = message.from;
  const text = message.text?.body?.toLowerCase() || '';
  console.log(`[Webhook] User ${from} sent: ${text}`);
  // Future: handle 'stop', 'help', opt-out commands here
}

export default router;
