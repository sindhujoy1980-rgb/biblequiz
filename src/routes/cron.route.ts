// ============================================================
// src/routes/cron.route.ts
// Cron Job Endpoints — called by cron-job.org (free)
//
// Endpoints:
//   GET  /api/cron/whatsapp-diag       ← diagnostic: phone, templates, flows
//   POST /api/cron/test-send           ← debug: test WhatsApp template send
//   POST /api/cron/generate-questions  ← runs ~11 PM daily
//   POST /api/cron/send-quiz           ← runs 8 AM daily
//
// All endpoints require header: x-cron-secret: <CRON_SECRET>
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { generateDailyQuestions, saveQuestions } from '../services/questionGenerator';

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function validateCronSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized: invalid cron secret' });
    return;
  }
  next();
}

router.use(validateCronSecret);

// ── GET /api/cron/whatsapp-diag ──────────────────────────────
router.get('/whatsapp-diag', async (_req: Request, res: Response) => {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaIdEnv     = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

  if (!phoneNumberId || !accessToken) {
    return res.json({ error: 'WhatsApp env vars missing' });
  }

  const hdr = { Authorization: `Bearer ${accessToken}` };

  // Helper: safe fetch JSON
  const gql = async (url: string) => {
    try {
      const r = await fetch(url, { headers: hdr });
      return await r.json();
    } catch (e: any) { return { fetchError: e.message }; }
  };

  // 1. Phone number details
  const phoneData = await gql(
    `https://graph.facebook.com/v19.0/${phoneNumberId}?fields=id,verified_name,display_phone_number,quality_rating,code_verification_status,platform_type,name_status`
  ) as any;

  // 2. Token debug — exposes scopes, app, associated WABA accounts
  const tokenDebug = await gql(
    `https://graph.facebook.com/debug_token?input_token=${accessToken}&access_token=${accessToken}`
  ) as any;

  // 3. Try /me/businesses to enumerate business accounts
  const meBusinesses = await gql(
    `https://graph.facebook.com/v19.0/me/businesses?fields=id,name,whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number}}`
  ) as any;

  // 4. Try fetching flows via WABA ID env or from businesses response
  let realWabaId = wabaIdEnv;
  const bizList = meBusinesses?.data || [];
  for (const biz of bizList) {
    for (const waba of (biz.whatsapp_business_accounts?.data || [])) {
      if (waba.id) { realWabaId = waba.id; break; }
    }
    if (realWabaId !== wabaIdEnv) break;
  }

  let flowsData: any = null;
  let templatesData: any = null;
  if (realWabaId && realWabaId !== '987654321098765') {
    [flowsData, templatesData] = await Promise.all([
      gql(`https://graph.facebook.com/v19.0/${realWabaId}/flows?fields=id,name,status,categories,endpoint_uri,validation_errors`),
      gql(`https://graph.facebook.com/v19.0/${realWabaId}/message_templates?fields=name,status,language,category,rejected_reason&limit=20`),
    ]);
  }

  return res.json({
    phoneNumberId,
    configuredWabaId: wabaIdEnv,
    discoveredWabaId: realWabaId,
    phoneDetails: phoneData,
    tokenDebug: tokenDebug?.data || tokenDebug,
    meBusinesses: meBusinesses,
    flows: flowsData,
    templates: templatesData,
  });
});

// ── POST /api/cron/test-send ─────────────────────────────────
router.post('/test-send', async (req: Request, res: Response) => {
  const phone        = req.body?.phone || '919993612014';
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
  const templateName  = req.body?.template || process.env.WHATSAPP_TEMPLATE_NAME || 'bible_quiz_with_readings';
  const langCode      = req.body?.language || (templateName === 'hello_world' ? 'en_US' : 'en');

  if (!phoneNumberId || !accessToken) {
    return res.json({ error: 'WhatsApp env vars missing' });
  }

  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
  let body: any;

  if (templateName === 'hello_world') {
    body = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: { name: 'hello_world', language: { code: langCode } },
    };
  } else {
    body = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: langCode },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: '📖 Bible Quiz Daily — 12 Jul 2026' }] },
          { type: 'body', parameters: [
            { type: 'text', text: 'Ordinary Time, Week 14' },
            { type: 'text', text: 'Genesis 49:29-32 — Jacob charged his sons...' },
            { type: 'text', text: 'Matthew 10:24-33 — A disciple is not above his teacher...' },
            { type: 'text', text: 'Jesus teaches disciples not to fear persecution.' },
            { type: 'text', text: 'Friend' },
          ]},
          ...(req.body?.withFlow === false ? [] : [
            { type: 'button', sub_type: 'flow', index: '0', parameters: [
              { type: 'action', action: { flow_token: 'test-token-debug' } },
            ]},
          ]),
        ],
      },
    };
  }

  const metaRes = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const metaBody = await metaRes.json();

  return res.json({
    phone, phoneNumberId, templateName, language: langCode,
    metaStatus: metaRes.status, metaOk: metaRes.ok,
    metaResponse: metaBody,
    sentBody: body,
  });
});

// ── POST /api/cron/generate-questions ────────────────────────
router.post('/generate-questions', async (_req: Request, res: Response) => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const quizDate = tomorrow.toISOString().split('T')[0];

    const { data: existing } = await supabase.from('questions').select('id').eq('quiz_date', quizDate).limit(1);
    if (existing && existing.length > 0) {
      return res.json({ success: true, message: `Questions already exist for ${quizDate} — skipped`, quizDate });
    }

    const questions = await generateDailyQuestions(quizDate);
    await saveQuestions(questions, quizDate);
    return res.json({ success: true, message: `✅ Generated ${questions.length} question(s) for ${quizDate}`, quizDate, count: questions.length });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/cron/send-quiz ──────────────────────────────────
router.post('/send-quiz', async (_req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: questions, error: qError } = await supabase
      .from('questions').select('id').eq('quiz_date', today).not('status', 'eq', 'rejected').limit(1);
    if (qError || !questions || questions.length < 1) {
      return res.status(400).json({ success: false, error: `No question for ${today}` });
    }

    const { data: users, error: uError } = await supabase
      .from('users').select('id, phone, name').eq('status', 'active');
    if (uError || !users) return res.status(500).json({ success: false, error: 'Failed to fetch users' });

    const results = await Promise.allSettled(users.map(u => sendQuizMessage(u.phone, u.name, today)));

    let sent = 0, failed = 0;
    const debugResults: any[] = [];
    results.forEach((result, i) => {
      const user = users[i];
      if (result.status === 'fulfilled') {
        sent++;
        debugResults.push({ phone: user.phone, status: 'sent', messageId: result.value });
      } else {
        failed++;
        debugResults.push({ phone: user.phone, status: 'failed', error: result.reason?.message });
      }
    });

    await supabase.from('quizzes').update({ published: true, published_at: new Date().toISOString() }).eq('quiz_date', today);

    return res.json({ success: true, message: `Quiz sent for ${today}`, sent, failed, total: users.length, debug: debugResults });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

async function sendQuizMessage(phone: string, name: string, quizDate: string): Promise<string> {
  const jwt = await import('jsonwebtoken');
  const flowToken = jwt.default.sign({ phone }, process.env.JWT_SECRET!, { expiresIn: '24h' });

  const { data: readings } = await supabase
    .from('daily_readings')
    .select('liturgical_day, first_reading_ref, first_reading_text, gospel_ref, gospel_text, reflection_en')
    .eq('reading_date', quizDate).single();

  const firstName = name.split(' ')[0];
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || 'bible_quiz_with_readings';
  const dateFormatted = new Date(quizDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const clean = (s: string) => s.replace(/[\n\r\t]/g, ' ').trim();

  const liturgicalDay = clean(readings?.liturgical_day || 'Catholic Daily Readings').slice(0, 60);
  const firstReading  = readings?.first_reading_ref
    ? clean(`${readings.first_reading_ref} — ${(readings.first_reading_text || '').slice(0, 80)}`).slice(0, 150)
    : 'First Reading not available';
  const gospel = readings?.gospel_ref
    ? clean(`${readings.gospel_ref} — ${(readings.gospel_text || '').slice(0, 80)}`).slice(0, 150)
    : 'Gospel not available';
  const reflection = readings?.reflection_en
    ? clean(readings.reflection_en).slice(0, 120)
    : "Reflect on today's Gospel and let it guide your day.";

  const response = await fetch(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'en' },
          components: [
            { type: 'header', parameters: [{ type: 'text', text: `📖 Bible Quiz Daily — ${dateFormatted}` }] },
            { type: 'body', parameters: [
              { type: 'text', text: liturgicalDay },
              { type: 'text', text: firstReading },
              { type: 'text', text: gospel },
              { type: 'text', text: reflection },
              { type: 'text', text: firstName },
            ]},
            { type: 'button', sub_type: 'flow', index: '0', parameters: [
              { type: 'action', action: { flow_token: flowToken } },
            ]},
          ],
        },
      }),
    }
  );

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(JSON.stringify(errBody));
  }
  const result = await response.json() as any;
  return result?.messages?.[0]?.id;
}

export default router;
