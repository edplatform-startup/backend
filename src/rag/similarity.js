/**
 * RAG Similarity - cosine similarity and top-K ranking
 */

/**
 * Compute cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} Similarity in range [-1, 1]
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

/**
 * Rank rows by cosine similarity to query vector and return top K.
 * @param {number[]} queryVec - Query embedding vector
 * @param {Array<{embedding: number[]|string, [key: string]: any}>} rows - Rows with embeddings
 * @param {number} k - Number of top results to return
 * @returns {Array<{score: number, row: Object}>} Top K rows with scores, sorted desc
 */
export function rankTopK(queryVec, rows, k) {
  if (!Array.isArray(queryVec) || queryVec.length === 0) {
    return [];
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const scored = [];

  for (const row of rows) {
    let embedding = row.embedding;
    
    // Handle JSONB storage: embedding might be a string or already parsed
    if (typeof embedding === 'string') {
      try {
        embedding = JSON.parse(embedding);
      } catch {
        continue;
      }
    }

    if (!Array.isArray(embedding) || embedding.length === 0) {
      continue;
    }

    const score = cosineSimilarity(queryVec, embedding);
    scored.push({ score, row });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, k);
}
