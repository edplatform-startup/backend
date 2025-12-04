/**
 * RAG Session Management - create sessions and retrieve context
 */

import { v4 as uuidv4 } from 'uuid';
import { getSupabase } from '../supabaseClient.js';
import { embedTexts } from '../services/embeddingsClient.js';
import { chunkText } from './chunker.js';
import { rankTopK } from './similarity.js';

const DEFAULT_CHUNK_CHARS = 1000;
const DEFAULT_OVERLAP_CHARS = 200;
const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_CHARS = 4000;

// For testing
let customSupabaseGetter = null;
let customEmbedder = null;

export function __setSupabaseGetter(fn) {
  customSupabaseGetter = typeof fn === 'function' ? fn : null;
}

export function __clearSupabaseGetter() {
  customSupabaseGetter = null;
}

export function __setEmbedder(fn) {
  customEmbedder = typeof fn === 'function' ? fn : null;
}

export function __clearEmbedder() {
  customEmbedder = null;
}

function getSupabaseClient() {
  return customSupabaseGetter ? customSupabaseGetter() : getSupabase();
}

async function embed(texts) {
  return customEmbedder ? customEmbedder(texts) : embedTexts(texts);
}

/**
 * Create a RAG session with chunked and embedded syllabus/exam text.
 * 
 * @param {Object} options
 * @param {string} options.userId - User ID
 * @param {string} [options.syllabusText] - Syllabus text to chunk and embed
 * @param {string} [options.examText] - Exam details text to chunk and embed
 * @param {number} [options.chunkChars=1000] - Chunk size
 * @param {number} [options.overlapChars=200] - Overlap size
 * @returns {Promise<{sessionId: string, counts: {syllabus: number, exam: number}}>}
 */
export async function createRagSession(options = {}) {
  const {
    userId,
    syllabusText,
    examText,
    chunkChars = DEFAULT_CHUNK_CHARS,
    overlapChars = DEFAULT_OVERLAP_CHARS,
  } = options;

  if (!userId) {
    throw new Error('userId is required');
  }

  const sessionId = uuidv4();
  const embeddingModel = process.env.OPENROUTER_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
  
  const allChunks = [];
  const counts = { syllabus: 0, exam: 0 };

  // Chunk syllabus
  if (syllabusText && syllabusText.trim()) {
    const syllabusChunks = chunkText(syllabusText, { chunkChars, overlapChars });
    for (const chunk of syllabusChunks) {
      allChunks.push({
        source: 'syllabus',
        chunk_index: chunk.chunk_index,
        chunk_text: chunk.chunk_text,
        meta: chunk.meta,
      });
    }
    counts.syllabus = syllabusChunks.length;
  }

  // Chunk exam
  if (examText && examText.trim()) {
    const examChunks = chunkText(examText, { chunkChars, overlapChars });
    for (const chunk of examChunks) {
      allChunks.push({
        source: 'exam',
        chunk_index: chunk.chunk_index,
        chunk_text: chunk.chunk_text,
        meta: chunk.meta,
      });
    }
    counts.exam = examChunks.length;
  }

  if (allChunks.length === 0) {
    return { sessionId, counts };
  }

  // Embed all chunks
  const texts = allChunks.map(c => c.chunk_text);
  const embeddings = await embed(texts);

  // Prepare rows for insertion
  const rows = allChunks.map((chunk, i) => ({
    session_id: sessionId,
    user_id: userId,
    source: chunk.source,
    chunk_index: chunk.chunk_index,
    chunk_text: chunk.chunk_text,
    embedding: embeddings[i], // JSONB - Supabase handles array serialization
    embedding_model: embeddingModel,
    meta: chunk.meta,
  }));

  // Insert into database
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('rag_chunks')
    .insert(rows);

  if (error) {
    throw new Error(`Failed to insert RAG chunks: ${error.message}`);
  }

  return { sessionId, counts };
}

/**
 * Retrieve context for a query from a RAG session.
 * 
 * @param {Object} options
 * @param {string} options.sessionId - Session ID
 * @param {string} options.queryText - Query to embed and search
 * @param {number} [options.topK=5] - Number of top chunks to retrieve
 * @param {number} [options.maxChars=4000] - Max characters in output
 * @returns {Promise<string>} Formatted context string
 */
export async function retrieveContext(options = {}) {
  const {
    sessionId,
    queryText,
    topK = DEFAULT_TOP_K,
    maxChars = DEFAULT_MAX_CHARS,
  } = options;

  if (!sessionId) {
    throw new Error('sessionId is required');
  }

  if (!queryText || !queryText.trim()) {
    return '';
  }

  // Embed query
  const [queryVec] = await embed([queryText.trim()]);

  // Fetch all chunks for session
  const supabase = getSupabaseClient();
  const { data: rows, error } = await supabase
    .from('rag_chunks')
    .select('source, chunk_index, chunk_text, embedding')
    .eq('session_id', sessionId);

  if (error) {
    throw new Error(`Failed to fetch RAG chunks: ${error.message}`);
  }

  if (!rows || rows.length === 0) {
    return '';
  }

  // Rank by similarity
  const ranked = rankTopK(queryVec, rows, topK * 2); // Get extra for dedup

  // Deduplicate by chunk_text
  const seen = new Set();
  const deduped = [];
  for (const { score, row } of ranked) {
    if (seen.has(row.chunk_text)) continue;
    seen.add(row.chunk_text);
    deduped.push({ score, row });
    if (deduped.length >= topK) break;
  }

  // Group by source
  const bySource = { syllabus: [], exam: [] };
  for (const { row } of deduped) {
    if (bySource[row.source]) {
      bySource[row.source].push(row);
    }
  }

  // Sort each source by chunk_index for coherent reading order
  bySource.syllabus.sort((a, b) => a.chunk_index - b.chunk_index);
  bySource.exam.sort((a, b) => a.chunk_index - b.chunk_index);

  // Format output
  const parts = [];
  let totalChars = 0;

  for (const source of ['syllabus', 'exam']) {
    const chunks = bySource[source];
    if (chunks.length === 0) continue;

    const label = source === 'syllabus' ? '[SYLLABUS]' : '[EXAM]';
    const texts = [];

    for (const chunk of chunks) {
      if (totalChars + chunk.chunk_text.length > maxChars) {
        const remaining = maxChars - totalChars;
        if (remaining > 100) {
          texts.push(chunk.chunk_text.slice(0, remaining) + '...');
          totalChars = maxChars;
        }
        break;
      }
      texts.push(chunk.chunk_text);
      totalChars += chunk.chunk_text.length;
    }

    if (texts.length > 0) {
      parts.push(`${label}\n${texts.join('\n\n')}`);
    }
  }

  return parts.join('\n---\n');
}
