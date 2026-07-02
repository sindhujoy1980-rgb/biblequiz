// ============================================================
// src/routes/webhook.route.ts
// WhatsApp Webhook Handler
//
// GET  /api/webhook  ← Meta verification challenge
// POST /api/webhook  ← Incoming messages / delivery receipts
//
// Meta sends HMAC-SHA256 signature in x-hub-signature-256 header
// We verify it using WHATSAPP_APP_SECRET before processing
// ============================================================

import { Router, Request, Response } from 'express';
import crypto from 'crypto';

const router = Router();

// ── GET: Webhook verification (one-time setup by Meta) ───────
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

// ── POST: Incoming events from Meta ──────────────────────────
// Verify HMAC-SHA256 signature before processing
router.post('/', (req: Request, res: Response) => {
  // 1. Verify signature
  const signature = req.headers['x-hub-signature-256'] as string;
  if (!verifySignature(req.body, signature)) {
    console.warn('[Webhook] ❌ Invalid signature — request rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 2. Acknowledge immediately (Meta requires < 5s response)
  res.status(200).json({ status: 'ok' });

  // 3. Process events asynchronously
  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;

      const value = change.value;

      // Incoming text messages (e.g., user texting "Hello")
      for (const message of value.messages || []) {
        handleIncomingMessage(message, value.metadata).catch(console.error);
      }

      // Delivery & read receipts
      for (const status of value.statuses || []) {
        console.log(`[Webhook] Message ${status.id} — ${status.status}`);
      }
    }
  }
});

// ── Signature verification ───────────────────────────────────
function verifySignature(rawBody: Buffer | string, signature: string): boolean {
  if (!signature || !process.env.WHATSAPP_APP_SECRET) {
    // Skip verification in dev if secret not set
    if (process.env.NODE_ENV !== 'production') return true;
    return false;
  }

  const expectedSig = 'sha256=' + crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
    .update(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSig)
    );
  } catch {
    return false;
  }
}

// ── Handle incoming text message ─────────────────────────────
// If a user texts the number directly (not through Flow),
// we can respond with a friendly message
async function handleIncomingMessage(
  message: { from: string; type: string; text?: { body: string }; id: string },
  metadata: { phone_number_id: string }
) {
  if (message.type !== 'text') return;

  const userText = message.text?.body?.trim().toLowerCase() || '';
  console.log(`[Webhook] Message from ${message.from}: "${userText}"`);

  // Auto-reply: guide user to the quiz
  const replyText =
    'नमस्ते! 🙏\n\nCyFam Bible Quiz के लिए कृपया प्रतिदिन सुबह 8 बजे हमारे संदेश की प्रतीक्षा करें।\n\n📖 ईश्वर आपको आशीष दे!';

  await sendTextMessage(message.from, replyText, metadata.phone_number_id);
}

async function sendTextMessage(to: string, text: string, phoneNumberId: string) {
  await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    }
  );
}

export default router;
