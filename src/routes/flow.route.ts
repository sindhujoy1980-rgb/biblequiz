// ============================================================
// src/routes/flow.route.ts
// WhatsApp Flow Data Exchange — SINGLE QUESTION per day
// POST /api/flow/exchange  ← Meta calls this
// ============================================================

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── Types ─────────────────────────────────────────────────────
interface FlowPayload {
  q1_id: string;
  q1_answer: 'A' | 'B' | 'C' | 'D';
}

interface FlowRequest {
  version: string;
  action: 'ping' | 'INIT' | 'data_exchange' | 'navigate' | 'BACK';
  screen: string;
  data: FlowPayload;
  flow_token: string;
}

// ── Decrypt WhatsApp Flow request ─────────────────────────────
function decryptRequest(body: {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
}): { decryptedBody: FlowRequest; aesKey: Buffer; iv: Buffer } {
  const privateKey = process.env.WHATSAPP_FLOW_PRIVATE_KEY!.replace(/\\n/g, '\n');

  const aesKey = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(body.encrypted_aes_key, 'base64')
  );

  const iv = Buffer.from(body.initial_vector, 'base64');
  const encryptedBuffer = Buffer.from(body.encrypted_flow_data, 'base64');
  const TAG_LENGTH = 16;
  const cipherText = encryptedBuffer.subarray(0, -TAG_LENGTH);
  const authTag    = encryptedBuffer.subarray(-TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  const decryptedJSON = Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf-8');

  return { decryptedBody: JSON.parse(decryptedJSON), aesKey, iv };
}

// ── Encrypt response back to WhatsApp ────────────────────────
function encryptResponse(response: object, aesKey: Buffer, iv: Buffer): string {
  const flippedIV = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) flippedIV[i] = ~iv[i];

  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIV);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(response), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return encrypted.toString('base64');
}

// ── Diagnostic: GET /api/flow/test-exchange ──────────────────────────
// Shows EXACTLY what JSON would be encrypted and sent for QUESTION screen
// Call: https://biblequiz-five.vercel.app/api/flow/test-exchange
router.get('/test-exchange', async (_req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    // SAME query as real data_exchange handler
    const { data: questions, error } = await supabase
      .from('questions')
      .select('id, slot, question_text, english_question, option_a, option_b, option_c, option_d, verse_reference, correct_answer')
      .eq('quiz_date', today)
      .not('status', 'eq', 'rejected')
      .order('slot', { ascending: true })
      .limit(5);

    const q = (!error && questions && questions.length > 0)
      ? (questions.find((q: any) => q.slot === 2) || questions.find((q: any) => q.slot === 1) || questions[0])
      : null;

    const cleanOpt = (s: string) => (s || '').replace(/[\n\r\t]/g, ' ').trim() || '—';
    const optA = cleanOpt(q?.option_a || '');
    const optB = cleanOpt(q?.option_b || '');
    const optC = cleanOpt(q?.option_c || '');
    const optD = cleanOpt(q?.option_d || '');

    // EXACT questionData as built in real handler
    const questionData = {
      q1_id:      q ? String(q.id) : '',
      q1_text:    q?.question_text || 'आज की क्विज़ उपलब्ध नहीं है।',
      q1_english: q?.english_question || '',
      q1_options: q ? `A) ${optA}\nB) ${optB}\nC) ${optC}\nD) ${optD}` : 'Quiz not available today.',
      q1_verse:   q?.verse_reference || '',
    };

    // Full response object that gets encrypted
    const fullResponse = { version: '3.0', screen: 'QUESTION', data: questionData };

    const jsonStr = JSON.stringify(fullResponse);

    return res.json({
      today,
      questionsFound: questions?.length ?? 0,
      queryError:     error?.message ?? null,
      selectedSlot:   q?.slot ?? null,
      selectedId:     q?.id ?? null,
      fieldLengths: {
        q1_id:      questionData.q1_id.length,
        q1_text:    questionData.q1_text.length,
        q1_english: questionData.q1_english.length,
        q1_options: questionData.q1_options.length,
        q1_verse:   questionData.q1_verse.length,
      },
      fieldNullCheck: {
        q1_id_empty:      questionData.q1_id === '',
        q1_text_empty:    questionData.q1_text === '',
        q1_english_empty: questionData.q1_english === '',
        q1_options_empty: questionData.q1_options === '',
        q1_verse_empty:   questionData.q1_verse === '',
      },
      questionData,   // ← exact data being sent to QUESTION screen
      fullResponse,   // ← full response being encrypted { version, screen, data }
      jsonLength:     jsonStr.length,
      jsonPreview:    jsonStr.substring(0, 300),  // first 300 chars of JSON
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Debug: read the last 20 flow exchange logs ───────────────
router.get('/debug', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('flow_debug_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) return res.json({ error: error.message, hint: 'Table may not exist yet — see instructions below', sql: 'CREATE TABLE flow_debug_logs (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), step TEXT, action TEXT, screen TEXT, body_keys TEXT, error_msg TEXT, response_screen TEXT, notes TEXT);' });
    return res.json({ count: data?.length, logs: data });
  } catch (e: any) {
    return res.json({ error: e.message });
  }
});

// ── Diagnostic: GET /api/flow/check-meta-flow ──────────────────────────
// Fetches the ACTUAL published flow JSON from Meta Graph API.
// Compares it with what our backend expects.
router.get('/check-meta-flow', async (_req: Request, res: Response) => {
  try {
    const flowId  = process.env.WHATSAPP_FLOW_ID;
    const token   = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!flowId || !token) {
      return res.status(500).json({ error: 'WHATSAPP_FLOW_ID or WHATSAPP_ACCESS_TOKEN not set' });
    }
    // Fetch flow status and endpoint
    const metaUrl = `https://graph.facebook.com/v19.0/${flowId}?fields=id,name,status,validation_errors,data_api_version,endpoint_uri,categories&access_token=${token}`;
    const r1 = await fetch(metaUrl);
    const flowMeta = await r1.json() as any;

    // Fetch the actual flow JSON
    const flowJsonUrl = `https://graph.facebook.com/v19.0/${flowId}/assets?access_token=${token}`;
    const r2 = await fetch(flowJsonUrl);
    const flowAssets = await r2.json() as any;

    // Find the flow JSON asset
    let flowJsonAsset = null;
    if (flowAssets?.data) {
      flowJsonAsset = flowAssets.data.find((a: any) => a.asset_type === 'FLOW_JSON');
    }

    // Parse the flow JSON to check QUESTION screen data schema AND layout
    let questionScreenData: any = null;
    let questionScreenLayout: any = null;
    let allScreenIds: string[] = [];
    let parsedFlowJson: any = null;
    if (flowJsonAsset?.download_url) {
      const r3 = await fetch(flowJsonAsset.download_url);
      parsedFlowJson = await r3.json() as any;
      allScreenIds = (parsedFlowJson?.screens ?? []).map((s: any) => s.id);
      const questionScreen = parsedFlowJson?.screens?.find((s: any) => s.id === 'QUESTION');
      questionScreenData   = questionScreen?.data ?? null;
      // Return full layout so we can inspect exact component text/variable references
      questionScreenLayout = questionScreen?.layout ?? null;
    }

    return res.json({
      flowId,
      flowMeta,
      allScreenIds,               // ALL screen IDs in the flow
      questionScreenData,         // field schema declared in QUESTION screen
      questionScreenLayout,       // ← FULL LAYOUT: exact component text/variable refs
      expectedFields: ['q1_id', 'q1_text', 'q1_english', 'q1_options', 'q1_verse'],
      actualPublishedFields: questionScreenData ? Object.keys(questionScreenData) : null,
      fieldNamesMatch: questionScreenData
        ? ['q1_id','q1_text','q1_english','q1_options','q1_verse'].every(f => !!questionScreenData[f])
        : false,
      mismatch: questionScreenData
        ? ['q1_id','q1_text','q1_english','q1_options','q1_verse']
            .filter(f => !questionScreenData[f])
        : 'could_not_fetch',
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0,5) });
  }
});

// ── Helper: write one debug row to Supabase (fail-silently) ──
async function dbg(step: string, fields: Record<string, string>) {
  try {
    await supabase.from('flow_debug_logs').insert({
      step,
      action: fields.action ?? '',
      screen: fields.screen ?? '',
      body_keys: fields.body_keys ?? '',
      error_msg: fields.error_msg ?? '',
      response_screen: fields.response_screen ?? '',
      notes: fields.notes ?? '',
    });
  } catch (_) { /* silent */ }
}

// ── Main handler ──────────────────────────────────────────────
router.post('/exchange', async (req: Request, res: Response) => {
  try {
    // ─ Step 0: Log that the request arrived AT ALL ─────────────
    // If you NEVER see this in /api/flow/debug, the flow button
    // is NOT calling our endpoint (wrong URL or flow blocked in Meta).
    const bodyKeys = Object.keys(req.body || {}).join(',');
    console.log('[Flow:ARRIVED] body keys:', bodyKeys, '| action:', req.body?.action);
    await dbg('ARRIVED', { body_keys: bodyKeys, action: req.body?.action ?? '' });

    // ── Plain-text ping (WhatsApp client opening the flow) ────────────────────
    // The WhatsApp client sends { "action": "ping" } as unencrypted JSON.
    // Must be checked BEFORE decryptRequest — calling decryptRequest on a plain
    // ping body (no encrypted_flow_data fields) throws TypeError → HTTP 500.
    if (req.body?.action === 'ping') {
      console.log('[Flow] plain-text ping — responding active');
      await dbg('PLAIN_PING', { action: 'ping', response_screen: 'active' });
      return res.json({ data: { status: 'active' } });
    }

    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;
    console.log('[Flow:DECRYPT] has encrypted_flow_data:', !!encrypted_flow_data, '| has key:', !!encrypted_aes_key, '| has iv:', !!initial_vector);
    await dbg('PRE_DECRYPT', {
      body_keys: bodyKeys,
      notes: `efdata=${!!encrypted_flow_data} key=${!!encrypted_aes_key} iv=${!!initial_vector}`,
    });

    let decryptedBody: any, aesKey: Buffer, iv: Buffer;
    try {
      ({ decryptedBody, aesKey, iv } = decryptRequest({ encrypted_flow_data, encrypted_aes_key, initial_vector }));
    } catch (decryptErr: any) {
      console.error('[Flow:DECRYPT_FAIL]', decryptErr.message);
      await dbg('DECRYPT_FAIL', { error_msg: decryptErr.message, body_keys: bodyKeys });
      return res.status(500).json({ error: 'decryption failed', detail: decryptErr.message });
    }

    const { action: rawAction, screen, data, flow_token, version } = decryptedBody as any;
    const action = (rawAction || '').toLowerCase();
    console.log('[Flow:DECRYPTED] action:', action, '| screen:', screen, '| version:', version);
    await dbg('DECRYPTED', { action, screen: screen ?? '', notes: `version=${version} token=${flow_token ? 'present' : 'MISSING'}` });

    // ── Encrypted ping (Meta Business Manager health check) ───────────────────
    if (action === 'ping') {
      console.log('[Flow] encrypted ping (health check) — responding active');
      await dbg('ENC_PING', { action: 'ping', response_screen: 'active' });
      return res.send(encryptResponse({ version, data: { status: 'active' } }, aesKey, iv));
    }

    // ── INIT: fetch question immediately and navigate to QUESTION ──────────────
    // NOTE: We do NOT return WELCOME + wait for data_exchange.
    // Reason: WhatsApp clients sometimes ignore the data_exchange WELCOME→QUESTION
    //         response and show __example__ values (a known client-side bug).
    //         Solution: Load the question on INIT and go directly to QUESTION.
    if (action === 'init') {
      const today = new Date().toISOString().split('T')[0];
      console.log('[Flow:INIT] fetching question for', today, '— navigating directly to QUESTION');
      await dbg('INIT', { action: 'init', response_screen: 'QUESTION', notes: `date=${today}` });

      const { data: questions, error } = await supabase
        .from('questions')
        .select('id, slot, question_text, english_question, option_a, option_b, option_c, option_d, verse_reference')
        .eq('quiz_date', today)
        .not('status', 'eq', 'rejected')
        .order('slot', { ascending: true })
        .limit(5);

      const q = (!error && questions && questions.length > 0)
        ? (questions.find((q: any) => q.slot === 2) || questions.find((q: any) => q.slot === 1) || questions[0])
        : null;

      const cleanOpt = (s: string) => (s || '').replace(/[\n\r\t]/g, ' ').trim() || '—';
      const optA = cleanOpt(q?.option_a || '');
      const optB = cleanOpt(q?.option_b || '');
      const optC = cleanOpt(q?.option_c || '');
      const optD = cleanOpt(q?.option_d || '');

      const questionData = {
        q1_id:      q ? String(q.id) : '',
        q1_text:    q?.question_text || 'आज की क्विज़ उपलब्ध नहीं है।',
        q1_english: q?.english_question || '',
        q1_options: q ? `A) ${optA}\nB) ${optB}\nC) ${optC}\nD) ${optD}` : 'Quiz not available today.',
        q1_verse:   q?.verse_reference || '',
      };

      await dbg('INIT_QUESTION', {
        action: 'init',
        response_screen: 'QUESTION',
        notes: `q1_id=${questionData.q1_id} q1_text_len=${questionData.q1_text.length} found=${questions?.length ?? 0}`,
        error_msg: error?.message ?? '',
      });
      return res.send(encryptResponse({ version, screen: 'QUESTION', data: questionData }, aesKey, iv));
    }


    // ── data_exchange: WELCOME → "Start Quiz" tapped ──────────────────────────
    if (action === 'data_exchange' && (!screen || screen === 'WELCOME')) {
      const today = new Date().toISOString().split('T')[0];
      console.log('[Flow:DE_WELCOME] fetching question for', today);
      await dbg('DE_WELCOME', { action, screen: screen ?? 'undefined', notes: `date=${today}` });

      const { data: questions, error } = await supabase
        .from('questions')
        .select('id, slot, question_text, english_question, option_a, option_b, option_c, option_d, verse_reference')
        .eq('quiz_date', today)
        .not('status', 'eq', 'rejected')   // send any question — no approval required
        .order('slot', { ascending: true })
        .limit(5);

      console.log('[Flow:DE_WELCOME] questions found:', questions?.length ?? 0, '| error:', error?.message);
      await dbg('DE_WELCOME_Q', {
        action, screen: screen ?? '',
        notes: `found=${questions?.length ?? 0} error=${error?.message ?? 'none'}`,
        error_msg: error?.message ?? '',
      });

      const q = (!error && questions && questions.length > 0)
        ? (questions.find((q: any) => q.slot === 2) || questions.find((q: any) => q.slot === 1) || questions[0])
        : null;

      // CRITICAL: Send ONLY the 5 fields declared in the QUESTION screen data schema.
      // WhatsApp Flow v7.1 REJECTS responses that contain undeclared fields.
      // Schema declares: q1_id, q1_text, q1_english, q1_options, q1_verse
      const cleanOpt = (s: string) => (s || '').replace(/[\n\r\t]/g, ' ').trim() || '—';
      const optA = cleanOpt(q?.option_a || '');
      const optB = cleanOpt(q?.option_b || '');
      const optC = cleanOpt(q?.option_c || '');
      const optD = cleanOpt(q?.option_d || '');

      const questionData = {
        q1_id:      q ? String(q.id) : '',
        q1_text:    q?.question_text || 'आज की क्विज़ उपलब्ध नहीं है।',
        q1_english: q?.english_question || '',
        q1_options: q
          ? `A) ${optA}\nB) ${optB}\nC) ${optC}\nD) ${optD}`
          : 'Quiz not available today.',
        q1_verse:   q?.verse_reference || '',
      };

      console.log('[Flow:QUESTION_DATA] q1_id:', questionData.q1_id, '| optA[:20]:', optA.slice(0, 20));
      await dbg('DE_WELCOME_RESP', {
        action,
        response_screen: 'QUESTION',
        notes: `q1_id=${questionData.q1_id} q1_text_len=${questionData.q1_text.length} optA=${optA.slice(0, 15)}`,
      });
      return res.send(encryptResponse({ version, screen: 'QUESTION', data: questionData }, aesKey, iv));
    }

    // ── data_exchange: QUESTION screen — user submitted answer ─
    if (action === 'data_exchange' && screen === 'QUESTION') {
      const { q1_id, q1_answer } = data;
      const today = new Date().toISOString().split('T')[0];

      console.log('[Flow] Answer submitted. q1_id:', q1_id, '| answer:', q1_answer);

      // Get user phone from JWT flow_token
      const phone = await getUserPhoneFromToken(flow_token);
      if (!phone) {
        console.error('[Flow] Invalid flow token');
        return res.send(encryptResponse({ version, screen: 'WELCOME', data: {} }, aesKey, iv));
      }

      // Fetch user record
      const { data: user } = await supabase
        .from('users')
        .select('id')
        .eq('phone', phone)
        .eq('status', 'active')
        .single();

      if (!user) {
        console.error('[Flow] User not found for phone:', phone);
        // Return SUMMARY with error message instead of crashing the flow
        return res.send(encryptResponse({
          version, screen: 'SUMMARY',
          data: {
            result: '❌ User not registered. Please contact admin.',
            rank: '-', correct_answer: '-', explanation: ''
          }
        }, aesKey, iv));
      }

      // Prevent duplicate submission — return existing result
      const { data: existing } = await supabase
        .from('scores')
        .select('id')
        .eq('user_id', user.id)
        .eq('quiz_date', today)
        .single();

      if (existing) {
        const summary = await buildSummary(user.id, today, q1_id);
        return res.send(encryptResponse({ version, screen: 'SUMMARY', data: summary }, aesKey, iv));
      }

      // Fetch correct answer + explanation
      const { data: question } = await supabase
        .from('questions')
        .select('id, correct_answer, explanation, option_a, option_b, option_c, option_d')
        .eq('id', q1_id)
        .single();

      if (!question) return res.status(404).json({ error: 'Question not found' });

      const isCorrect  = question.correct_answer === q1_answer;
      const score      = isCorrect ? 1 : 0;
      const percentage = isCorrect ? 100.0 : 0.0;

      // Save response
      await supabase.from('responses').insert({
        user_id: user.id, quiz_date: today, question_id: q1_id,
        slot: 1, selected_option: q1_answer, is_correct: isCorrect,
      });

      // Save score
      await supabase.from('scores').insert({
        user_id: user.id, quiz_date: today, score, percentage,
      });

      // Update last_active
      await supabase.from('users')
        .update({ last_active: new Date().toISOString() })
        .eq('id', user.id);

      // Compute rank
      const { count: betterCount } = await supabase
        .from('scores')
        .select('*', { count: 'exact', head: true })
        .eq('quiz_date', today)
        .eq('score', 1)        // only perfect scorers rank above
        .lt('created_at', new Date().toISOString());

      const rank = (betterCount ?? 0) + 1;
      await supabase.from('scores').update({ rank }).eq('user_id', user.id).eq('quiz_date', today);

      // Build option label for display
      const optMap: Record<string, string> = {
        A: question.option_a, B: question.option_b,
        C: question.option_c, D: question.option_d,
      };
      const correctLabel = `${question.correct_answer}) ${optMap[question.correct_answer]}`;

      const summaryData = {
        result:         isCorrect ? '✅ सही! Correct!' : '❌ गलत! Incorrect!',
        rank:           String(rank),
        correct_answer: correctLabel,
        explanation:    question.explanation || '',
      };

      return res.send(encryptResponse({ version, screen: 'SUMMARY', data: summaryData }, aesKey, iv));
    }

    // Default passthrough
    return res.send(encryptResponse({ screen, data: {} }, aesKey, iv));

  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error('[Flow:CATCH] type:', err?.constructor?.name, '| msg:', errMsg);
    console.error('[Flow:CATCH] PRIVATE_KEY set:', !!process.env.WHATSAPP_FLOW_PRIVATE_KEY);
    console.error('[Flow:CATCH] SUPABASE_URL set:', !!process.env.SUPABASE_URL);
    // Log the error to Supabase so it shows up in /api/flow/debug
    await dbg('CATCH_ERROR', {
      error_msg: errMsg,
      notes: `type=${err?.constructor?.name} key=${!!process.env.WHATSAPP_FLOW_PRIVATE_KEY} supabase=${!!process.env.SUPABASE_URL}`,
    }).catch(() => {});
    return res.status(500).json({ error: 'Internal server error', detail: errMsg });
  }
});

// ── Helpers ───────────────────────────────────────────────────

function formatHindiDate(isoDate: string): string {
  const hindiMonths = [
    'जनवरी','फ़रवरी','मार्च','अप्रैल','मई','जून',
    'जुलाई','अगस्त','सितम्बर','अक्टूबर','नवम्बर','दिसम्बर',
  ];
  const hindiDays = ['रविवार','सोमवार','मंगलवार','बुधवार','गुरुवार','शुक्रवार','शनिवार'];
  const d = new Date(isoDate + 'T00:00:00');
  return `${d.getDate()} ${hindiMonths[d.getMonth()]} ${d.getFullYear()}, ${hindiDays[d.getDay()]}`;
}

async function getUserPhoneFromToken(token: string): Promise<string | null> {
  try {
    const jwt = await import('jsonwebtoken');
    const decoded = jwt.default.verify(token, process.env.JWT_SECRET!) as { phone: string };
    return decoded.phone;
  } catch {
    return null;
  }
}

async function buildSummary(userId: string, quizDate: string, q1Id: string) {
  const { data: scoreRow } = await supabase
    .from('scores').select('score, percentage, rank').eq('user_id', userId).eq('quiz_date', quizDate).single();

  const { data: response } = await supabase
    .from('responses').select('is_correct, selected_option').eq('user_id', userId).eq('quiz_date', quizDate).eq('slot', 1).single();

  const { data: question } = await supabase
    .from('questions').select('explanation, correct_answer, option_a, option_b, option_c, option_d').eq('id', q1Id).single();

  const optMap: Record<string, string> = {
    A: question?.option_a || '', B: question?.option_b || '',
    C: question?.option_c || '', D: question?.option_d || '',
  };
  const ca = question?.correct_answer || '';

  return {
    result:         response?.is_correct ? '✅ सही! Correct!' : '❌ गलत! Incorrect!',
    rank:           String(scoreRow?.rank ?? '-'),
    correct_answer: `${ca}) ${optMap[ca]}`,
    explanation:    question?.explanation || '',
  };
}

export default router;
