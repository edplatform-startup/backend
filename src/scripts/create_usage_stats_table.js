
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
CREATE TABLE IF NOT EXISTS api.usage_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd DOUBLE PRECISION NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON api.usage_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_time ON api.usage_stats(created_at);
`;

async function runMigration() {
  console.log('Running migration for usage_stats...');
  
  try {
    const { error } = await supabase.rpc('exec_sql', { sql: createTablesSql });
    if (error) {
      console.error('RPC exec_sql failed (function might not exist):', error.message);
      console.log('\nPlease run the following SQL in your Supabase SQL Editor:\n');
      console.log(createTablesSql);
    } else {
      console.log('Migration completed successfully via RPC.');
    }
  } catch (err) {
    console.error('Migration failed:', err);
  }
}

runMigration();
