// ============================================================
// src/routes/flow.route.ts
// WhatsApp Flow Data Exchange â€” SINGLE QUESTION per day
// POST /api/flow/exchange  â† Meta calls this
// ============================================================

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Decrypt WhatsApp Flow request â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Encrypt response back to WhatsApp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// ————————————————————————————————————————————————————————————
// Diagnostic: GET /api/flow/test-exchange ──────────────────────────
// Shows EXACTLY what JSON would be encrypted and sent for QUESTION screen
// Call: https://biblequiz-five.vercel.app/api/flow/test-exchange
router.get('/test-exchange', async (_req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: questions, error } = await supabase
      .from('questions')
      .select('id, slot, question_text, english_question, option_a, option_b, option_c, option_d, verse_reference, correct_answer, category, status')
      .eq('quiz_date', today)
      .not('status', 'eq', 'rejected')
      .order('slot', { ascending: true })
      .limit(5);

    // Priority: Gospel category first (NT-Gospel or Gospel), then slot=1, then any
    const isGospel = (q: any) => ['NT-Gospel', 'Gospel'].includes(q.category);
    const q = (!error && questions && questions.length > 0)
      ? (questions.find(isGospel)
        || questions.find((q: any) => q.slot === 1)
        || questions[0])
      : null;

    const cleanOpt = (s: string) => (s || '').replace(/[\n\r\t]/g, ' ').trim() || '—';

    const questionData = q ? {
      q_id:      String(q.id),
      q_text:    q.question_text    || 'आज का प्रश्न उपलब्ध नहीं।',
      q_english: q.english_question || '',
      q_verse:   q.verse_reference  || '',
      q_options: [
        { id: 'A', title: `A) ${cleanOpt(q.option_a)}` },
        { id: 'B', title: `B) ${cleanOpt(q.option_b)}` },
        { id: 'C', title: `C) ${cleanOpt(q.option_c)}` },
        { id: 'D', title: `D) ${cleanOpt(q.option_d)}` },
      ],
    } : {
      q_id: '', q_text: 'आज की क्विज़ उपलब्ध नहीं है।',
      q_english: 'Quiz not available today.', q_verse: '',
      q_options: [
        { id: 'A', title: 'A) —' }, { id: 'B', title: 'B) —' },
        { id: 'C', title: 'C) —' }, { id: 'D', title: 'D) —' },
      ],
    };

    const fullResponse = { version: '3.0', screen: 'QUESTION', data: questionData };
    const jsonStr = JSON.stringify(fullResponse);

    return res.json({
      today,
      questionsFound:   questions?.length ?? 0,
      queryError:       error?.message ?? null,
      selectedSlot:     q?.slot ?? null,
      selectedId:       q?.id ?? null,
      selectedCategory: (q as any)?.category ?? null,
      selectedStatus:   (q as any)?.status ?? null,
      optionsCount:     questionData.q_options.length,
      questionData,
      fullResponse,
      jsonLength:  jsonStr.length,
      jsonPreview: jsonStr.substring(0, 500),
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
    if (error) return res.json({ error: error.message, hint: 'Table may not exist yet â€” see instructions below', sql: 'CREATE TABLE flow_debug_logs (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), step TEXT, action TEXT, screen TEXT, body_keys TEXT, error_msg TEXT, response_screen TEXT, notes TEXT);' });
    return res.json({ count: data?.length, logs: data });
  } catch (e: any) {
    return res.json({ error: e.message });
  }
});

// â”€â”€ Diagnostic: GET /api/flow/check-meta-flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      questionScreenLayout,       // â† FULL LAYOUT: exact component text/variable refs
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

// â”€â”€ Helper: write one debug row to Supabase (fail-silently) â”€â”€
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

// â”€â”€ Main exchange handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/exchange', async (req: Request, res: Response) => {
  try {
    const bodyKeys = Object.keys(req.body || {}).join(',');
    await dbg('ARRIVED', { body_keys: bodyKeys, action: req.body?.action ?? '' });

    // â”€â”€ Plain-text ping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (req.body?.action === 'ping') {
      await dbg('PLAIN_PING', { action: 'ping', response_screen: 'active' });
      return res.json({ data: { status: 'active' } });
    }

    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;
    await dbg('PRE_DECRYPT', {
      body_keys: bodyKeys,
      notes: `efdata=${!!encrypted_flow_data} key=${!!encrypted_aes_key} iv=${!!initial_vector}`,
    });

    let decryptedBody: any, aesKey: Buffer, iv: Buffer;
    try {
      ({ decryptedBody, aesKey, iv } = decryptRequest({ encrypted_flow_data, encrypted_aes_key, initial_vector }));
    } catch (decryptErr: any) {
      await dbg('DECRYPT_FAIL', { error_msg: decryptErr.message, body_keys: bodyKeys });
      return res.status(500).json({ error: 'decryption failed', detail: decryptErr.message });
    }

    const { action: rawAction, screen, data: payload, flow_token, version } = decryptedBody as any;
    const action = (rawAction || '').toLowerCase();
    await dbg('DECRYPTED', {
      action, screen: screen ?? '',
      notes: `version=${version} token=${flow_token ? 'present' : 'MISSING'}`,
    });

    // â”€â”€ Encrypted ping (Meta health check) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (action === 'ping') {
      await dbg('ENC_PING', { action: 'ping', response_screen: 'active' });
      return res.send(encryptResponse({ version, data: { status: 'active' } }, aesKey, iv));
    }

    const today   = new Date().toISOString().split('T')[0];
    const cleanOpt = (s: string) => (s || '').replace(/[\n\r\t]/g, ' ').trim() || '—';

    // ── INIT → Return WELCOME screen with today's date ──────────
    if (action === 'init') {
      const hindiDate = formatHindiDate(today);
      await dbg('INIT', { action, response_screen: 'WELCOME', notes: `date=${today}` });
      return res.send(encryptResponse({
        version, screen: 'WELCOME',
        data: { quiz_date: hindiDate },
      }, aesKey, iv));
    }

    // ── data_exchange: WELCOME "Start Quiz" → serve Gospel question ─────
    if (action === 'data_exchange' && (!screen || screen === 'WELCOME')) {
      await dbg('DE_WELCOME', { action, screen: screen ?? '', notes: `date=${today}` });

      // ── Already-answered guard: send to COMPLETE if user already submitted today ──
      const phoneFromToken = await getUserPhoneFromToken(flow_token);
      if (phoneFromToken) {
        const { data: existingUser } = await supabase
          .from('users').select('id').eq('phone', phoneFromToken).eq('status', 'active').single();
        if (existingUser) {
          const { data: todayScore } = await supabase
            .from('scores').select('id').eq('user_id', existingUser.id).eq('quiz_date', today).maybeSingle();
          if (todayScore) {
            await dbg('DE_WELCOME_ALREADY_DONE', { action, notes: `user ${existingUser.id} already answered today` });
            return res.send(encryptResponse({ version, screen: 'COMPLETE', data: {} }, aesKey, iv));
          }
        }
      }


      const { data: questions, error } = await supabase
        .from('questions')
        .select('id, slot, category, question_text, english_question, option_a, option_b, option_c, option_d, verse_reference')
        .eq('quiz_date', today)
        .not('status', 'eq', 'rejected')
        .order('slot', { ascending: true })
        .limit(5);

      await dbg('DE_WELCOME_Q', {
        action, notes: `found=${questions?.length ?? 0} error=${error?.message ?? 'none'}`,
      });

      // Priority: Gospel category first (NT-Gospel or Gospel), then slot=1, then any
      const isGospel = (q: any) => ['NT-Gospel', 'Gospel'].includes(q.category);
      const q = (!error && questions && questions.length > 0)
        ? (questions.find(isGospel)
          || questions.find((q: any) => q.slot === 1)
          || questions[0])
        : null;

      const questionData = q ? {
        q_id:      String(q.id),
        q_text:    q.question_text    || 'आज का प्रश्न उपलब्ध नहीं।',
        q_english: q.english_question || '',
        q_verse:   q.verse_reference  || '',
        q_options: [
          { id: 'A', title: `A) ${cleanOpt(q.option_a)}` },
          { id: 'B', title: `B) ${cleanOpt(q.option_b)}` },
          { id: 'C', title: `C) ${cleanOpt(q.option_c)}` },
          { id: 'D', title: `D) ${cleanOpt(q.option_d)}` },
        ],
      } : {
        q_id: '', q_text: 'आज की क्विज़ उपलब्ध नहीं है।',
        q_english: 'Quiz not available today.', q_verse: '',
        q_options: [
          { id: 'A', title: 'A) —' }, { id: 'B', title: 'B) —' },
          { id: 'C', title: 'C) —' }, { id: 'D', title: 'D) —' },
        ],
      };

      await dbg('DE_WELCOME_RESP', {
        action, response_screen: 'QUESTION',
        notes: `q_id=${questionData.q_id} q_text_len=${questionData.q_text.length}`,
      });
      return res.send(encryptResponse({ version, screen: 'QUESTION', data: questionData }, aesKey, iv));
    }

    // â”€â”€ data_exchange: QUESTION "Submit Answer" â†’ score â†’ SUMMARY â”€â”€
    if (action === 'data_exchange' && screen === 'QUESTION') {
      const { q_id, q_answer } = payload || {};
      await dbg('DE_QUESTION', { action, screen, notes: `q_id=${q_id} answer=${q_answer}` });

      // Resolve user from JWT
      const phone = await getUserPhoneFromToken(flow_token);
      if (!phone) {
        await dbg('DE_QUESTION_ERR', { error_msg: 'invalid flow_token' });
        return res.send(encryptResponse({
          version, screen: 'SUMMARY',
          data: { result: 'Error: Token invalid', correct_label: 'Please re-open the quiz.', explanation: '', rank_label: '' },
        }, aesKey, iv));
      }

      const { data: user } = await supabase
        .from('users').select('id').eq('phone', phone).eq('status', 'active').single();

      if (!user) {
        return res.send(encryptResponse({
          version, screen: 'SUMMARY',
          data: { result: 'Error: User not registered', correct_label: 'Please contact admin.', explanation: '', rank_label: '' },
        }, aesKey, iv));
      }

      // Prevent duplicate submission â€” return existing result if already answered
      const { data: existing } = await supabase
        .from('scores').select('id').eq('user_id', user.id).eq('quiz_date', today).single();

      if (existing) {
        const summary = await buildSummary(user.id, today, String(q_id));
        await dbg('DE_QUESTION_DUP', { action, notes: `duplicate submission for user ${user.id}` });
        return res.send(encryptResponse({ version, screen: 'SUMMARY', data: summary }, aesKey, iv));
      }

      // Fetch correct answer and explanation
      const { data: question } = await supabase
        .from('questions')
        .select('id, correct_answer, explanation, option_a, option_b, option_c, option_d')
        .eq('id', q_id)
        .single();

      if (!question) {
        return res.send(encryptResponse({
          version, screen: 'SUMMARY',
          data: { result: 'Error: Question not found', correct_label: '', explanation: '', rank_label: '' },
        }, aesKey, iv));
      }

      const isCorrect  = (question.correct_answer || '').toUpperCase() === (q_answer || '').toUpperCase();
      const score      = isCorrect ? 1 : 0;
      const percentage = isCorrect ? 100.0 : 0.0;

      // Save response
      await supabase.from('responses').insert({
        user_id: user.id, quiz_date: today, question_id: q_id,
        slot: 1, selected_option: q_answer, is_correct: isCorrect,
      });

      // Compute rank
      const { count: betterCount } = await supabase
        .from('scores')
        .select('*', { count: 'exact', head: true })
        .eq('quiz_date', today)
        .eq('score', 1)
        .lt('created_at', new Date().toISOString());

      const rank = (betterCount ?? 0) + 1;

      // Save score
      await supabase.from('scores').insert({
        user_id: user.id, quiz_date: today, score, percentage, rank,
      });

      // Update last_active
      await supabase.from('users').update({ last_active: new Date().toISOString() }).eq('id', user.id);

      // Build correct answer display label
      const optMap: Record<string, string> = {
        A: question.option_a, B: question.option_b,
        C: question.option_c, D: question.option_d,
      };
      const ca = (question.correct_answer || '').toUpperCase();
      const correctLabel = `${ca}) ${cleanOpt(optMap[ca] || '')}`;

      const summaryData = {
        result:     isCorrect ? 'Correct!' : 'Incorrect!',
        rank_label: 'Today\'s Rank: #' + String(rank),
        thank_you:  'Your response has been recorded. See you tomorrow!',
      };

      await dbg('DE_QUESTION_RESP', {
        action, response_screen: 'SUMMARY',
        notes: `correct=${isCorrect} rank=${rank} score=${score}`,
      });
      return res.send(encryptResponse({ version, screen: 'SUMMARY', data: summaryData }, aesKey, iv));
    }

    // Default fallthrough
    await dbg('UNHANDLED', { action, screen: screen ?? '', notes: 'no handler matched' });
    return res.send(encryptResponse({ version, screen: 'WELCOME', data: { quiz_date: formatHindiDate(today) } }, aesKey, iv));

  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    await dbg('CATCH_ERROR', {
      error_msg: errMsg,
      notes: `type=${err?.constructor?.name} key=${!!process.env.WHATSAPP_FLOW_PRIVATE_KEY}`,
    }).catch(() => {});
    return res.status(500).json({ error: 'Internal server error', detail: errMsg });
  }
});

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function formatHindiDate(isoDate: string): string {
  const hindiMonths = [
    'à¤œà¤¨à¤µà¤°à¥€','à¤«à¤¼à¤°à¤µà¤°à¥€','à¤®à¤¾à¤°à¥à¤š','à¤…à¤ªà¥à¤°à¥ˆà¤²','à¤®à¤ˆ','à¤œà¥‚à¤¨',
    'à¤œà¥à¤²à¤¾à¤ˆ','à¤…à¤—à¤¸à¥à¤¤','à¤¸à¤¿à¤¤à¤®à¥à¤¬à¤°','à¤…à¤•à¥à¤Ÿà¥‚à¤¬à¤°','à¤¨à¤µà¤®à¥à¤¬à¤°','à¤¦à¤¿à¤¸à¤®à¥à¤¬à¤°',
  ];
  const d = new Date(isoDate + 'T00:00:00');
  return `${d.getDate()} ${hindiMonths[d.getMonth()]} ${d.getFullYear()}`;
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
    .from('scores').select('score, rank').eq('user_id', userId).eq('quiz_date', quizDate).single();

  const { data: response } = await supabase
    .from('responses').select('is_correct, selected_option')
    .eq('user_id', userId).eq('quiz_date', quizDate).eq('slot', 1).single();

  const { data: question } = await supabase
    .from('questions').select('explanation, correct_answer, option_a, option_b, option_c, option_d')
    .eq('id', q1Id).single();

  const optMap: Record<string, string> = {
    A: question?.option_a || '', B: question?.option_b || '',
    C: question?.option_c || '', D: question?.option_d || '',
  };
  const ca = (question?.correct_answer || '').toUpperCase();

  return {
    result:     response?.is_correct ? 'Correct!' : 'Incorrect!',
    rank_label: 'Today\'s Rank: #' + String(scoreRow?.rank ?? '-'),
    thank_you:  'Your response has been recorded. See you tomorrow!',
  };
}

export default router;
