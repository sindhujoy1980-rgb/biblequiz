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
// Generates tomorrow's 3 quiz questions via Gemini AI
// Schedule: daily at 11 PM IST (on cron-job.org)
router.post('/generate-questions', async (req: Request, res: Response) => {
  try {
    // Target date: tomorrow (so admin can review before 8 AM)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const quizDate = tomorrow.toISOString().split('T')[0];

    // Skip if questions already exist for this date
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
      message: `✅ Generated 3 questions for ${quizDate}`,
      quizDate,
      count: questions.length,
    });

  } catch (err: any) {
    console.error('[Cron] generate-questions error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/cron/send-quiz ──────────────────────────────────
// Sends today's quiz to all active users via WhatsApp Flow
// Schedule: daily at 8:00 AM IST (on cron-job.org)
router.post('/send-quiz', async (req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Verify 3 approved questions exist for today
    const { data: questions, error: qError } = await supabase
      .from('questions')
      .select('id')
      .eq('quiz_date', today)
      .eq('status', 'approved');

    if (qError || !questions || questions.length < 3) {
      return res.status(400).json({
        success: false,
        error: `Cannot send quiz: only ${questions?.length ?? 0}/3 approved questions for ${today}. Please approve questions first in admin panel.`,
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

    console.log(`[Cron] Sending quiz to ${users.length} users for ${today}...`);

    let sent = 0;
    let failed = 0;
    const failedPhones: string[] = [];

    for (const user of users) {
      try {
        await sendQuizFlowMessage(user.phone, user.name, today);
        sent++;
        // Rate limit: WhatsApp allows ~80 msgs/sec; 50ms gap keeps it safe
        await new Promise(r => setTimeout(r, 50));
      } catch (err: any) {
        console.error(`[Send] Failed for ${user.phone}:`, err.message);
        failed++;
        failedPhones.push(user.phone);
      }
    }

    // Mark quiz as published
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
      failedPhones: failedPhones.slice(0, 10), // only show first 10
    });

  } catch (err: any) {
    console.error('[Cron] send-quiz error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Helper: Send WhatsApp Flow message to one user ────────────
async function sendQuizFlowMessage(phone: string, name: string, quizDate: string) {
  const jwt = await import('jsonwebtoken');

  // Create a JWT flow_token containing the user's phone
  const flowToken = jwt.default.sign(
    { phone },
    process.env.JWT_SECRET!,
    { expiresIn: '24h' }
  );

  // Fetch today's questions to get liturgical day from Gospel slot
  const { data: questions } = await supabase
    .from('questions')
    .select('slot, liturgical_day, verse_reference, question_text, question_roman, english_question')
    .eq('quiz_date', quizDate)
    .eq('status', 'approved')
    .order('slot', { ascending: true });

  const gospel = questions?.find(q => q.slot === 3);
  const liturgicalDay = gospel?.liturgical_day || '';
  const gospelRef = gospel?.verse_reference || '';

  // Build the message body matching St. Chavara Church model
  const firstName = name.split(' ')[0];
  const dateFormatted = new Date(quizDate).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric', weekday: 'long',
  });

  const messageBody =
    `🌹 🙏 CyFam Bible Quiz 🙏 🌹\n\n` +
    `📖 Daily Bible Quiz\n` +
    `रोज की बाइबल प्रश्नोत्तरी\n` +
    `Based on today's Gospel\n` +
    `आज के सुसमाचार के अनुसार\n\n` +
    `📅 ${dateFormatted}\n` +
    (liturgicalDay ? `✝️ ${liturgicalDay}\n` : '') +
    (gospelRef ? `📖 ${gospelRef}\n` : '') +
    `\nनमस्ते ${firstName}! 🙏\n` +
    `आज की क्विज़ में 3 सवाल हैं।\n` +
    `नीचे बटन दबाएं और शुरू करें! 👇`;

  const response = await fetch(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive: {
          type: 'flow',
          header: {
            type: 'text',
            text: '📖 CyFam Daily Bible Quiz',
          },
          body: {
            text: messageBody,
          },
          footer: {
            text: 'CyFam • रोज की बाइबल प्रश्नोत्तरी',
          },
          action: {
            name: 'flow',
            parameters: {
              flow_message_version: '3',
              flow_token: flowToken,
              flow_id: process.env.WHATSAPP_FLOW_ID!,
              flow_cta: '✝️ क्विज़ शुरू करें',
              flow_action: 'navigate',
              flow_action_payload: {
                screen: 'WELCOME',
              },
            },
          },
        },
      }),
    }
  );

  if (!response.ok) {
    const errBody = await response.json();
    throw new Error(JSON.stringify(errBody));
  }
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleDateString('hi-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default router;
