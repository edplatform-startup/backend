
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
  // We will still print the SQL even if env vars are missing
}

const createTableSql = `
CREATE TABLE IF NOT EXISTS api.analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_user_id ON api.analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_type ON api.analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON api.analytics_events(created_at);
`;

async function runMigration() {
  console.log('--- SQL for analytics_events table ---');
  console.log(createTableSql);
  console.log('--------------------------------------');

  if (supabaseUrl && supabaseServiceKey) {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    console.log('Attempting to run migration via RPC...');
    try {
      const { error } = await supabase.rpc('exec_sql', { sql: createTableSql });
      if (error) {
        console.error('RPC exec_sql failed (function might not exist):', error.message);
        console.log('Please run the SQL above in your Supabase SQL Editor.');
      } else {
        console.log('Migration completed successfully via RPC.');
      }
    } catch (err) {
      console.error('Migration failed:', err);
    }
  } else {
    console.log('Skipping auto-migration due to missing env vars. Please run the SQL manually.');
  }
}

runMigration();
