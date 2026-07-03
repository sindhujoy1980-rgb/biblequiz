// ============================================================
// src/services/questionGenerator.ts
// Generates 3 MCQ questions based on Catholic daily Mass readings
// Following the St. Chavara Church model:
//   Q1 → First Reading
//   Q2 → Second Reading / Responsorial Psalm
//   Q3 → Gospel (primary — based on today's Gospel)
// Questions in 3 languages: Roman Hindi + Hindi + English
// ============================================================

import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export interface GeneratedQuestion {
  slot: 1 | 2 | 3;
  category: 'First Reading' | 'Second Reading' | 'Gospel';
  question_text: string;       // Hindi (Devanagari)
  question_roman?: string;     // Roman Hindi transliteration
  english_question?: string;   // English
  option_a: string; option_b: string; option_c: string; option_d: string;
  correct_answer: 'A' | 'B' | 'C' | 'D';
  verse_reference: string;     // e.g. "2 राजा 4:8-11"
  explanation: string;         // Hindi explanation
  difficulty: 'easy' | 'medium' | 'hard';
  topic_tag?: string;
  liturgical_day?: string;     // e.g. "13th Sunday in Ordinary Time"
}

// ── Build Gemini prompt ───────────────────────────────────────
function buildPrompt(quizDate: string): string {
  // Format date for the prompt
  const d = new Date(quizDate);
  const dateStr = d.toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  return `You are a Catholic Bible quiz expert for an Indian parish WhatsApp group.
Today is ${dateStr}.

TASK: Generate exactly 3 MCQ questions for today's Catholic daily Mass readings.

STEP 1: Identify today's Catholic daily Mass readings from the Roman Rite liturgical calendar for ${dateStr}:
- First Reading (usually Old Testament, or Acts during Easter)
- Second Reading (Epistle or Psalm — use whichever is used at Sunday Mass, or skip to Psalm if weekday)
- Gospel reading for the day

STEP 2: Generate one MCQ question from EACH reading:
- Slot 1: Based on the FIRST READING
- Slot 2: Based on the SECOND READING or RESPONSORIAL PSALM
- Slot 3: Based on the GOSPEL (most important — this is what the quiz is primarily about)

FORMAT RULES (STRICT):
- question_text: in Hindi (Devanagari script) — e.g. "कौन येसु के योग्य नहीं है?"
- question_roman: Roman Hindi transliteration — e.g. "Koun Yesu ke yogyata nahi hai?"
- english_question: English translation — e.g. "Who is not worthy of Jesus?"
- option_a/b/c/d: in Hindi (Devanagari)
- correct_answer: A, B, C, or D
- verse_reference: include BOTH Hindi book name and English reference — e.g. "मत्ती 10:37 (Matthew 10:37)"
- explanation: 2-3 sentences in Hindi explaining the correct answer with the verse
- liturgical_day: liturgical day name — e.g. "13वाँ सामान्य रविवार" or "सामान्य काल का बुधवार"
- difficulty: easy/medium/hard
- topic_tag: English topic keyword

Return ONLY a valid JSON array of exactly 3 objects. No markdown, no explanation text, just JSON:
[
  {
    "slot": 1,
    "category": "First Reading",
    "liturgical_day": "...",
    "question_text": "...(Hindi Devanagari)...",
    "question_roman": "...(Roman Hindi)...",
    "english_question": "...(English)...",
    "option_a": "...",
    "option_b": "...",
    "option_c": "...",
    "option_d": "...",
    "correct_answer": "A",
    "verse_reference": "...(Hindi + English)...",
    "explanation": "...(Hindi)...",
    "difficulty": "medium",
    "topic_tag": "..."
  },
  {
    "slot": 2,
    "category": "Second Reading",
    ...
  },
  {
    "slot": 3,
    "category": "Gospel",
    ...
  }
]`;
}

// ── Validate generated questions ──────────────────────────────
function validate(questions: GeneratedQuestion[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(questions) || questions.length !== 3) {
    return { valid: false, errors: ['Must be array of 3'] };
  }

  const expectedCategories = ['First Reading', 'Second Reading', 'Gospel'];
  const devanagari = /[\u0900-\u097F]/;

  for (const q of questions) {
    if (!expectedCategories.includes(q.category)) {
      errors.push(`Slot ${q.slot}: invalid category "${q.category}"`);
    }
    if (!q.question_text?.trim()) errors.push(`Slot ${q.slot}: missing question_text`);
    if (!['A', 'B', 'C', 'D'].includes(q.correct_answer)) {
      errors.push(`Slot ${q.slot}: invalid correct_answer "${q.correct_answer}"`);
    }
    if (!q.verse_reference?.trim()) errors.push(`Slot ${q.slot}: missing verse_reference`);
    if (!devanagari.test(q.question_text || '')) {
      errors.push(`Slot ${q.slot}: question_text not in Hindi/Devanagari`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// ── Main generator ────────────────────────────────────────────
export async function generateDailyQuestions(quizDate?: string): Promise<GeneratedQuestion[]> {
  const targetDate = quizDate || new Date().toISOString().split('T')[0];
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' });
  const prompt = buildPrompt(targetDate);
  const MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES || '3');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[Gemini] Attempt ${attempt}/${MAX_RETRIES} for ${targetDate}`);
    try {
      const result = await model.generateContent(prompt);
      const raw = result.response.text()
        .trim()
        .replace(/^```json\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      const questions: GeneratedQuestion[] = JSON.parse(raw);
      const { valid, errors } = validate(questions);

      if (!valid) {
        console.error('[Gemini] Validation failed:', errors);
        continue;
      }

      questions.sort((a, b) => a.slot - b.slot);
      console.log(`[Gemini] ✅ Generated 3 questions for ${targetDate}`);
      console.log(`  Liturgical day: ${questions[2]?.liturgical_day || 'unknown'}`);
      console.log(`  Gospel: ${questions[2]?.verse_reference}`);
      return questions;

    } catch (err) {
      console.error(`[Gemini] Attempt ${attempt} error:`, err);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error('[Gemini] Failed to generate questions after all retries');
}

// ── Save to Supabase ──────────────────────────────────────────
export async function saveQuestions(questions: GeneratedQuestion[], quizDate: string): Promise<void> {
  const payload = questions.map(q => ({
    quiz_date: quizDate,
    slot: q.slot,
    category: q.category,
    question_text: q.question_text,
    option_a: q.option_a,
    option_b: q.option_b,
    option_c: q.option_c,
    option_d: q.option_d,
    correct_answer: q.correct_answer,
    verse_reference: q.verse_reference,
    difficulty: q.difficulty,
    explanation: q.explanation,
    topic_tag: q.topic_tag || null,
    english_question: q.english_question || null,
    question_roman: q.question_roman || null,
    liturgical_day: q.liturgical_day || null,
    status: 'pending',
    generated_by: 'gemini',
  }));

  const { error } = await supabase
    .from('questions')
    .upsert(payload, { onConflict: 'quiz_date,slot' });

  if (error) throw new Error(`[Supabase] Save failed: ${error.message}`);

  await supabase
    .from('quizzes')
    .upsert({ quiz_date: quizDate, published: false }, { onConflict: 'quiz_date' });

  console.log(`[DB] ✅ Saved 3 questions for ${quizDate}`);
}
