// ============================================================
// src/routes/flow.route.ts
// WhatsApp Flow Data Exchange Endpoint
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

// ── Types ────────────────────────────────────────────────────
interface FlowPayload {
  q1_id: string;
  q1_answer: 'A' | 'B' | 'C' | 'D';
  q2_id: string;
  q2_answer: 'A' | 'B' | 'C' | 'D';
  q3_id: string;
  q3_answer: 'A' | 'B' | 'C' | 'D';
}

interface FlowRequest {
  version: string;
  action: 'ping' | 'INIT' | 'data_exchange' | 'navigate' | 'BACK';
  screen: string;
  data: FlowPayload;
  flow_token: string;
}

// ── Decrypt WhatsApp Flow request ────────────────────────────
// Returns decrypted body + the AES key/IV needed to encrypt response
function decryptRequest(body: {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
}): { decryptedBody: FlowRequest; aesKey: Buffer; iv: Buffer } {
  const privateKey = process.env.WHATSAPP_FLOW_PRIVATE_KEY!.replace(/\\n/g, '\n');

  // Step 1: RSA-decrypt the AES key
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(body.encrypted_aes_key, 'base64')
  );

  // Step 2: Decode IV
  const iv = Buffer.from(body.initial_vector, 'base64');

  // Step 3: Decode encrypted body
  const encryptedFlowDataBuffer = Buffer.from(body.encrypted_flow_data, 'base64');

  // Step 4: Last 16 bytes = GCM auth tag; rest = cipher text
  const TAG_LENGTH = 16;
  const cipherText = encryptedFlowDataBuffer.subarray(0, -TAG_LENGTH);
  const authTag = encryptedFlowDataBuffer.subarray(-TAG_LENGTH);

  // Step 5: AES-128-GCM decrypt
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);

  const decryptedJSON = Buffer.concat([
    decipher.update(cipherText),
    decipher.final(),
  ]).toString('utf-8');

  return { decryptedBody: JSON.parse(decryptedJSON), aesKey, iv };
}

// ── Encrypt response back to WhatsApp ───────────────────────
// Meta requires the IV to be flipped (bitwise NOT) for the response
function encryptResponse(response: object, aesKey: Buffer, iv: Buffer): string {
  // Flip every byte of the IV
  const flippedIV = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) {
    flippedIV[i] = ~iv[i];
  }

  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIV);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(response), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(), // 16-byte GCM auth tag appended at the end
  ]);
  return encrypted.toString('base64');
}

// ── Main flow handler ────────────────────────────────────────
router.post('/exchange', async (req: Request, res: Response) => {
  try {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;

    // Decrypt the incoming payload
    const { decryptedBody, aesKey, iv } = decryptRequest({
      encrypted_flow_data,
      encrypted_aes_key,
      initial_vector,
    });

    const { action, screen, data, flow_token }: FlowRequest = decryptedBody;

    // ── Health check ping ───────────────────────────────────
    if (action === 'ping') {
      return res.send(encryptResponse({ data: { status: 'active' } }, aesKey, iv));
    }

    // ── INIT: return quiz questions for today ────────────────
    if (action === 'INIT') {
      const today = new Date().toISOString().split('T')[0];

      const { data: questions, error } = await supabase
        .from('questions')
        .select('id, slot, question_text, option_a, option_b, option_c, option_d, verse_reference')
        .eq('quiz_date', today)
        .eq('status', 'approved')
        .order('slot', { ascending: true });

      if (error || !questions || questions.length < 3) {
        return res.send(encryptResponse({
          screen: 'WELCOME',
          data: {
            quiz_date: formatHindiDate(today),
            total_questions: '3',
            error_message: 'आज की क्विज़ अभी उपलब्ध नहीं है।',
          },
        }, aesKey, iv));
      }

      const [q1, q2, q3] = questions;

      return res.send(encryptResponse({
        screen: 'WELCOME',
        data: {
          quiz_date: formatHindiDate(today),
          total_questions: '3',
          // Pre-load all question data so screens can pass IDs forward
          q1_id: q1.id, q1_text: q1.question_text,
          q1_option_a: q1.option_a, q1_option_b: q1.option_b,
          q1_option_c: q1.option_c, q1_option_d: q1.option_d,
          q1_verse: q1.verse_reference,
          q2_id: q2.id, q2_text: q2.question_text,
          q2_option_a: q2.option_a, q2_option_b: q2.option_b,
          q2_option_c: q2.option_c, q2_option_d: q2.option_d,
          q2_verse: q2.verse_reference,
          q3_id: q3.id, q3_text: q3.question_text,
          q3_option_a: q3.option_a, q3_option_b: q3.option_b,
          q3_option_c: q3.option_c, q3_option_d: q3.option_d,
          q3_verse: q3.verse_reference,
        },
      }, aesKey, iv));
    }

    // ── data_exchange: user submitted all answers ────────────
    if (action === 'data_exchange' && screen === 'QUESTION_3') {
      const { q1_id, q1_answer, q2_id, q2_answer, q3_id, q3_answer } = data;
      const today = new Date().toISOString().split('T')[0];

      // Get user phone from JWT flow_token
      const phone = await getUserPhoneFromToken(flow_token);
      if (!phone) {
        return res.status(400).json({ error: 'Invalid flow token' });
      }

      // Fetch user record
      const { data: user } = await supabase
        .from('users')
        .select('id')
        .eq('phone', phone)
        .eq('status', 'active')
        .single();

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Check for duplicate submission (idempotent)
      const { data: existing } = await supabase
        .from('scores')
        .select('id')
        .eq('user_id', user.id)
        .eq('quiz_date', today)
        .single();

      if (existing) {
        const summary = await buildSummary(user.id, today, q1_id, q2_id, q3_id);
        return res.send(encryptResponse({ screen: 'SUMMARY', data: summary }, aesKey, iv));
      }

      // Fetch correct answers for all 3 questions
      const { data: questions } = await supabase
        .from('questions')
        .select('id, slot, correct_answer, explanation, category')
        .in('id', [q1_id, q2_id, q3_id]);

      const qMap = new Map(questions?.map(q => [q.id, q]) || []);
      const q1q = qMap.get(q1_id);
      const q2q = qMap.get(q2_id);
      const q3q = qMap.get(q3_id);

      const q1_correct = q1q?.correct_answer === q1_answer;
      const q2_correct = q2q?.correct_answer === q2_answer;
      const q3_correct = q3q?.correct_answer === q3_answer;
      const score = [q1_correct, q2_correct, q3_correct].filter(Boolean).length;
      const percentage = parseFloat(((score / 3) * 100).toFixed(2));

      // Save individual responses
      await supabase.from('responses').insert([
        { user_id: user.id, quiz_date: today, question_id: q1_id, slot: 1, selected_option: q1_answer, is_correct: q1_correct },
        { user_id: user.id, quiz_date: today, question_id: q2_id, slot: 2, selected_option: q2_answer, is_correct: q2_correct },
        { user_id: user.id, quiz_date: today, question_id: q3_id, slot: 3, selected_option: q3_answer, is_correct: q3_correct },
      ]);

      // Save score (rank computed below)
      await supabase.from('scores').insert({
        user_id: user.id,
        quiz_date: today,
        score,
        percentage,
      });

      // Update user last_active
      await supabase.from('users')
        .update({ last_active: new Date().toISOString() })
        .eq('id', user.id);

      // Compute live rank (approximate — nightly job can recalculate exact)
      const { count: betterCount } = await supabase
        .from('scores')
        .select('*', { count: 'exact', head: true })
        .eq('quiz_date', today)
        .gt('score', score);

      const rank = (betterCount ?? 0) + 1;

      await supabase.from('scores')
        .update({ rank })
        .eq('user_id', user.id)
        .eq('quiz_date', today);

      const summaryData = {
        score: String(score),
        total: '3',
        percentage: String(percentage),
        rank: String(rank),
        q1_result: q1_correct ? '✅ सही' : '❌ गलत',
        q2_result: q2_correct ? '✅ सही' : '❌ गलत',
        q3_result: q3_correct ? '✅ सही' : '❌ गलत',
        q1_explain: q1q?.explanation || '',
        q2_explain: q2q?.explanation || '',
        q3_explain: q3q?.explanation || '',
      };

      return res.send(encryptResponse({ screen: 'SUMMARY', data: summaryData }, aesKey, iv));
    }

    // Default: return current screen with empty data
    return res.send(encryptResponse({ screen, data: {} }, aesKey, iv));

  } catch (err) {
    console.error('[Flow Exchange Error]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Helpers ──────────────────────────────────────────────────

function formatHindiDate(isoDate: string): string {
  const hindiMonths = [
    'जनवरी','फ़रवरी','मार्च','अप्रैल','मई','जून',
    'जुलाई','अगस्त','सितम्बर','अक्टूबर','नवम्बर','दिसम्बर'
  ];
  const d = new Date(isoDate);
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

async function buildSummary(userId: string, quizDate: string, q1Id: string, q2Id: string, q3Id: string) {
  const { data: score } = await supabase
    .from('scores')
    .select('score, percentage, rank')
    .eq('user_id', userId)
    .eq('quiz_date', quizDate)
    .single();

  const { data: responses } = await supabase
    .from('responses')
    .select('slot, is_correct')
    .eq('user_id', userId)
    .eq('quiz_date', quizDate);

  const { data: questions } = await supabase
    .from('questions')
    .select('id, explanation')
    .in('id', [q1Id, q2Id, q3Id]);

  const rMap = new Map(responses?.map(r => [r.slot, r]) || []);
  const qMap = new Map(questions?.map(q => [q.id, q]) || []);

  return {
    score: String(score?.score ?? 0),
    total: '3',
    percentage: String(score?.percentage ?? 0),
    rank: String(score?.rank ?? '-'),
    q1_result: rMap.get(1)?.is_correct ? '✅ सही' : '❌ गलत',
    q2_result: rMap.get(2)?.is_correct ? '✅ सही' : '❌ गलत',
    q3_result: rMap.get(3)?.is_correct ? '✅ सही' : '❌ गलत',
    q1_explain: qMap.get(q1Id)?.explanation || '',
    q2_explain: qMap.get(q2Id)?.explanation || '',
    q3_explain: qMap.get(q3Id)?.explanation || '',
  };
}

export default router;
