/**
 * Anki APKG file parser service.
 * Parses .apkg files and extracts flashcards.
 */

import { readAnkiPackage } from 'anki-reader';

/**
 * Parse an Anki .apkg file buffer and extract flashcards.
 * @param {Buffer} fileBuffer - The .apkg file as a buffer
 * @returns {Promise<{flashcards: Array<{front: string, back: string}>, deckName: string, errors: string[]}>}
 */
export async function parseAnkiFile(fileBuffer) {
  const errors = [];
  const flashcards = [];
  let deckName = 'Imported Deck';

  try {
    // Parse the .apkg file
    const collection = await readAnkiPackage(fileBuffer);
    
    // Get deck name if available
    if (collection.decks && collection.decks.length > 0) {
      deckName = collection.decks[0].name || deckName;
    }
    
    // Extract cards from the collection
    if (collection.cards && Array.isArray(collection.cards)) {
      for (const card of collection.cards) {
        try {
          // Anki cards have fields - typically the first field is front, second is back
          // The structure varies by note type, but most basic cards have question/answer fields
          let front = '';
          let back = '';
          
          if (card.note && card.note.fields) {
            const fields = card.note.fields;
            if (Array.isArray(fields) && fields.length >= 2) {
              front = stripHtml(fields[0] || '');
              back = stripHtml(fields[1] || '');
            } else if (typeof fields === 'object') {
              // Handle object-style fields
              const fieldValues = Object.values(fields);
              front = stripHtml(fieldValues[0] || '');
              back = stripHtml(fieldValues[1] || '');
            }
          } else if (card.fields) {
            // Direct field access
            const fields = card.fields;
            if (Array.isArray(fields) && fields.length >= 2) {
              front = stripHtml(fields[0] || '');
              back = stripHtml(fields[1] || '');
            }
          }
          
          // Only add if both front and back have content
          if (front.trim() && back.trim()) {
            flashcards.push({ front: front.trim(), back: back.trim() });
          }
        } catch (cardError) {
          errors.push(`Failed to parse card: ${cardError.message}`);
        }
      }
    }
    
    // Alternative: try to get notes directly if cards didn't work
    if (flashcards.length === 0 && collection.notes && Array.isArray(collection.notes)) {
      for (const note of collection.notes) {
        try {
          let front = '';
          let back = '';
          
          if (note.fields) {
            const fields = note.fields;
            if (Array.isArray(fields) && fields.length >= 2) {
              front = stripHtml(fields[0] || '');
              back = stripHtml(fields[1] || '');
            } else if (typeof fields === 'string') {
              // Fields might be tab-separated
              const parts = fields.split('\x1f'); // Anki uses unit separator
              if (parts.length >= 2) {
                front = stripHtml(parts[0] || '');
                back = stripHtml(parts[1] || '');
              }
            }
          }
          
          if (front.trim() && back.trim()) {
            flashcards.push({ front: front.trim(), back: back.trim() });
          }
        } catch (noteError) {
          errors.push(`Failed to parse note: ${noteError.message}`);
        }
      }
    }
    
    if (flashcards.length === 0) {
      errors.push('No valid flashcards found in the file. The deck may be empty or use an unsupported format.');
    }
    
  } catch (parseError) {
    errors.push(`Failed to parse Anki file: ${parseError.message}`);
  }
  
  return { flashcards, deckName, errors };
}

/**
 * Strip HTML tags from a string.
 * @param {string} html - String potentially containing HTML
 * @returns {string} - Plain text
 */
function stripHtml(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')  // Convert <br> to newlines
    .replace(/<[^>]+>/g, '')         // Remove all HTML tags
    .replace(/&nbsp;/g, ' ')         // Convert &nbsp; to space
    .replace(/&lt;/g, '<')           // Convert &lt; to <
    .replace(/&gt;/g, '>')           // Convert &gt; to >
    .replace(/&amp;/g, '&')          // Convert &amp; to &
    .replace(/&quot;/g, '"')         // Convert &quot; to "
    .replace(/&#39;/g, "'")          // Convert &#39; to '
    .trim();
}
