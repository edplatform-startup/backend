// json5 not available, using custom parser
// Actually, I'll implement a robust pure JS solution to avoid adding dependencies if possible, 
// but json5 is great for trailing commas/comments. I'll check package.json first. 
// For now, I will write a robust custom parser/repairer.

/**
 * Attempts to parse a string as JSON, applying various repair strategies if standard parsing fails.
 * @param {string} text - The raw string to parse.
 * @param {string} [contextLabel] - Optional label for error logging (e.g. "Reading Generator").
 * @returns {any} The parsed JSON object or array.
 * @throws {Error} If parsing fails after all repair attempts.
 */
export function tryParseJson(text, contextLabel = 'Unknown Context') {
  if (!text || typeof text !== 'string') {
    throw new Error(`[${contextLabel}] Input is empty or not a string.`);
  }

  const cleaned = cleanLlmOutput(text);

  // Strategy 1: Direct Parse
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Continue to repair strategies
  }

  // Strategy 2: Repair Common Syntax Errors (Trailing commas, single quotes)
  const repairedSyntax = repairJsonSyntax(cleaned);
  try {
    return JSON.parse(repairedSyntax);
  } catch (e) {
    // Continue
  }

  // Strategy 3: Handle Truncation (Balance braces/brackets)
  const balanced = balanceBraces(repairedSyntax);
  try {
    return JSON.parse(balanced);
  } catch (e) {
    // Continue
  }

  // Strategy 4: Aggressive Extraction (Find first { and last })
  const extracted = extractJsonBlock(cleaned);
  if (extracted && extracted !== cleaned) {
     try {
      return JSON.parse(extracted);
    } catch (e) {
       // Try balancing the extracted block
       try {
         return JSON.parse(balanceBraces(extracted));
       } catch (e2) {
         // Fail
       }
    }
  }

  throw new Error(`[${contextLabel}] Failed to parse JSON after repair attempts. Raw length: ${text.length}`);
}

/**
 * Removes markdown fences and extra text surrounding the JSON.
 */
function cleanLlmOutput(text) {
  let cleaned = text.trim();
  
  // Remove markdown code blocks
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  
  // Remove "Here is the JSON:" prefixes (simple heuristic)
  // We look for the first '[' or '{'
  const firstBrace = cleaned.search(/[{[]/);
  if (firstBrace > 0) {
    cleaned = cleaned.substring(firstBrace);
  }
  
  // Remove trailing text after the last ']' or '}'
  // This is a bit risky if the text is truncated, but good for "Hope this helps!" suffixes
  // We'll do this carefully: find the last closing brace that matches the first opening brace type
  // Actually, let's just trim whitespace for now. Aggressive extraction handles the rest.
  
  return cleaned.trim();
}

/**
 * Fixes common syntax errors like trailing commas, single quotes, comments.
 */
function repairJsonSyntax(text) {
  let repaired = text;

  // 1. Remove comments (//... and /*...*/)
  // Note: This regex is simple and might catch URLs, but usually fine for JSON data
  repaired = repaired.replace(/\/\/.*$/gm, ''); 
  repaired = repaired.replace(/\/\*[\s\S]*?\*\//g, '');

  // 2. Replace single quotes with double quotes for keys and string values
  // This is tricky to do with regex without breaking content. 
  // A safer bet is to use a library like 'json5' if available, but let's try a simple heuristic for keys.
  // Keys: 'key': -> "key":
  repaired = repaired.replace(/'([^']+)'\s*:/g, '"$1":');
  // Values: : 'value' -> : "value"
  repaired = repaired.replace(/:\s*'([^']+)'/g, ': "$1"');
  
  // 3. Remove trailing commas
  // Objects: , } -> }
  repaired = repaired.replace(/,\s*}/g, '}');
  // Arrays: , ] -> ]
  repaired = repaired.replace(/,\s*]/g, ']');

  return repaired;
}

/**
 * Balances opening and closing braces/brackets to handle truncated JSON.
 */
function balanceBraces(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    if (escaped) {
      escaped = false;
      continue;
    }
    
    if (char === '\\') {
      escaped = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === '{' || char === '[') {
        stack.push(char);
      } else if (char === '}') {
        if (stack.length > 0 && stack[stack.length - 1] === '{') {
          stack.pop();
        }
      } else if (char === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === '[') {
          stack.pop();
        }
      }
    }
  }
  
  // If we are still in a string, close it
  let balanced = text;
  if (inString) {
    balanced += '"';
  }
  
  // Close remaining open structures in reverse order
  while (stack.length > 0) {
    const open = stack.pop();
    if (open === '{') balanced += '}';
    if (open === '[') balanced += ']';
  }
  
  return balanced;
}

/**
 * Extracts the largest substring that looks like a JSON object or array.
 */
function extractJsonBlock(text) {
  const firstCurly = text.indexOf('{');
  const firstSquare = text.indexOf('[');
  
  let start = -1;
  if (firstCurly === -1 && firstSquare === -1) return null;
  
  if (firstCurly !== -1 && firstSquare !== -1) {
    start = Math.min(firstCurly, firstSquare);
  } else {
    start = Math.max(firstCurly, firstSquare);
  }
  
  const lastCurly = text.lastIndexOf('}');
  const lastSquare = text.lastIndexOf(']');
  
  let end = -1;
  if (lastCurly !== -1 && lastSquare !== -1) {
    end = Math.max(lastCurly, lastSquare);
  } else {
    end = Math.max(lastCurly, lastSquare);
  }
  
  if (start !== -1 && end !== -1 && end > start) {
    return text.substring(start, end + 1);
  }
  
  return null;
}
