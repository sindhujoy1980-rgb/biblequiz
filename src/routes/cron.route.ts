// ============================================================
// src/routes/cron.route.ts — with WABA re-subscribe endpoint
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

// ── GET /api/cron/gemini-diag ────────────────────────────────
// Tests GEMINI_API_KEY and model availability
router.get('/gemini-diag', async (_req: Request, res: Response) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  if (!apiKey) {
    return res.json({ ok: false, error: 'GEMINI_API_KEY is not set in Vercel env vars' });
  }

  const keyHint = `${apiKey.slice(0, 6)}...${apiKey.slice(-4)} (len=${apiKey.length})`;

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent('Say "OK" in one word.');
    const text = result.response.text().trim();
    return res.json({ ok: true, keyHint, modelName, response: text });
  } catch (err: any) {
    return res.json({ ok: false, keyHint, modelName, error: err.message, stack: err.stack?.split('\n').slice(0, 3) });
  }
});

// ── GET /api/cron/whatsapp-diag ──────────────────────────────
router.get('/whatsapp-diag', async (_req: Request, res: Response) => {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaIdEnv     = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const BUSINESS_ID   = '1428659239273883';

  if (!phoneNumberId || !accessToken) {
    return res.json({ error: 'WhatsApp env vars missing' });
  }

  const hdr = { Authorization: `Bearer ${accessToken}` };
  const gql = async (url: string) => {
    try { const r = await fetch(url, { headers: hdr }); return await r.json(); }
    catch (e: any) { return { fetchError: e.message }; }
  };

  const phoneData = await gql(
    `https://graph.facebook.com/v19.0/${phoneNumberId}?fields=id,verified_name,display_phone_number,quality_rating,code_verification_status,platform_type,name_status,whatsapp_business_account{id,name}`
  ) as any;

  const tokenDebug = await gql(
    `https://graph.facebook.com/debug_token?input_token=${accessToken}&access_token=${accessToken}`
  ) as any;

  const meBusinesses = await gql(
    `https://graph.facebook.com/v19.0/me/businesses?fields=id,name,whatsapp_business_accounts{id,name}`
  ) as any;

  const bizWabas = await gql(
    `https://graph.facebook.com/v19.0/${BUSINESS_ID}/whatsapp_business_accounts?fields=id,name`
  ) as any;

  let realWabaId = phoneData?.whatsapp_business_account?.id;
  if (!realWabaId || realWabaId === '987654321098765') realWabaId = bizWabas?.data?.[0]?.id;
  if (!realWabaId || realWabaId === '987654321098765') {
    for (const biz of (meBusinesses?.data || [])) {
      for (const waba of (biz.whatsapp_business_accounts?.data || [])) {
        if (waba.id) { realWabaId = waba.id; break; }
      }
      if (realWabaId) break;
    }
  }
  if (!realWabaId) realWabaId = wabaIdEnv;

  const appId = tokenDebug?.data?.app_id || tokenDebug?.app_id;
  const appSubs = appId ? await gql(`https://graph.facebook.com/v19.0/${appId}/subscriptions`) : null;

  let wabaData: any = null;
  let wabaSubsData: any = null;
  if (realWabaId && realWabaId !== '987654321098765') {
    [wabaData, wabaSubsData] = await Promise.all([
      gql(`https://graph.facebook.com/v19.0/${realWabaId}?fields=id,name,currency,timezone_id,message_template_namespace`),
      gql(`https://graph.facebook.com/v19.0/${realWabaId}/subscribed_apps`),
    ]);
  }

  return res.json({ phoneNumberId, configuredWabaId: wabaIdEnv, discoveredWabaId: realWabaId, phoneDetails: phoneData, bizWabas, tokenDebug: tokenDebug?.data || tokenDebug, appSubscriptions: appSubs, wabaData, wabaSubscribedApps: wabaSubsData });
});

// ── POST /api/cron/waba-subscribe ──────────────────────────────
router.post('/waba-subscribe', async (req: Request, res: Response) => {
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const wabaIdEnv     = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const BUSINESS_ID   = '1428659239273883';

  if (!accessToken) return res.json({ error: 'WHATSAPP_ACCESS_TOKEN not set' });

  const hdr = { Authorization: `Bearer ${accessToken}` };
  const results: Record<string, any> = {};
  let wabaId = req.body?.wabaId || wabaIdEnv;

  if (!wabaId || wabaId === '987654321098765') {
    try {
      const phoneRes = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}?fields=whatsapp_business_account{id}`, { headers: hdr });
      const phoneData = await phoneRes.json() as any;
      if (phoneData?.whatsapp_business_account?.id) wabaId = phoneData.whatsapp_business_account.id;
    } catch (_) {}
  }

  if (!wabaId || wabaId === '987654321098765') {
    try {
      const bizRes = await fetch(`https://graph.facebook.com/v19.0/${BUSINESS_ID}/whatsapp_business_accounts?fields=id,name`, { headers: hdr });
      const bizData = await bizRes.json() as any;
      results.fromBusiness = bizData;
      if (bizData?.data?.[0]?.id) wabaId = bizData.data[0].id;
    } catch (e: any) { results.bizError = e.message; }
  }

  if (!wabaId || wabaId === '987654321098765') {
    return res.json({ error: 'Cannot discover WABA ID automatically.', discoveryResults: results });
  }

  try {
    const subRes = await fetch(`https://graph.facebook.com/v19.0/${wabaId}/subscribed_apps`, { method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json' } });
    const subData = await subRes.json();
    const checkRes = await fetch(`https://graph.facebook.com/v19.0/${wabaId}/subscribed_apps`, { headers: hdr });
    const checkData = await checkRes.json();
    return res.json({ wabaId, subscribeStatus: subRes.status, subscribeResult: subData, currentSubscribedApps: checkData, discoveryResults: results });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/cron/test-send ─────────────────────────────────
router.post('/test-send', async (req: Request, res: Response) => {
  const phone        = req.body?.phone || '919993612014';
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
  const templateName  = req.body?.template || process.env.WHATSAPP_TEMPLATE_NAME || 'bible_quiz_with_readings';
  const langCode      = req.body?.language || (templateName === 'hello_world' ? 'en_US' : 'en');

  if (!phoneNumberId || !accessToken) return res.json({ error: 'WhatsApp env vars missing' });

  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
  let body: any;

  if (templateName === 'hello_world') {
    body = { messaging_product: 'whatsapp', to: phone, type: 'template', template: { name: 'hello_world', language: { code: langCode } } };
  } else {
    body = {
      messaging_product: 'whatsapp', to: phone, type: 'template',
      template: {
        name: templateName, language: { code: langCode },
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
            { type: 'button', sub_type: 'flow', index: '0', parameters: [{ type: 'action', action: { flow_token: 'test-token-debug' } }] },
          ]),
        ],
      },
    };
  }

  const metaRes = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const metaBody = await metaRes.json();
  return res.json({ phone, phoneNumberId, templateName, language: langCode, metaStatus: metaRes.status, metaOk: metaRes.ok, metaResponse: metaBody, sentBody: body });
});

// ── POST /api/cron/generate-questions ────────────────────────
router.post('/generate-questions', async (_req: Request, res: Response) => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const quizDate = tomorrow.toISOString().split('T')[0];
    const { data: existing } = await supabase.from('questions').select('id').eq('quiz_date', quizDate).limit(1);
    if (existing && existing.length > 0) return res.json({ success: true, message: `Questions already exist for ${quizDate} — skipped`, quizDate });
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
    const { data: questions, error: qError } = await supabase.from('questions').select('id').eq('quiz_date', today).not('status', 'eq', 'rejected').limit(1);
    if (qError || !questions || questions.length < 1) return res.status(400).json({ success: false, error: `No question for ${today}` });
    const { data: users, error: uError } = await supabase.from('users').select('id, phone, name').eq('status', 'active');
    if (uError || !users) return res.status(500).json({ success: false, error: 'Failed to fetch users' });
    const results = await Promise.allSettled(users.map(u => sendQuizMessage(u.phone, u.name, today)));
    let sent = 0, failed = 0;
    const debugResults: any[] = [];
    results.forEach((result, i) => {
      const user = users[i];
      if (result.status === 'fulfilled') { sent++; debugResults.push({ phone: user.phone, status: 'sent', messageId: result.value }); }
      else { failed++; debugResults.push({ phone: user.phone, status: 'failed', error: result.reason?.message }); }
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
  const { data: readings } = await supabase.from('daily_readings').select('liturgical_day, first_reading_ref, first_reading_text, gospel_ref, gospel_text, reflection_en').eq('reading_date', quizDate).single();
  const firstName = name.split(' ')[0];
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || 'bible_quiz_with_readings';
  const dateFormatted = new Date(quizDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const clean = (s: string) => s.replace(/[\n\r\t]/g, ' ').trim();
  const liturgicalDay = clean(readings?.liturgical_day || 'Catholic Daily Readings').slice(0, 60);
  const firstReading = readings?.first_reading_ref ? clean(`${readings.first_reading_ref} — ${(readings.first_reading_text || '').slice(0, 80)}`).slice(0, 150) : 'First Reading not available';
  const gospel = readings?.gospel_ref ? clean(`${readings.gospel_ref} — ${(readings.gospel_text || '').slice(0, 80)}`).slice(0, 150) : 'Gospel not available';
  const reflection = readings?.reflection_en ? clean(readings.reflection_en).slice(0, 120) : "Reflect on today's Gospel.";
  const response = await fetch(`https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: phone, type: 'template',
      template: {
        name: templateName, language: { code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: `📖 Bible Quiz Daily — ${dateFormatted}` }] },
          { type: 'body', parameters: [
            { type: 'text', text: liturgicalDay },
            { type: 'text', text: firstReading },
            { type: 'text', text: gospel },
            { type: 'text', text: reflection },
            { type: 'text', text: firstName },
          ]},
          { type: 'button', sub_type: 'flow', index: '0', parameters: [{ type: 'action', action: { flow_token: flowToken } }] },
        ],
      },
    }),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(JSON.stringify(errBody));
  }
  const result = await response.json() as any;
  return result?.messages?.[0]?.id;
}

export default router;
