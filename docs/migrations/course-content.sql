-- Schema: api
-- Ensure pgcrypto for gen_random_uuid
create extension if not exists pgcrypto;

-- Content tables
create table if not exists api.video_items (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references api.courses(id) on delete cascade,
  user_id uuid not null,
  module_key text not null,
  content_prompt text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists video_items_course_id_idx on api.video_items(course_id);
create index if not exists video_items_user_id_idx on api.video_items(user_id);
create index if not exists video_items_module_key_idx on api.video_items(module_key);

create table if not exists api.reading_articles (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references api.courses(id) on delete cascade,
  user_id uuid not null,
  module_key text not null,
  content_prompt text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists reading_articles_course_id_idx on api.reading_articles(course_id);
create index if not exists reading_articles_user_id_idx on api.reading_articles(user_id);
create index if not exists reading_articles_module_key_idx on api.reading_articles(module_key);

create table if not exists api.flashcard_sets (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references api.courses(id) on delete cascade,
  user_id uuid not null,
  module_key text not null,
  content_prompt text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists flashcard_sets_course_id_idx on api.flashcard_sets(course_id);
create index if not exists flashcard_sets_user_id_idx on api.flashcard_sets(user_id);
create index if not exists flashcard_sets_module_key_idx on api.flashcard_sets(module_key);

create table if not exists api.mini_quizzes (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references api.courses(id) on delete cascade,
  user_id uuid not null,
  module_key text not null,
  content_prompt text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists mini_quizzes_course_id_idx on api.mini_quizzes(course_id);
create index if not exists mini_quizzes_user_id_idx on api.mini_quizzes(user_id);
create index if not exists mini_quizzes_module_key_idx on api.mini_quizzes(module_key);

create table if not exists api.practice_exams (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references api.courses(id) on delete cascade,
  user_id uuid not null,
  module_key text not null,
  content_prompt text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists practice_exams_course_id_idx on api.practice_exams(course_id);
create index if not exists practice_exams_user_id_idx on api.practice_exams(user_id);
create index if not exists practice_exams_module_key_idx on api.practice_exams(module_key);
