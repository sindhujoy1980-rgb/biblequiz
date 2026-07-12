// ============================================================
// src/routes/flow.route.ts
// WhatsApp Flow Data Exchange - SINGLE QUESTION per day
// POST /api/flow/exchange  <- Meta calls this
// ============================================================

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// -- Types ---------------------------------------------------
interface FlowPayload {
  q_id: string;
  q_answer: 'A' | 'B' | 'C' | 'D';
}

interface FlowRequest {
  version: string;
  action: 'ping' | 'INIT' | 'data_exchange' | 'navigate' | 'BACK';
  screen: string;
  data: FlowPayload;
  flow_token: string;
}

// -- Decrypt WhatsApp Flow request ---------------------------
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

// -- Encrypt response back to WhatsApp -----------------------
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

// -- Diagnostic: GET /api/flow/test-exchange -----------------
// Shows EXACTLY what JSON would be encrypted and sent for QUESTION screen
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

    const isGospel = (q: any) => ['NT-Gospel', 'Gospel'].includes(q.category);
    const q = (!error && questions && questions.length > 0)
      ? (questions.find(isGospel) || questions.find((q: any) => q.slot === 1) || questions[0])
      : null;

    const cleanOpt = (s: string) => (s || '').replace(/[\n\r\t]/g, ' ').trim() || '--';

    const questionData = q ? {
      q_id:      String(q.id),
      q_text:    q.question_text    || 'Question not available.',
      q_english: q.english_question || '',
      q_verse:   q.verse_reference  || '',
      q_options: [
        { id: 'A', title: `A) ${cleanOpt(q.option_a)}` },
        { id: 'B', title: `B) ${cleanOpt(q.option_b)}` },
        { id: 'C', title: `C) ${cleanOpt(q.option_c)}` },
        { id: 'D', title: `D) ${cleanOpt(q.option_d)}` },
      ],
    } : {
      q_id: '', q_text: 'Today quiz not available.',
      q_english: 'Quiz not available today.', q_verse: '',
      q_options: [
        { id: 'A', title: 'A) --' }, { id: 'B', title: 'B) --' },
        { id: 'C', title: 'C) --' }, { id: 'D', title: 'D) --' },
      ],
    };

    return res.json({
      today,
      questionsFound: questions?.length ?? 0,
      queryError: error?.message ?? null,
      selectedSlot: q?.slot ?? null,
      selectedId: q?.id ?? null,
      selectedCategory: q?.category ?? null,
      selectedStatus: q?.status ?? null,
      optionsCount: questionData.q_options.length,
      questionData,
      fullResponse: { version: '3.0', screen: 'QUESTION', data: questionData },
      jsonLength: JSON.stringify({ version: '3.0', screen: 'QUESTION', data: questionData }).length,
      jsonPreview: JSON.stringify({ version: '3.0', screen: 'QUESTION', data: questionData }).slice(0, 300),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0, 5) });
  }
});

// -- Helper: write debug row to Supabase (fail-silently) -----
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

// -- Main exchange handler ------------------------------------
router.post('/exchange', async (req: Request, res: Response) => {
  try {
    const bodyKeys = Object.keys(req.body || {}).join(',');
    await dbg('ARRIVED', { body_keys: bodyKeys, action: req.body?.action ?? '' });

    // Plain-text ping
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

    // Encrypted ping (Meta health check)
    if (action === 'ping') {
      await dbg('ENC_PING', { action: 'ping', response_screen: 'active' });
      return res.send(encryptResponse({ version, data: { status: 'active' } }, aesKey, iv));
    }

    const today    = new Date().toISOString().split('T')[0];
    const cleanOpt = (s: string) => (s || '').replace(/[\n\r\t]/g, ' ').trim() || '--';

    // -- INIT -> Return WELCOME screen (static, no data needed) --
    if (action === 'init') {
      await dbg('INIT', { action, response_screen: 'WELCOME', notes: `date=${today}` });
      return res.send(encryptResponse({ version, screen: 'WELCOME', data: {} }, aesKey, iv));
    }

    // -- data_exchange: WELCOME "Start Quiz" -> serve Gospel question --
    if (action === 'data_exchange' && (!screen || screen === 'WELCOME')) {
      await dbg('DE_WELCOME', { action, screen: screen ?? '', notes: `date=${today}` });

      // Already-answered guard: send to COMPLETE if user already submitted today
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
        ? (questions.find(isGospel) || questions.find((q: any) => q.slot === 1) || questions[0])
        : null;

      const questionData = q ? {
        q_id:      String(q.id),
        q_text:    q.question_text    || 'Question not available today.',
        q_english: q.english_question || '',
        q_verse:   q.verse_reference  || '',
        q_options: [
          { id: 'A', title: `A) ${cleanOpt(q.option_a)}` },
          { id: 'B', title: `B) ${cleanOpt(q.option_b)}` },
          { id: 'C', title: `C) ${cleanOpt(q.option_c)}` },
          { id: 'D', title: `D) ${cleanOpt(q.option_d)}` },
        ],
      } : {
        q_id: '', q_text: 'Quiz not available today.',
        q_english: 'Quiz not available today.', q_verse: '',
        q_options: [
          { id: 'A', title: 'A) --' }, { id: 'B', title: 'B) --' },
          { id: 'C', title: 'C) --' }, { id: 'D', title: 'D) --' },
        ],
      };

      await dbg('DE_WELCOME_RESP', {
        action, response_screen: 'QUESTION',
        notes: `q_id=${questionData.q_id} q_text_len=${questionData.q_text.length}`,
      });
      return res.send(encryptResponse({ version, screen: 'QUESTION', data: questionData }, aesKey, iv));
    }

    // -- data_exchange: QUESTION "Submit Answer" -> score -> SUMMARY --
    if (action === 'data_exchange' && screen === 'QUESTION') {
      const { q_id, q_answer } = payload || {};
      await dbg('DE_QUESTION', { action, screen, notes: `q_id=${q_id} answer=${q_answer}` });

      // Resolve user from JWT
      const phone = await getUserPhoneFromToken(flow_token);
      if (!phone) {
        await dbg('DE_QUESTION_ERR', { error_msg: 'invalid flow_token' });
        return res.send(encryptResponse({
          version, screen: 'SUMMARY',
          data: { result: 'Error: Token expired.', rank_label: '', thank_you: 'Please open a new quiz message.' },
        }, aesKey, iv));
      }

      const { data: user } = await supabase
        .from('users').select('id').eq('phone', phone).eq('status', 'active').single();

      if (!user) {
        return res.send(encryptResponse({
          version, screen: 'SUMMARY',
          data: { result: 'Error: Not registered.', rank_label: '', thank_you: 'Please contact the admin to be added.' },
        }, aesKey, iv));
      }

      // Prevent duplicate submission - return existing result if already answered
      const { data: existing } = await supabase
        .from('scores').select('id').eq('user_id', user.id).eq('quiz_date', today).single();

      if (existing) {
        const summary = await buildSummary(user.id, today);
        await dbg('DE_QUESTION_DUP', { action, notes: `duplicate submission for user ${user.id}` });
        return res.send(encryptResponse({ version, screen: 'SUMMARY', data: summary }, aesKey, iv));
      }

      // Fetch correct answer
      const { data: question } = await supabase
        .from('questions')
        .select('id, correct_answer, explanation, option_a, option_b, option_c, option_d')
        .eq('id', q_id)
        .single();

      if (!question) {
        return res.send(encryptResponse({
          version, screen: 'SUMMARY',
          data: { result: 'Error: Question not found.', rank_label: '', thank_you: 'Please contact the admin.' },
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

      const summaryData = {
        result:     isCorrect ? 'Correct!' : 'Incorrect!',
        rank_label: "Today's Rank: #" + String(rank),
        thank_you:  'Your response has been recorded. See you tomorrow!',
      };

      await dbg('DE_QUESTION_RESP', {
        action, response_screen: 'SUMMARY',
        notes: `correct=${isCorrect} rank=${rank} score=${score}`,
      });
      return res.send(encryptResponse({ version, screen: 'SUMMARY', data: summaryData }, aesKey, iv));
    }

    // Default fallthrough - send user back to WELCOME (static, no data)
    await dbg('UNHANDLED', { action, screen: screen ?? '', notes: 'no handler matched' });
    return res.send(encryptResponse({ version, screen: 'WELCOME', data: {} }, aesKey, iv));

  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    await dbg('CATCH_ERROR', {
      error_msg: errMsg,
      notes: `type=${err?.constructor?.name} key=${!!process.env.WHATSAPP_FLOW_PRIVATE_KEY}`,
    }).catch(() => {});
    return res.status(500).json({ error: 'Internal server error', detail: errMsg });
  }
});

// -- Helpers -------------------------------------------------

function formatHindiDate(isoDate: string): string {
  const hindiMonths = [
    'जनवरी','फ़रवरी','मार्च','अप्रैल','मई','जून',
    'जुलाई','अगस्त','सितंबर','अक्टूबर','नवंबर','दिसंबर',
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

// buildSummary: used when user tries to re-submit (already has a score row)
async function buildSummary(userId: string, quizDate: string) {
  const { data: scoreRow } = await supabase
    .from('scores').select('score, rank').eq('user_id', userId).eq('quiz_date', quizDate).single();

  const { data: response } = await supabase
    .from('responses').select('is_correct')
    .eq('user_id', userId).eq('quiz_date', quizDate).eq('slot', 1).single();

  return {
    result:     response?.is_correct ? 'Correct!' : 'Incorrect!',
    rank_label: "Today's Rank: #" + String(scoreRow?.rank ?? '-'),
    thank_you:  'Your response has been recorded. See you tomorrow!',
  };
}

export default router;