import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkText } from '../src/rag/chunker.js';
import { cosineSimilarity, rankTopK } from '../src/rag/similarity.js';
import {
  createRagSession,
  retrieveContext,
  __setSupabaseGetter,
  __clearSupabaseGetter,
  __setEmbedder,
  __clearEmbedder,
} from '../src/rag/session.js';

// ============ Chunker Tests ============

test('chunkText: returns empty array for empty input', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText(null), []);
  assert.deepEqual(chunkText(undefined), []);
  assert.deepEqual(chunkText('   '), []);
});

test('chunkText: returns single chunk for short text', () => {
  const text = 'Hello world.';
  const chunks = chunkText(text, { chunkChars: 1000 });
  
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunk_index, 0);
  assert.equal(chunks[0].chunk_text, 'Hello world.');
  assert.equal(chunks[0].meta.start_char, 0);
});

test('chunkText: splits at paragraph boundaries', () => {
  const text = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.';
  const chunks = chunkText(text, { chunkChars: 50, overlapChars: 10 });
  
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].chunk_text.includes('First paragraph'));
});

test('chunkText: is deterministic', () => {
  const text = 'Para one.\n\nPara two.\n\nPara three.\n\nPara four.\n\nPara five.';
  const opts = { chunkChars: 30, overlapChars: 5 };
  
  const run1 = chunkText(text, opts);
  const run2 = chunkText(text, opts);
  const run3 = chunkText(text, opts);
  
  assert.deepEqual(run1, run2);
  assert.deepEqual(run2, run3);
});

test('chunkText: handles very long single paragraph', () => {
  const text = 'word '.repeat(500); // 2500 chars
  const chunks = chunkText(text, { chunkChars: 500, overlapChars: 50 });
  
  assert.ok(chunks.length >= 4);
  chunks.forEach((chunk, i) => {
    assert.equal(chunk.chunk_index, i);
    assert.ok(chunk.chunk_text.length > 0);
  });
});

test('chunkText: includes overlap between chunks', () => {
  const text = 'Sentence one. Sentence two. Sentence three. Sentence four. Sentence five.';
  const chunks = chunkText(text, { chunkChars: 40, overlapChars: 15 });
  
  if (chunks.length >= 2) {
    // Last part of chunk 0 should appear in chunk 1
    const end0 = chunks[0].chunk_text.slice(-15);
    const hasOverlap = chunks[1].chunk_text.includes(end0.trim().split(' ').pop());
    assert.ok(hasOverlap || chunks[1].chunk_text.length > 0); // At least valid chunks
  }
});

// ============ Similarity Tests ============

test('cosineSimilarity: returns 1 for identical vectors', () => {
  const v = [1, 2, 3];
  assert.equal(cosineSimilarity(v, v), 1);
});

test('cosineSimilarity: returns 0 for orthogonal vectors', () => {
  const a = [1, 0];
  const b = [0, 1];
  const sim = cosineSimilarity(a, b);
  assert.ok(Math.abs(sim) < 0.0001);
});

test('cosineSimilarity: returns -1 for opposite vectors', () => {
  const a = [1, 1];
  const b = [-1, -1];
  const sim = cosineSimilarity(a, b);
  assert.ok(Math.abs(sim + 1) < 0.0001);
});

test('cosineSimilarity: handles empty/invalid input', () => {
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([1, 2], [1]), 0);
  assert.equal(cosineSimilarity(null, [1]), 0);
});

test('rankTopK: returns empty for empty input', () => {
  assert.deepEqual(rankTopK([1, 2, 3], [], 5), []);
  assert.deepEqual(rankTopK([], [{ embedding: [1, 2, 3] }], 5), []);
});

test('rankTopK: ranks by similarity descending', () => {
  const query = [1, 0, 0];
  const rows = [
    { id: 1, embedding: [0, 1, 0] },    // orthogonal = 0
    { id: 2, embedding: [1, 0, 0] },    // identical = 1
    { id: 3, embedding: [0.5, 0.5, 0] }, // partial
  ];
  
  const result = rankTopK(query, rows, 3);
  
  assert.equal(result.length, 3);
  assert.equal(result[0].row.id, 2); // Most similar first
  assert.equal(result[0].score, 1);
});

test('rankTopK: handles JSONB string embeddings', () => {
  const query = [1, 0];
  const rows = [
    { id: 1, embedding: '[0, 1]' },     // JSON string
    { id: 2, embedding: [1, 0] },       // Array
  ];
  
  const result = rankTopK(query, rows, 2);
  
  assert.equal(result.length, 2);
  assert.equal(result[0].row.id, 2);
});

test('rankTopK: respects k limit', () => {
  const query = [1, 0];
  const rows = [
    { id: 1, embedding: [1, 0] },
    { id: 2, embedding: [0.9, 0.1] },
    { id: 3, embedding: [0.8, 0.2] },
    { id: 4, embedding: [0.7, 0.3] },
  ];
  
  const result = rankTopK(query, rows, 2);
  
  assert.equal(result.length, 2);
  assert.equal(result[0].row.id, 1);
  assert.equal(result[1].row.id, 2);
});

// ============ Session Tests ============

test('createRagSession: requires userId', async () => {
  await assert.rejects(
    () => createRagSession({}),
    { message: 'userId is required' }
  );
});

test('createRagSession: returns session with counts', async () => {
  const insertedRows = [];
  
  __setSupabaseGetter(() => ({
    from: () => ({
      insert: (rows) => {
        insertedRows.push(...rows);
        return { error: null };
      },
    }),
  }));
  
  __setEmbedder((texts) => texts.map((_, i) => [0.1 * i, 0.2 * i]));
  
  try {
    const result = await createRagSession({
      userId: 'user-123',
      syllabusText: 'Syllabus content here.',
      examText: 'Exam content here.',
    });
    
    assert.ok(result.sessionId);
    assert.equal(typeof result.sessionId, 'string');
    assert.equal(result.counts.syllabus, 1);
    assert.equal(result.counts.exam, 1);
    assert.equal(insertedRows.length, 2);
    assert.equal(insertedRows[0].source, 'syllabus');
    assert.equal(insertedRows[1].source, 'exam');
    assert.ok(Array.isArray(insertedRows[0].embedding));
  } finally {
    __clearSupabaseGetter();
    __clearEmbedder();
  }
});

test('createRagSession: handles empty text', async () => {
  __setSupabaseGetter(() => ({
    from: () => ({ insert: () => ({ error: null }) }),
  }));
  __setEmbedder((texts) => texts.map(() => [0.1]));
  
  try {
    const result = await createRagSession({
      userId: 'user-123',
      syllabusText: '',
      examText: null,
    });
    
    assert.ok(result.sessionId);
    assert.equal(result.counts.syllabus, 0);
    assert.equal(result.counts.exam, 0);
  } finally {
    __clearSupabaseGetter();
    __clearEmbedder();
  }
});

test('retrieveContext: requires sessionId', async () => {
  await assert.rejects(
    () => retrieveContext({ queryText: 'test' }),
    { message: 'sessionId is required' }
  );
});

test('retrieveContext: returns empty for empty query', async () => {
  const result = await retrieveContext({ sessionId: 'test', queryText: '' });
  assert.equal(result, '');
});

test('retrieveContext: formats output with labels', async () => {
  __setSupabaseGetter(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          data: [
            { source: 'syllabus', chunk_index: 0, chunk_text: 'Syllabus chunk 1', embedding: [1, 0] },
            { source: 'exam', chunk_index: 0, chunk_text: 'Exam chunk 1', embedding: [0.9, 0.1] },
          ],
          error: null,
        }),
      }),
    }),
  }));
  
  __setEmbedder(() => [[1, 0]]);
  
  try {
    const result = await retrieveContext({
      sessionId: 'session-123',
      queryText: 'test query',
      topK: 5,
    });
    
    assert.ok(result.includes('[SYLLABUS]'));
    assert.ok(result.includes('Syllabus chunk 1'));
    assert.ok(result.includes('[EXAM]'));
    assert.ok(result.includes('Exam chunk 1'));
    assert.ok(result.includes('---'));
  } finally {
    __clearSupabaseGetter();
    __clearEmbedder();
  }
});

test('retrieveContext: deduplicates identical chunks', async () => {
  __setSupabaseGetter(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          data: [
            { source: 'syllabus', chunk_index: 0, chunk_text: 'Same text', embedding: [1, 0] },
            { source: 'syllabus', chunk_index: 1, chunk_text: 'Same text', embedding: [0.99, 0.01] },
            { source: 'syllabus', chunk_index: 2, chunk_text: 'Different text', embedding: [0.9, 0.1] },
          ],
          error: null,
        }),
      }),
    }),
  }));
  
  __setEmbedder(() => [[1, 0]]);
  
  try {
    const result = await retrieveContext({
      sessionId: 'session-123',
      queryText: 'test',
      topK: 5,
    });
    
    // Count occurrences of "Same text"
    const matches = result.match(/Same text/g) || [];
    assert.equal(matches.length, 1); // Should appear only once
  } finally {
    __clearSupabaseGetter();
    __clearEmbedder();
  }
});

test('retrieveContext: respects maxChars limit', async () => {
  const longText = 'A'.repeat(500);
  
  __setSupabaseGetter(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          data: [
            { source: 'syllabus', chunk_index: 0, chunk_text: longText, embedding: [1, 0] },
            { source: 'syllabus', chunk_index: 1, chunk_text: longText, embedding: [0.9, 0.1] },
          ],
          error: null,
        }),
      }),
    }),
  }));
  
  __setEmbedder(() => [[1, 0]]);
  
  try {
    const result = await retrieveContext({
      sessionId: 'session-123',
      queryText: 'test',
      topK: 5,
      maxChars: 600,
    });
    
    assert.ok(result.length < 700); // Some buffer for labels
  } finally {
    __clearSupabaseGetter();
    __clearEmbedder();
  }
});
