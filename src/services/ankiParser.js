/**
 * Anki APKG file parser service.
 * Parses .apkg files (ZIP containing SQLite database) and extracts flashcards.
 */

import AdmZip from 'adm-zip';
import initSqlJs from 'sql.js';

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
    // .apkg files are ZIP archives
    const zip = new AdmZip(fileBuffer);
    const zipEntries = zip.getEntries();
    
    // Find the collection database file (collection.anki2 or collection.anki21)
    let dbEntry = null;
    for (const entry of zipEntries) {
      const name = entry.entryName.toLowerCase();
      if (name === 'collection.anki2' || name === 'collection.anki21' || name.endsWith('.anki2')) {
        dbEntry = entry;
        break;
      }
    }
    
    if (!dbEntry) {
      errors.push('No Anki database found in the file. Expected collection.anki2 or collection.anki21.');
      return { flashcards, deckName, errors };
    }
    
    // Extract the SQLite database
    const dbBuffer = dbEntry.getData();
    
    // Initialize sql.js and load the database
    const SQL = await initSqlJs();
    const db = new SQL.Database(new Uint8Array(dbBuffer));
    
    // Try to get deck name from col table
    try {
      const colResult = db.exec("SELECT decks FROM col LIMIT 1");
      if (colResult.length > 0 && colResult[0].values.length > 0) {
        const decksJson = colResult[0].values[0][0];
        if (decksJson) {
          const decks = JSON.parse(decksJson);
          const deckValues = Object.values(decks);
          // Find first non-default deck
          for (const deck of deckValues) {
            if (deck.name && deck.name !== 'Default') {
              deckName = deck.name;
              break;
            }
          }
        }
      }
    } catch (deckError) {
      // Ignore deck name extraction errors
    }
    
    // Query notes table for flashcard content
    // Notes have 'flds' column with fields separated by unit separator (0x1f)
    try {
      const notesResult = db.exec("SELECT flds FROM notes");
      
      if (notesResult.length > 0) {
        for (const row of notesResult[0].values) {
          const fieldsStr = row[0];
          if (!fieldsStr) continue;
          
          // Anki uses unit separator (ASCII 31) to separate fields
          const fields = fieldsStr.split('\x1f');
          
          if (fields.length >= 2) {
            const front = stripHtml(fields[0] || '');
            const back = stripHtml(fields[1] || '');
            
            if (front.trim() && back.trim()) {
              flashcards.push({ front: front.trim(), back: back.trim() });
            }
          }
        }
      }
    } catch (queryError) {
      errors.push(`Failed to query notes: ${queryError.message}`);
    }
    
    db.close();
    
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
