// ============================================================
// src/routes/cron.route.ts
// Cron Job Endpoints — called by cron-job.org (free)
//
// Endpoints:
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

// ── Auth middleware: validate cron secret ─────────────────────
function validateCronSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized: invalid cron secret' });
    return;
  }
  next();
}

router.use(validateCronSecret);

// ── POST /api/cron/generate-questions ────────────────────────
// Generates tomorrow's quiz question via Gemini AI (Gospel-based)
// Schedule: daily at 11 PM IST (on cron-job.org)
router.post('/generate-questions', async (req: Request, res: Response) => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const quizDate = tomorrow.toISOString().split('T')[0];

    const { data: existing } = await supabase
      .from('questions')
      .select('id')
      .eq('quiz_date', quizDate)
      .limit(1);

    if (existing && existing.length > 0) {
      return res.json({
        success: true,
        message: `Questions already exist for ${quizDate} — skipped`,
        quizDate,
      });
    }

    console.log(`[Cron] Generating questions for ${quizDate}...`);
    const questions = await generateDailyQuestions(quizDate);
    await saveQuestions(questions, quizDate);

    return res.json({
      success: true,
      message: `✅ Generated ${questions.length} question(s) for ${quizDate}`,
      quizDate,
      count: questions.length,
    });

  } catch (err: any) {
    console.error('[Cron] generate-questions error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/cron/send-quiz ──────────────────────────────────
// Sends today's quiz to all active users via WhatsApp template
// Schedule: daily at 8:00 AM IST (on cron-job.org)
router.post('/send-quiz', async (req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Verify at least 1 question exists for today (no approval required)
    const { data: questions, error: qError } = await supabase
      .from('questions')
      .select('id')
      .eq('quiz_date', today)
      .not('status', 'eq', 'rejected')
      .limit(1);

    if (qError || !questions || questions.length < 1) {
      return res.status(400).json({
        success: false,
        error: `Cannot send quiz: No question found for ${today}. Please generate at least one question in admin panel.`,
      });
    }

    // Fetch all active users
    const { data: users, error: uError } = await supabase
      .from('users')
      .select('id, phone, name')
      .eq('status', 'active');

    if (uError || !users) {
      return res.status(500).json({ success: false, error: 'Failed to fetch users' });
    }

    console.log(`[Cron] Sending quiz to ${users.length} users for ${today} (parallel)...`);

    const results = await Promise.allSettled(
      users.map(user => sendQuizMessage(user.phone, user.name, today))
    );

    let sent = 0;
    let failed = 0;
    const failedPhones: string[] = [];
    const debugResults: any[] = [];

    results.forEach((result, i) => {
      const user = users[i];
      if (result.status === 'fulfilled') {
        sent++;
        debugResults.push({ phone: user.phone, status: 'sent', messageId: result.value });
        console.log(`[Send] ✅ ${user.phone} messageId=${result.value}`);
      } else {
        failed++;
        failedPhones.push(user.phone);
        debugResults.push({ phone: user.phone, status: 'failed', error: result.reason?.message });
        console.error(`[Send] ❌ ${user.phone}:`, result.reason?.message);
      }
    });

    await supabase
      .from('quizzes')
      .update({ published: true, published_at: new Date().toISOString() })
      .eq('quiz_date', today);

    return res.json({
      success: true,
      message: `Quiz sent for ${today}`,
      sent,
      failed,
      total: users.length,
      failedPhones: failedPhones.slice(0, 10),
      debug: debugResults,
    });

  } catch (err: any) {
    console.error('[Cron] send-quiz error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── sendQuizMessage ───────────────────────────────────────────
// Sends daily quiz via WhatsApp approved template.
// Template includes: readings excerpt + reflection + Flow quiz button.
async function sendQuizMessage(phone: string, name: string, quizDate: string): Promise<string> {
  const jwt = await import('jsonwebtoken');

  // JWT flow_token — verified by the flow endpoint to identify the user
  const flowToken = jwt.default.sign(
    { phone },
    process.env.JWT_SECRET!,
    { expiresIn: '24h' }
  );

  // Fetch today's readings + reflection from Supabase
  const { data: readings } = await supabase
    .from('daily_readings')
    .select('liturgical_day, first_reading_ref, first_reading_text, gospel_ref, gospel_text, reflection_en, reflection_hi')
    .eq('reading_date', quizDate)
    .single();

  const firstName     = name.split(' ')[0];
  const templateName  = process.env.WHATSAPP_TEMPLATE_NAME || 'bible_quiz_with_readings';
  // Keep header short — Meta enforces a strict 60-char limit on header parameters.
  // 'Friday, 11 July 2026' was 62 chars total with prefix → Meta error #132005.
  // '11 Jul 2026' keeps total header well under 60 chars.
  const dateFormatted = new Date(quizDate).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

  // WhatsApp template params CANNOT contain newlines — use ' | ' as separator
  const clean = (s: string) => s.replace(/[\n\r\t]/g, ' ').replace(/ {5,}/g, '    ').trim();

  const liturgicalDay = clean(readings?.liturgical_day || 'Catholic Daily Readings').slice(0, 60);
  const firstReading  = readings?.first_reading_ref
    ? clean(`${readings.first_reading_ref} — ${(readings.first_reading_text || '').slice(0, 80)}`).slice(0, 150)
    : 'First Reading not available';
  const gospel        = readings?.gospel_ref
    ? clean(`${readings.gospel_ref} — ${(readings.gospel_text || '').slice(0, 80)}`).slice(0, 150)
    : 'Gospel not available';
  const reflection    = readings?.reflection_en
    ? clean(readings.reflection_en).slice(0, 120)
    : "Reflect on today's Gospel and let it guide your day.";

  console.log(`[WhatsApp] Sending template "${templateName}" to ${phone} (${firstName})`);

  const response = await fetch(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'en' },
          components: [
            {
              type: 'header',
              parameters: [
                { type: 'text', text: `📖 Bible Quiz Daily — ${dateFormatted}` },
              ],
            },
            {
              type: 'body',
              parameters: [
                { type: 'text', text: liturgicalDay },  // {{1}}
                { type: 'text', text: firstReading },   // {{2}}
                { type: 'text', text: gospel },         // {{3}}
                { type: 'text', text: reflection },     // {{4}}
                { type: 'text', text: firstName },      // {{5}}
              ],
            },
            {
              type: 'button',
              sub_type: 'flow',
              index: '0',
              parameters: [
                {
                  type: 'action',
                  action: { flow_token: flowToken },
                },
              ],
            },
          ],
        },
      }),
    }
  );

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const errMsg  = JSON.stringify(errBody);
    console.error(`[WhatsApp] Send failed to ${phone}:`, errMsg);
    throw new Error(errMsg);
  }

  const result    = await response.json() as any;
  const messageId = result?.messages?.[0]?.id;
  console.log(`[WhatsApp] ✅ Sent to ${phone}: messageId=${messageId}, wa_id=${result?.contacts?.[0]?.wa_id}`);
  return messageId;
}

export default router;
