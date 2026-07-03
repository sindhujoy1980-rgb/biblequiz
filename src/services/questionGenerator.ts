// ============================================================
// src/services/questionGenerator.ts
// Generates ONE MCQ question based on today's Catholic daily
// Mass readings (Gospel), matching the St. Chavara Church model:
//   - Single question from the day's Gospel
//   - Trilingual: Roman Hindi + Hindi (Devanagari) + English
// ============================================================

import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export interface GeneratedQuestion {
  slot: 1;
  category: 'Gospel';
  question_text: string;       // Hindi Devanagari
  question_roman: string;      // Roman Hindi
  english_question: string;    // English
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_answer: 'A' | 'B' | 'C' | 'D';
  verse_reference: string;     // e.g. "मत्ती 10:37 (Matthew 10:37)"
  explanation: string;         // Hindi explanation
  difficulty: 'easy' | 'medium' | 'hard';
  topic_tag?: string;
  liturgical_day?: string;     // e.g. "14वाँ सामान्य रविवार"
  gospel_ref?: string;         // e.g. "Matthew 10:37-42"
}

// ── Build prompt ──────────────────────────────────────────────
function buildPrompt(quizDate: string): string {
  const d = new Date(quizDate + 'T00:00:00');
  const dateStr = d.toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  return `You are a Catholic Bible quiz expert for an Indian parish WhatsApp group.
Today is ${dateStr}.

TASK:
1. Identify today's Catholic daily Mass Gospel reading from the Roman Rite liturgical calendar.
2. Generate ONE MCQ question based on that Gospel reading.

The question must be in THREE languages (exactly as shown):
- question_roman: Roman Hindi transliteration (e.g. "Koun Yesu ke yogya nahi hai?")
- question_text: Hindi Devanagari (e.g. "कौन येसु के योग्य नहीं है?")
- english_question: English (e.g. "Who is not worthy of Jesus?")

RULES:
- All 4 options in Hindi Devanagari
- correct_answer: A, B, C, or D
- verse_reference: Hindi book name + English reference, e.g. "मत्ती 10:37 (Matthew 10:37)"
- explanation: 2-3 sentences in Hindi explaining the correct answer with verse
- liturgical_day: The liturgical day name IN HINDI, e.g. "14वाँ सामान्य रविवार" or "सामान्य काल का गुरुवार"
- gospel_ref: English Gospel reference only, e.g. "Matthew 10:37-42"
- difficulty: easy / medium / hard
- topic_tag: English keyword for the topic
- category must be "Gospel"
- slot must be 1

Return ONLY a valid JSON array with exactly ONE object. No markdown, no extra text:
[{
  "slot": 1,
  "category": "Gospel",
  "liturgical_day": "...(Hindi)...",
  "gospel_ref": "...(English)...",
  "question_roman": "...(Roman Hindi)...",
  "question_text": "...(Hindi Devanagari)...",
  "english_question": "...(English)...",
  "option_a": "...(Hindi)...",
  "option_b": "...(Hindi)...",
  "option_c": "...(Hindi)...",
  "option_d": "...(Hindi)...",
  "correct_answer": "A",
  "verse_reference": "...(Hindi + English)...",
  "explanation": "...(Hindi)...",
  "difficulty": "medium",
  "topic_tag": "..."
}]`;
}

// ── Validate ──────────────────────────────────────────────────
function validate(questions: GeneratedQuestion[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(questions) || questions.length !== 1) {
    return { valid: false, errors: ['Must be array of exactly 1 question'] };
  }
  const q = questions[0];
  const devanagari = /[\u0900-\u097F]/;
  if (!q.question_text?.trim()) errors.push('Missing question_text');
  if (!q.question_roman?.trim()) errors.push('Missing question_roman');
  if (!q.english_question?.trim()) errors.push('Missing english_question');
  if (!['A', 'B', 'C', 'D'].includes(q.correct_answer)) errors.push('Invalid correct_answer');
  if (!q.verse_reference?.trim()) errors.push('Missing verse_reference');
  if (!devanagari.test(q.question_text || '')) errors.push('question_text not in Hindi/Devanagari');
  if (q.category !== 'Gospel') errors.push('category must be Gospel');
  return { valid: errors.length === 0, errors };
}

// ── Main generator ────────────────────────────────────────────
export async function generateDailyQuestions(quizDate?: string): Promise<GeneratedQuestion[]> {
  const targetDate = quizDate || new Date().toISOString().split('T')[0];
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });
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
      if (!valid) { console.error('[Gemini] Validation failed:', errors); continue; }

      console.log(`[Gemini] ✅ Generated question for ${targetDate}`);
      console.log(`  Liturgical day: ${questions[0].liturgical_day}`);
      console.log(`  Gospel: ${questions[0].gospel_ref}`);
      return questions;

    } catch (err) {
      console.error(`[Gemini] Attempt ${attempt} error:`, err);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error('[Gemini] Failed to generate question after all retries');
}

// ── Save to Supabase ──────────────────────────────────────────
export async function saveQuestions(questions: GeneratedQuestion[], quizDate: string): Promise<void> {
  const q = questions[0];
  const payload = [{
    quiz_date: quizDate,
    slot: q.slot,
    category: q.category,
    question_text: q.question_text,
    question_roman: q.question_roman || null,
    english_question: q.english_question || null,
    option_a: q.option_a,
    option_b: q.option_b,
    option_c: q.option_c,
    option_d: q.option_d,
    correct_answer: q.correct_answer,
    verse_reference: q.verse_reference,
    difficulty: q.difficulty,
    explanation: q.explanation,
    topic_tag: q.topic_tag || null,
    liturgical_day: q.liturgical_day || null,
    status: 'pending',
    generated_by: 'gemini',
  }];

  const { error } = await supabase
    .from('questions')
    .upsert(payload, { onConflict: 'quiz_date,slot' });

  if (error) throw new Error(`[Supabase] Save failed: ${error.message}`);

  await supabase
    .from('quizzes')
    .upsert({ quiz_date: quizDate, published: false }, { onConflict: 'quiz_date' });

  console.log(`[DB] ✅ Saved 1 Gospel question for ${quizDate}`);
}
