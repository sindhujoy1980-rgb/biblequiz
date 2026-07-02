// ============================================================
// src/services/questionGenerator.ts — Gemini Hindi MCQ Generator
// ============================================================
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

interface GeneratedQuestion {
  slot: 1 | 2 | 3;
  category: 'OT' | 'NT-Gospel' | 'NT-Other';
  question_text: string;
  option_a: string; option_b: string; option_c: string; option_d: string;
  correct_answer: 'A' | 'B' | 'C' | 'D';
  verse_reference: string;
  explanation: string;
  difficulty: 'easy' | 'medium' | 'hard';
  topic_tag?: string;
  english_question?: string;
}

async function getRecentTopics(days = 90): Promise<string[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const { data } = await supabase
    .from('questions').select('topic_tag, verse_reference')
    .gte('quiz_date', cutoff.toISOString().split('T')[0])
    .not('topic_tag', 'is', null);
  return (data || []).map(q => `${q.topic_tag} (${q.verse_reference})`);
}

function buildPrompt(recentTopics: string[]): string {
  const recentList = recentTopics.length ? recentTopics.slice(-30).join('\n- ') : 'None';
  return `You are a Bible quiz expert. Generate exactly 3 Hindi Bible MCQs for a daily WhatsApp quiz.

SLOT RULES (STRICT):
- slot 1: OLD TESTAMENT only (Genesis/उत्पत्ति → Malachi/मलाकी)
- slot 2: GOSPELS only (Matthew/मत्ती, Mark/मरकुस, Luke/लूका, John/यूहन्ना)
- slot 3: OTHER NEW TESTAMENT only (Acts/प्रेरितों के काम → Revelation/प्रकाशितवाक्य)

LANGUAGE: question_text, options, explanation → Hindi (Devanagari); verse_reference → Hindi book name + chapter:verse; topic_tag → English.

QUALITY: All 4 options must be plausible. Explanation = 2-3 Hindi sentences mentioning the verse.
DO NOT repeat these recent topics: ${recentList}

Return ONLY a valid JSON array of exactly 3 objects. No markdown, no preamble:
[{"slot":1,"category":"OT","question_text":"...","option_a":"...","option_b":"...","option_c":"...","option_d":"...","correct_answer":"A","verse_reference":"...","explanation":"...","difficulty":"medium","topic_tag":"...","english_question":"..."},{"slot":2,"category":"NT-Gospel",...},{"slot":3,"category":"NT-Other",...}]`;
}

function validate(questions: GeneratedQuestion[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(questions) || questions.length !== 3) return { valid: false, errors: ['Must be array of 3'] };
  const catMap: Record<number, string> = { 1: 'OT', 2: 'NT-Gospel', 3: 'NT-Other' };
  const devanagari = /[\u0900-\u097F]/;
  for (const q of questions) {
    if (q.category !== catMap[q.slot]) errors.push(`Slot ${q.slot}: wrong category ${q.category}`);
    if (!q.question_text?.trim()) errors.push(`Slot ${q.slot}: missing question_text`);
    if (!['A','B','C','D'].includes(q.correct_answer)) errors.push(`Slot ${q.slot}: invalid correct_answer`);
    if (!q.verse_reference?.trim()) errors.push(`Slot ${q.slot}: missing verse_reference`);
    if (!devanagari.test(q.question_text || '')) errors.push(`Slot ${q.slot}: question not in Hindi/Devanagari`);
  }
  return { valid: errors.length === 0, errors };
}

export async function generateDailyQuestions(quizDate?: string): Promise<GeneratedQuestion[]> {
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' });
  const recentTopics = await getRecentTopics(90);
  const prompt = buildPrompt(recentTopics);
  const MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES || '3');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[Gemini] Attempt ${attempt}/${MAX_RETRIES}`);
    try {
      const result = await model.generateContent(prompt);
      const raw = result.response.text().trim().replace(/^```json\s*/i,'').replace(/\s*```$/i,'').trim();
      const questions: GeneratedQuestion[] = JSON.parse(raw);
      const { valid, errors } = validate(questions);
      if (!valid) { console.error('[Gemini] Validation failed:', errors); continue; }
      questions.sort((a, b) => a.slot - b.slot);
      console.log('[Gemini] ✅ Generated successfully');
      return questions;
    } catch (err) {
      console.error(`[Gemini] Attempt ${attempt} error:`, err);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error('[Gemini] Failed after all retries');
}

export async function saveQuestions(questions: GeneratedQuestion[], quizDate: string): Promise<void> {
  const payload = questions.map(q => ({
    quiz_date: quizDate, slot: q.slot, category: q.category,
    question_text: q.question_text, option_a: q.option_a, option_b: q.option_b,
    option_c: q.option_c, option_d: q.option_d, correct_answer: q.correct_answer,
    verse_reference: q.verse_reference, difficulty: q.difficulty,
    explanation: q.explanation, topic_tag: q.topic_tag || null,
    english_question: q.english_question || null, status: 'pending', generated_by: 'gemini',
  }));
  const { error } = await supabase.from('questions').upsert(payload, { onConflict: 'quiz_date,slot' });
  if (error) throw new Error(`[Supabase] Save failed: ${error.message}`);
  await supabase.from('quizzes').upsert({ quiz_date: quizDate, published: false }, { onConflict: 'quiz_date' });
  console.log(`[DB] ✅ Saved 3 questions for ${quizDate}`);
}
