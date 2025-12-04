#!/usr/bin/env node
/**
 * cleanupRagChunks.js
 * 
 * Deletes expired RAG session chunks from public.rag_chunks.
 * Run via cron or manually: node scripts/cleanupRagChunks.js
 * 
 * Uses RAG_SESSION_TTL_DAYS env var (default 7) to determine expiry.
 */

import { getSupabase } from '../src/supabaseClient.js';

const RAG_SESSION_TTL_DAYS = parseInt(process.env.RAG_SESSION_TTL_DAYS, 10) || 7;

async function cleanupExpiredChunks() {
  const supabase = getSupabase();
  if (!supabase) {
    console.error('[cleanup] Supabase client not available');
    process.exit(1);
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RAG_SESSION_TTL_DAYS);
  const cutoffISO = cutoff.toISOString();

  console.log(`[cleanup] Deleting rag_chunks older than ${RAG_SESSION_TTL_DAYS} days (before ${cutoffISO})`);

  const { data, error, count } = await supabase
    .from('rag_chunks')
    .delete()
    .lt('created_at', cutoffISO)
    .select('id', { count: 'exact' });

  if (error) {
    console.error('[cleanup] Error deleting chunks:', error.message);
    process.exit(1);
  }

  const deleted = count ?? data?.length ?? 0;
  console.log(`[cleanup] ✓ Deleted ${deleted} expired chunk(s)`);
}

cleanupExpiredChunks().catch((err) => {
  console.error('[cleanup] Unexpected error:', err);
  process.exit(1);
});
