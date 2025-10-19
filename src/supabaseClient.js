import { createClient } from '@supabase/supabase-js';

let client = null;

export function getSupabase() {
  if (client) return client;

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars. API routes will error until set.');
    throw new Error('Supabase is not configured');
  }

  client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  return client;
}

export function setSupabaseClient(mock) {
  client = mock;
}

export function clearSupabaseClient() {
  client = null;
}
