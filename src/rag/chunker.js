/**
 * RAG Chunker - deterministic, paragraph-aware text chunking
 */

const DEFAULT_CHUNK_CHARS = 1000;
const DEFAULT_OVERLAP_CHARS = 200;

/**
 * Split text into overlapping chunks.
 * Prefers paragraph boundaries when possible.
 * 
 * @param {string} text - Text to chunk
 * @param {Object} [options]
 * @param {number} [options.chunkChars=1000] - Target chunk size in characters
 * @param {number} [options.overlapChars=200] - Overlap between chunks
 * @returns {Array<{chunk_index: number, chunk_text: string, meta: Object}>}
 */
export function chunkText(text, options = {}) {
  const {
    chunkChars = DEFAULT_CHUNK_CHARS,
    overlapChars = DEFAULT_OVERLAP_CHARS,
  } = options;

  if (!text || typeof text !== 'string') {
    return [];
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  // If text fits in one chunk, return as single chunk
  if (trimmed.length <= chunkChars) {
    return [{
      chunk_index: 0,
      chunk_text: trimmed,
      meta: { start_char: 0, end_char: trimmed.length },
    }];
  }

  // Split into paragraphs (double newline or single newline with blank line)
  const paragraphs = trimmed.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  
  const chunks = [];
  let currentChunk = '';
  let currentStart = 0;
  let charOffset = 0;

  const flushChunk = (chunkText, startChar, endChar) => {
    if (chunkText.trim()) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: chunkText.trim(),
        meta: { start_char: startChar, end_char: endChar },
      });
    }
  };

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const paraWithSeparator = i > 0 ? '\n\n' + para : para;
    
    // Would adding this paragraph exceed chunk size?
    if (currentChunk.length + paraWithSeparator.length > chunkChars && currentChunk.length > 0) {
      // Flush current chunk
      flushChunk(currentChunk, currentStart, charOffset);
      
      // Start new chunk with overlap from previous
      const overlapStart = Math.max(0, currentChunk.length - overlapChars);
      const overlapText = currentChunk.slice(overlapStart);
      currentChunk = overlapText + '\n\n' + para;
      currentStart = charOffset - (currentChunk.length - paraWithSeparator.length);
    } else {
      // Add paragraph to current chunk
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
    
    charOffset += paraWithSeparator.length;
  }

  // Flush final chunk
  if (currentChunk.trim()) {
    flushChunk(currentChunk, currentStart, charOffset);
  }

  // Handle edge case: single very long paragraph
  if (chunks.length === 0 && trimmed.length > 0) {
    return splitBySize(trimmed, chunkChars, overlapChars);
  }

  // If any chunk is still too large, split it further
  const result = [];
  for (const chunk of chunks) {
    if (chunk.chunk_text.length > chunkChars * 1.5) {
      const subChunks = splitBySize(chunk.chunk_text, chunkChars, overlapChars);
      for (const sub of subChunks) {
        result.push({
          chunk_index: result.length,
          chunk_text: sub.chunk_text,
          meta: {
            start_char: chunk.meta.start_char + sub.meta.start_char,
            end_char: chunk.meta.start_char + sub.meta.end_char,
          },
        });
      }
    } else {
      result.push({
        ...chunk,
        chunk_index: result.length,
      });
    }
  }

  return result;
}

/**
 * Split text by size at sentence/word boundaries.
 */
function splitBySize(text, chunkChars, overlapChars) {
  const chunks = [];
  let pos = 0;

  while (pos < text.length) {
    let end = Math.min(pos + chunkChars, text.length);
    
    // Try to break at sentence boundary
    if (end < text.length) {
      const slice = text.slice(pos, end);
      const sentenceEnd = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('.\n'),
        slice.lastIndexOf('?\n'),
        slice.lastIndexOf('!\n'),
      );
      
      if (sentenceEnd > chunkChars * 0.5) {
        end = pos + sentenceEnd + 1;
      } else {
        // Fall back to word boundary
        const wordEnd = slice.lastIndexOf(' ');
        if (wordEnd > chunkChars * 0.5) {
          end = pos + wordEnd;
        }
      }
    }

    const chunkText = text.slice(pos, end).trim();
    if (chunkText) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: chunkText,
        meta: { start_char: pos, end_char: end },
      });
    }

    // Move position with overlap
    pos = end - overlapChars;
    if (pos <= chunks[chunks.length - 1]?.meta.start_char) {
      pos = end; // Prevent infinite loop
    }
  }

  return chunks;
}
