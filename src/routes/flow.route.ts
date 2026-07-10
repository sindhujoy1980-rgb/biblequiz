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

// ── Main handler ──────────────────────────────────────────────
router.post('/exchange', async (req: Request, res: Response) => {
  try {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;
    const { decryptedBody, aesKey, iv } = decryptRequest({ encrypted_flow_data, encrypted_aes_key, initial_vector });
    const { action, screen, data, flow_token, version } = decryptedBody as any;

    // ── Health ping ──────────────────────────────────────────
    if (action === 'ping') {
      return res.send(encryptResponse({ version, data: { status: 'active' } }, aesKey, iv));
    }

    // ── INIT: Load today's single question ───────────────────
    if (action === 'INIT') {
      const today = new Date().toISOString().split('T')[0];

      // Fetch approved question (only columns that exist in admin's questions table)
      const { data: questions, error } = await supabase
        .from('questions')
        .select('id, slot, category, question_text, english_question, option_a, option_b, option_c, option_d, verse_reference')
        .eq('quiz_date', today)
        .eq('status', 'approved')
        .order('slot', { ascending: true })
        .limit(5);

      // Fetch today's readings (liturgical_day + gospel_ref live here)
      const { data: readings } = await supabase
        .from('daily_readings')
        .select('liturgical_day, gospel_ref, first_reading_ref')
        .eq('reading_date', today)
        .single();

      if (error || !questions || questions.length === 0) {
        console.log('[Flow INIT] No questions found. error:', error?.message, 'questions:', questions?.length);
        const errData = {
          quiz_date: formatHindiDate(today),
          liturgical_day: readings?.liturgical_day || 'आज का सुसमाचार',
          gospel_ref: readings?.gospel_ref || readings?.first_reading_ref || '—',
          error_message: 'आज की क्विज़ अभी उपलब्ध नहीं है।',
        };
        console.log('[Flow INIT] Sending error data keys:', Object.keys(errData).join(', '));
        return res.send(encryptResponse({ version, screen: 'WELCOME', data: errData }, aesKey, iv));
      }

      // Prefer Gospel question (slot 2), fall back to any approved question
      const q = questions.find((q: any) => q.slot === 2)
             || questions.find((q: any) => q.slot === 1)
             || questions[0];

      const initData = {
          quiz_date:   formatHindiDate(today),
          liturgical_day: readings?.liturgical_day || 'आज का सुसमाचार',
          gospel_ref:  readings?.gospel_ref || q.verse_reference || '—',
          q1_id:       String(q.id),
          q1_roman:    q.question_text,
          q1_text:     q.question_text,
          q1_english:  q.english_question || '',
          q1_option_a: q.option_a,
          q1_option_b: q.option_b,
          q1_option_c: q.option_c,
          q1_option_d: q.option_d,
          q1_verse:    q.verse_reference || '',
      };
      console.log('[Flow INIT] version:', version, 'screen: WELCOME, data keys:', Object.keys(initData).join(', '));
      console.log('[Flow INIT] Sample values — quiz_date:', initData.quiz_date, '| q1_roman[:50]:', initData.q1_roman?.slice(0, 50));
      return res.send(encryptResponse({ version, screen: 'WELCOME', data: initData }, aesKey, iv));
    }

    // ── data_exchange: User submitted their single answer ────
    if (action === 'data_exchange' && screen === 'QUESTION') {
      const { q1_id, q1_answer } = data;
      const today = new Date().toISOString().split('T')[0];

      // Get user phone from JWT flow_token
      const phone = await getUserPhoneFromToken(flow_token);
      if (!phone) return res.status(400).json({ error: 'Invalid flow token' });

      // Fetch user record
      const { data: user } = await supabase
        .from('users')
        .select('id')
        .eq('phone', phone)
        .eq('status', 'active')
        .single();

      if (!user) return res.status(404).json({ error: 'User not found' });

      // Prevent duplicate submission — return existing result
      const { data: existing } = await supabase
        .from('scores')
        .select('id')
        .eq('user_id', user.id)
        .eq('quiz_date', today)
        .single();

      if (existing) {
        const summary = await buildSummary(user.id, today, q1_id);
        return res.send(encryptResponse({ screen: 'SUMMARY', data: summary }, aesKey, iv));
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

      return res.send(encryptResponse({ screen: 'SUMMARY', data: summaryData }, aesKey, iv));
    }

    // Default passthrough
    return res.send(encryptResponse({ screen, data: {} }, aesKey, iv));

  } catch (err: any) {
    console.error('[Flow Exchange Error] type:', err?.constructor?.name);
    console.error('[Flow Exchange Error] message:', err?.message);
    console.error('[Flow Exchange Error] WHATSAPP_FLOW_PRIVATE_KEY set:', !!process.env.WHATSAPP_FLOW_PRIVATE_KEY);
    console.error('[Flow Exchange Error] SUPABASE_URL set:', !!process.env.SUPABASE_URL);
    return res.status(500).json({ error: 'Internal server error', detail: err?.message });
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
