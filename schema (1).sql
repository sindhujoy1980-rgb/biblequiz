-- ============================================================
-- BQA — Bible Quiz Automation System
-- Supabase PostgreSQL Schema
-- Run this in Supabase → SQL Editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLE: users
-- ============================================================
CREATE TABLE IF NOT EXISTS public.users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          VARCHAR(100)  NOT NULL,
  phone         VARCHAR(20)   UNIQUE NOT NULL,  -- with country code e.g. +919876543210
  church        VARCHAR(150),
  city          VARCHAR(100),
  joined_date   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_active   TIMESTAMPTZ,
  status        VARCHAR(20)   NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'inactive', 'blocked')),
  language      VARCHAR(10)   NOT NULL DEFAULT 'hi'
                  CHECK (language IN ('hi', 'en')),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TABLE: admin_users
-- ============================================================
CREATE TABLE IF NOT EXISTS public.admin_users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         VARCHAR(255)  UNIQUE NOT NULL,
  name          VARCHAR(100)  NOT NULL,
  role          VARCHAR(20)   NOT NULL DEFAULT 'editor'
                  CHECK (role IN ('super_admin', 'editor', 'volunteer', 'viewer')),
  supabase_uid  UUID          UNIQUE,  -- links to auth.users
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_login    TIMESTAMPTZ
);

-- ============================================================
-- TABLE: questions
-- ============================================================
CREATE TABLE IF NOT EXISTS public.questions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quiz_date       DATE          NOT NULL,
  slot            INTEGER       NOT NULL CHECK (slot BETWEEN 1 AND 3),
                  -- 1 = Old Testament, 2 = Gospel, 3 = NT-Other
  category        VARCHAR(20)   NOT NULL CHECK (category IN ('OT', 'NT-Gospel', 'NT-Other')),
  question_text   TEXT          NOT NULL,       -- Hindi (Devanagari)
  option_a        TEXT          NOT NULL,
  option_b        TEXT          NOT NULL,
  option_c        TEXT          NOT NULL,
  option_d        TEXT          NOT NULL,
  correct_answer  CHAR(1)       NOT NULL CHECK (correct_answer IN ('A','B','C','D')),
  verse_reference VARCHAR(100)  NOT NULL,       -- e.g. उत्पत्ति 1:1
  difficulty      VARCHAR(10)   NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  explanation     TEXT,                          -- Hindi explanation
  topic_tag       VARCHAR(100),
  english_question TEXT,                         -- for admin review only
  status          VARCHAR(20)   NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
  generated_by    VARCHAR(20)   NOT NULL DEFAULT 'gemini'
                    CHECK (generated_by IN ('gemini','manual')),
  approved_by     UUID          REFERENCES public.admin_users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (quiz_date, slot)   -- only one question per slot per day
);

-- ============================================================
-- TABLE: quizzes
-- ============================================================
CREATE TABLE IF NOT EXISTS public.quizzes (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quiz_date     DATE          UNIQUE NOT NULL,
  published     BOOLEAN       NOT NULL DEFAULT FALSE,
  flow_id       VARCHAR(200),   -- WhatsApp Flow ID
  published_at  TIMESTAMPTZ,
  published_by  UUID          REFERENCES public.admin_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TABLE: responses
-- ============================================================
CREATE TABLE IF NOT EXISTS public.responses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID          NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  quiz_date       DATE          NOT NULL,
  question_id     UUID          NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  slot            INTEGER       NOT NULL CHECK (slot BETWEEN 1 AND 3),
  selected_option CHAR(1)       NOT NULL CHECK (selected_option IN ('A','B','C','D')),
  is_correct      BOOLEAN       NOT NULL,
  time_taken_sec  INTEGER,
  submitted_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, question_id)  -- one answer per question per user
);

-- ============================================================
-- TABLE: scores
-- ============================================================
CREATE TABLE IF NOT EXISTS public.scores (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID          NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  quiz_date       DATE          NOT NULL,
  score           INTEGER       NOT NULL CHECK (score BETWEEN 0 AND 3),
  percentage      DECIMAL(5,2)  NOT NULL,
  rank            INTEGER,
  total_time_sec  INTEGER,      -- sum of time_taken_sec across all 3 answers
  submitted_time  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, quiz_date)
);

-- ============================================================
-- TABLE: audit_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id    UUID          REFERENCES public.admin_users(id) ON DELETE SET NULL,
  action      VARCHAR(100)  NOT NULL,  -- e.g. 'QUESTION_APPROVED', 'QUIZ_PUBLISHED'
  entity      VARCHAR(50),             -- e.g. 'question', 'quiz'
  entity_id   UUID,
  meta        JSONB,                   -- extra context
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_questions_quiz_date   ON public.questions(quiz_date);
CREATE INDEX IF NOT EXISTS idx_questions_status      ON public.questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_category    ON public.questions(category);
CREATE INDEX IF NOT EXISTS idx_responses_user_id     ON public.responses(user_id);
CREATE INDEX IF NOT EXISTS idx_responses_quiz_date   ON public.responses(quiz_date);
CREATE INDEX IF NOT EXISTS idx_scores_quiz_date      ON public.scores(quiz_date);
CREATE INDEX IF NOT EXISTS idx_scores_user_id        ON public.scores(user_id);
CREATE INDEX IF NOT EXISTS idx_users_phone           ON public.users(phone);
CREATE INDEX IF NOT EXISTS idx_users_status          ON public.users(status);

-- ============================================================
-- AUTO-UPDATE updated_at TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_questions_updated_at
  BEFORE UPDATE ON public.questions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- VIEWS
-- ============================================================

-- Daily leaderboard view
CREATE OR REPLACE VIEW public.v_daily_leaderboard AS
SELECT
  s.quiz_date,
  s.rank,
  s.score,
  s.percentage,
  s.total_time_sec,
  s.submitted_time,
  u.id       AS user_id,
  u.name     AS user_name,
  u.phone    AS user_phone,
  u.church,
  u.city
FROM public.scores s
JOIN public.users u ON u.id = s.user_id
ORDER BY s.quiz_date DESC, s.rank ASC;

-- Church leaderboard view
CREATE OR REPLACE VIEW public.v_church_rankings AS
SELECT
  u.church,
  COUNT(DISTINCT u.id)       AS total_participants,
  ROUND(AVG(s.percentage),2) AS avg_percentage,
  SUM(s.score)               AS total_score
FROM public.scores s
JOIN public.users u ON u.id = s.user_id
WHERE u.church IS NOT NULL
GROUP BY u.church
ORDER BY avg_percentage DESC;

-- Daily stats summary view
CREATE OR REPLACE VIEW public.v_daily_stats AS
SELECT
  s.quiz_date,
  COUNT(*)                    AS total_participants,
  ROUND(AVG(s.score),2)       AS avg_score,
  MAX(s.score)                AS highest_score,
  MIN(s.score)                AS lowest_score,
  ROUND(AVG(s.percentage),2)  AS avg_percentage,
  SUM(CASE WHEN s.score = 3 THEN 1 ELSE 0 END) AS perfect_scores
FROM public.scores s
GROUP BY s.quiz_date
ORDER BY s.quiz_date DESC;

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================
ALTER TABLE public.users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quizzes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.responses     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scores        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs    ENABLE ROW LEVEL SECURITY;

-- Service role (backend) bypasses RLS
-- Frontend anon key only reads what's needed for the flow

-- Allow backend service_role full access (handled automatically by Supabase)
-- Allow authenticated admin users to read/write based on role (enforce in backend middleware)
