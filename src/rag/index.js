/**
 * RAG Module - exports for retrieval-augmented generation
 */

export { chunkText } from './chunker.js';
export { cosineSimilarity, rankTopK } from './similarity.js';
export { createRagSession, retrieveContext } from './session.js';

// Test helpers
export {
  __setSupabaseGetter,
  __clearSupabaseGetter,
  __setEmbedder,
  __clearEmbedder,
} from './session.js';
