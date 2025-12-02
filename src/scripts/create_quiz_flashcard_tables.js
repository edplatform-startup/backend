
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from backend root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const createTablesSql = `
CREATE TABLE IF NOT EXISTS api.quiz_questions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES api.courses(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES api.course_nodes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  question TEXT NOT NULL,
  options JSONB NOT NULL,
  correct_index INTEGER NOT NULL,
  explanation TEXT,
  status TEXT NOT NULL DEFAULT 'unattempted' CHECK (status IN ('correct', 'incorrect', 'unattempted')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api.flashcards (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES api.courses(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES api.course_nodes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  next_show_timestamp TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quiz_questions_course_id ON api.quiz_questions(course_id);
CREATE INDEX IF NOT EXISTS idx_quiz_questions_user_id ON api.quiz_questions(user_id);
CREATE INDEX IF NOT EXISTS idx_flashcards_course_id ON api.flashcards(course_id);
CREATE INDEX IF NOT EXISTS idx_flashcards_user_id ON api.flashcards(user_id);
CREATE INDEX IF NOT EXISTS idx_flashcards_next_show ON api.flashcards(next_show_timestamp);
`;

async function runMigration() {
  console.log('Running migration...');
  
  // Supabase JS client doesn't support running raw SQL directly via the standard client usually, 
  // but the service role might if there's an rpc function or if we use the postgres connection.
  // However, often in these environments we might have a 'rpc' function to run sql.
  // If not, I might have to ask the user to run it.
  // Let's check if there is a way. 
  // Actually, for this environment, I'll try to use the 'rpc' if it exists, or just print the SQL for the user if I fail.
  // But wait, I can use the `pg` library if it's installed.
  
  // Let's check package.json first to see if 'pg' is available.
  try {
    const { error } = await supabase.rpc('exec_sql', { sql: createTablesSql });
    if (error) {
      console.error('RPC exec_sql failed (this is expected if the function does not exist):', error);
      console.log('Please run the following SQL in your Supabase SQL Editor:');
      console.log(createTablesSql);
    } else {
      console.log('Migration completed successfully via RPC.');
    }
  } catch (err) {
    console.error('Migration failed:', err);
  }
}

runMigration();
