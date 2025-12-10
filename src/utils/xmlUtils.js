/**
 * XML Utilities for LLM Content Parsing
 * 
 * Provides conversion from XML-delimited Markdown output to JSON structures
 * for course content generation. Maintains the same JSON output format as
 * before for API compatibility.
 */

/**
 * Parse readings from XML-tagged Markdown.
 * Format: <LESSON id="lesson_id">Markdown content with LaTeX</LESSON>
 * @param {string} responseText - Raw text from LLM with XML-delimited lessons
 * @returns {Map<string, string>} - Map of lesson_id -> reading markdown
 */
export function parseXmlReadings(responseText) {
  const result = new Map();
  if (!responseText) return result;

  // Regex to capture content between <LESSON id="...">...</LESSON> tags
  // [\s\S] matches newlines, *? is non-greedy
  const regex = /<LESSON\s+id="([^"]+)">([\s\S]*?)<\/LESSON>/g;
  let match;
  
  while ((match = regex.exec(responseText)) !== null) {
    const lessonId = match[1].trim();
    const content = match[2].trim();
    if (lessonId && content) {
      result.set(lessonId, content);
    }
  }

  return result;
}

/**
 * Parse quizzes from XML-tagged content.
 * Format:
 * <QUIZ lesson_id="...">
 *   <QUESTION correct="1" confidence="0.9">
 *     <TEXT>Question text</TEXT>
 *     <OPTION_A>Option A text</OPTION_A>
 *     <OPTION_B>Option B text</OPTION_B>
 *     <OPTION_C>Option C text</OPTION_C>
 *     <OPTION_D>Option D text</OPTION_D>
 *     <EXPLAIN_A>Explanation for A</EXPLAIN_A>
 *     <EXPLAIN_B>Explanation for B</EXPLAIN_B>
 *     <EXPLAIN_C>Explanation for C</EXPLAIN_C>
 *     <EXPLAIN_D>Explanation for D</EXPLAIN_D>
 *   </QUESTION>
 * </QUIZ>
 * 
 * @param {string} responseText - Raw XML text from LLM
 * @returns {Map<string, Array>} - Map of lesson_id -> quiz questions array
 */
export function parseXmlQuizzes(responseText) {
  const result = new Map();
  if (!responseText) return result;

  // Match each QUIZ block
  const quizRegex = /<QUIZ\s+lesson_id="([^"]+)">([\s\S]*?)<\/QUIZ>/g;
  let quizMatch;

  while ((quizMatch = quizRegex.exec(responseText)) !== null) {
    const lessonId = quizMatch[1].trim();
    const quizContent = quizMatch[2];
    
    if (!lessonId) continue;

    const questions = [];
    
    // Match each QUESTION within the quiz
    const questionRegex = /<QUESTION\s+correct="(\d)"\s*(?:confidence="([^"]*)")?\s*>([\s\S]*?)<\/QUESTION>/g;
    let qMatch;

    while ((qMatch = questionRegex.exec(quizContent)) !== null) {
      const correctIndex = parseInt(qMatch[1], 10) || 0;
      const confidence = parseFloat(qMatch[2]) || 0.8;
      const questionContent = qMatch[3];

      // Extract question text and options
      const getText = (tag) => {
        const match = questionContent.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return match ? match[1].trim() : '';
      };

      const question = {
        question: getText('TEXT'),
        options: [
          getText('OPTION_A'),
          getText('OPTION_B'),
          getText('OPTION_C'),
          getText('OPTION_D')
        ],
        correct_index: correctIndex,
        explanation: [
          getText('EXPLAIN_A'),
          getText('EXPLAIN_B'),
          getText('EXPLAIN_C'),
          getText('EXPLAIN_D')
        ],
        _confidence: confidence,
        _needsValidation: confidence < 0.7
      };

      // Only add if we have valid content
      if (question.question && question.options.every(o => o)) {
        questions.push(question);
      }
    }

    if (questions.length > 0) {
      result.set(lessonId, questions);
    }
  }

  return result;
}

/**
 * Parse flashcards from XML-tagged content.
 * Format:
 * <FLASHCARDS lesson_id="...">
 *   <CARD>
 *     <FRONT>Question/prompt</FRONT>
 *     <BACK>Answer/explanation</BACK>
 *   </CARD>
 * </FLASHCARDS>
 * 
 * @param {string} responseText - Raw XML text from LLM
 * @returns {Map<string, Array>} - Map of lesson_id -> flashcards array
 */
export function parseXmlFlashcards(responseText) {
  const result = new Map();
  if (!responseText) return result;

  // Match each FLASHCARDS block
  const flashcardsRegex = /<FLASHCARDS\s+lesson_id="([^"]+)">([\s\S]*?)<\/FLASHCARDS>/g;
  let fcMatch;

  while ((fcMatch = flashcardsRegex.exec(responseText)) !== null) {
    const lessonId = fcMatch[1].trim();
    const cardsContent = fcMatch[2];
    
    if (!lessonId) continue;

    const flashcards = [];
    
    // Match each CARD within the flashcards block
    const cardRegex = /<CARD>([\s\S]*?)<\/CARD>/g;
    let cardMatch;

    while ((cardMatch = cardRegex.exec(cardsContent)) !== null) {
      const cardContent = cardMatch[1];

      const frontMatch = cardContent.match(/<FRONT>([\s\S]*?)<\/FRONT>/i);
      const backMatch = cardContent.match(/<BACK>([\s\S]*?)<\/BACK>/i);

      const front = frontMatch ? frontMatch[1].trim() : '';
      const back = backMatch ? backMatch[1].trim() : '';

      if (front && back) {
        flashcards.push({ front, back });
      }
    }

    if (flashcards.length > 0) {
      result.set(lessonId, flashcards);
    }
  }

  return result;
}

/**
 * Parse topics from XML-tagged content for topic generation.
 * Format:
 * <TOPICS>
 *   <TOPIC title="..." skeleton_ref="...">
 *     <SUBTOPIC title="..." bloom="..." yield="...">
 *       Exam relevance reasoning text
 *     </SUBTOPIC>
 *   </TOPIC>
 * </TOPICS>
 * 
 * @param {string} responseText - Raw XML text from LLM
 * @returns {object} - Object with overviewTopics array matching existing JSON schema
 */
export function parseXmlTopics(responseText) {
  const overviewTopics = [];
  if (!responseText) return { overviewTopics };

  // Match TOPICS wrapper
  const topicsMatch = responseText.match(/<TOPICS>([\s\S]*?)<\/TOPICS>/i);
  if (!topicsMatch) return { overviewTopics };

  const topicsContent = topicsMatch[1];

  // Match each TOPIC
  const topicRegex = /<TOPIC\s+title="([^"]*)"\s*(?:skeleton_ref="([^"]*)")?\s*>([\s\S]*?)<\/TOPIC>/g;
  let topicMatch;

  while ((topicMatch = topicRegex.exec(topicsContent)) !== null) {
    const topicTitle = topicMatch[1].trim();
    const skeletonRef = topicMatch[2]?.trim() || '';
    const topicContent = topicMatch[3];

    const subtopics = [];

    // Match each SUBTOPIC
    const subtopicRegex = /<SUBTOPIC\s+title="([^"]*)"\s*bloom="([^"]*)"\s*yield="([^"]*)">([\s\S]*?)<\/SUBTOPIC>/g;
    let stMatch;

    while ((stMatch = subtopicRegex.exec(topicContent)) !== null) {
      const stTitle = stMatch[1].trim();
      const bloom = stMatch[2].trim();
      const yieldValue = stMatch[3].trim();
      const reasoning = stMatch[4].trim();

      if (stTitle) {
        subtopics.push({
          title: stTitle,
          bloom_level: bloom || 'Understand',
          exam_relevance_reasoning: reasoning || 'Exam relevance not specified.',
          yield: yieldValue || 'Medium'
        });
      }
    }

    if (topicTitle && subtopics.length > 0) {
      overviewTopics.push({
        title: topicTitle,
        original_skeleton_ref: skeletonRef,
        subtopics
      });
    }
  }

  return { overviewTopics };
}

/**
 * Parse inline questions from XML-tagged content.
 * Format:
 * <INLINE_QUESTIONS lesson_id="...">
 *   <QUESTION chunk="0" correct="1" confidence="0.85">
 *     <TEXT>Question text</TEXT>
 *     <OPTION_A>Option A</OPTION_A>
 *     <OPTION_B>Option B</OPTION_B>
 *     <OPTION_C>Option C</OPTION_C>
 *     <OPTION_D>Option D</OPTION_D>
 *     <EXPLAIN_A>Explanation A</EXPLAIN_A>
 *     <EXPLAIN_B>Explanation B</EXPLAIN_B>
 *     <EXPLAIN_C>Explanation C</EXPLAIN_C>
 *     <EXPLAIN_D>Explanation D</EXPLAIN_D>
 *   </QUESTION>
 * </INLINE_QUESTIONS>
 * 
 * @param {string} responseText - Raw XML text from LLM
 * @returns {Map<string, Array>} - Map of lesson_id -> array of inline question objects
 */
export function parseXmlInlineQuestions(responseText) {
  const result = new Map();
  if (!responseText) return result;

  // Match each INLINE_QUESTIONS block
  const blockRegex = /<INLINE_QUESTIONS\s+lesson_id="([^"]+)">([\s\S]*?)<\/INLINE_QUESTIONS>/g;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(responseText)) !== null) {
    const lessonId = blockMatch[1].trim();
    const blockContent = blockMatch[2];
    
    if (!lessonId) continue;

    const questions = [];
    
    // Match each QUESTION
    const questionRegex = /<QUESTION\s+chunk="(\d+)"\s*correct="(\d)"\s*(?:confidence="([^"]*)")?\s*>([\s\S]*?)<\/QUESTION>/g;
    let qMatch;

    while ((qMatch = questionRegex.exec(blockContent)) !== null) {
      const chunkIndex = parseInt(qMatch[1], 10) || 0;
      const correctIndex = parseInt(qMatch[2], 10) || 0;
      const confidence = parseFloat(qMatch[3]) || 0.8;
      const questionContent = qMatch[4];

      const getText = (tag) => {
        const match = questionContent.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return match ? match[1].trim() : '';
      };

      const question = {
        chunkIndex,
        question: getText('TEXT'),
        options: [
          getText('OPTION_A'),
          getText('OPTION_B'),
          getText('OPTION_C'),
          getText('OPTION_D')
        ],
        answerIndex: correctIndex,
        explanation: [
          getText('EXPLAIN_A'),
          getText('EXPLAIN_B'),
          getText('EXPLAIN_C'),
          getText('EXPLAIN_D')
        ],
        confidence,
        _needsValidation: confidence < 0.7
      };

      if (question.question && question.options.every(o => o)) {
        questions.push(question);
      }
    }

    if (questions.length > 0) {
      result.set(lessonId, questions);
    }
  }

  return result;
}

/**
 * Parse practice problems from XML-tagged content.
 * Format:
 * <PRACTICE_PROBLEMS lesson_id="...">
 *   // ... content ...
 * </PRACTICE_PROBLEMS>
 * 
 * @param {string} responseText - Raw XML text from LLM
 * @returns {Map<string, Array>} - Map of lesson_id -> practice problems array
 */
export function parseXmlPracticeProblems(responseText) {
  const result = new Map();
  if (!responseText) return result;

  // Match each PRACTICE_PROBLEMS block
  const blockRegex = /<PRACTICE_PROBLEMS\s+lesson_id="([^"]+)">([\s\S]*?)<\/PRACTICE_PROBLEMS>/g;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(responseText)) !== null) {
    const lessonId = blockMatch[1].trim();
    const blockContent = blockMatch[2];
    
    if (!lessonId) continue;

    const problems = [];
    
    // Match each PROBLEM
    const problemRegex = /<PROBLEM(?:\s+estimated_minutes="([^"]*)")?(?:\s+difficulty="([^"]*)")?>([\s\S]*?)<\/PROBLEM>/g;
    let pMatch;

    while ((pMatch = problemRegex.exec(blockContent)) !== null) {
      const estMinutes = parseInt(pMatch[1], 10) || 15;
      const difficulty = pMatch[2] || 'Hard';
      const problemContent = pMatch[3];

      const getText = (tag) => {
        const match = problemContent.match(new RegExp(`<${tag}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return match ? match[1].trim() : '';
      };

      const getAttr = (tag, attr) => {
        const match = problemContent.match(new RegExp(`<${tag}[^>]*\\s+${attr}="([^"]*)"`, 'i'));
        return match ? match[1] : null;
      };

      // Rubric parsing
      const rubricContent = getText('RUBRIC');
      const totalPoints = parseInt(getAttr('RUBRIC', 'total_points'), 10) || 10;
      const gradingCriteria = [];
      const critRegex = /<CRITERION\s+points="(\d+)">([\s\S]*?)<\/CRITERION>/g;
      let cMatch;
      while ((cMatch = critRegex.exec(rubricContent)) !== null) {
        gradingCriteria.push({
          criterion: cMatch[2].trim(),
          points: parseInt(cMatch[1], 10),
          common_errors: []
        });
      }

      // Sample Answer parsing
      const answerContent = getText('SAMPLE_ANSWER');
      const steps = [];
      const stepRegex = /<STEP>([\s\S]*?)<\/STEP>/g;
      let sMatch;
      while ((sMatch = stepRegex.exec(answerContent)) !== null) {
        steps.push(sMatch[1].trim());
      }
      const finalAnswer = getText('FINAL_ANSWER', answerContent) || (answerContent.match(/<FINAL_ANSWER>([\s\S]*?)<\/FINAL_ANSWER>/i)?.[1] || '').trim();

      const problem = {
        question: getText('QUESTION'),
        estimated_minutes: estMinutes,
        difficulty,
        topic_tags: [],
        rubric: {
          total_points: totalPoints,
          grading_criteria: gradingCriteria,
          partial_credit_policy: 'Award partial credit for correct approach.'
        },
        sample_answer: {
          solution_steps: steps,
          final_answer: finalAnswer,
          key_insights: [],
          alternative_approaches: []
        },
        _needsValidation: false
      };

      if (problem.question && problem.sample_answer.final_answer) {
        problems.push(problem);
      }
    }

    if (problems.length > 0) {
      result.set(lessonId, problems);
    }
  }

  return result;
}

/**
 * Parse Parsons (ranking/sorting) problems from XML-tagged content.
 * Format:
 * <PARSONS_PROBLEMS lesson_id="...">
 *   <PROBLEM>
 *     <PROMPT>Reorder these items correctly</PROMPT>
 *     <ITEM id="a">First item</ITEM>
 *     <ITEM id="b">Second item</ITEM>
 *     <CORRECT_ORDER>b,a</CORRECT_ORDER>
 *   </PROBLEM>
 * </PARSONS_PROBLEMS>
 * 
 * @param {string} responseText - Raw XML text from LLM
 * @returns {Map<string, Array>} - Map of lesson_id -> parsons problems array
 */
export function parseXmlParsonsProblems(responseText) {
  const result = new Map();
  if (!responseText) return result;

  const blockRegex = /<PARSONS_PROBLEMS\s+lesson_id="([^"]+)">([\s\S]*?)<\/PARSONS_PROBLEMS>/g;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(responseText)) !== null) {
    const lessonId = blockMatch[1].trim();
    const blockContent = blockMatch[2];
    
    if (!lessonId) continue;

    const problems = [];
    const problemRegex = /<PROBLEM>([\s\S]*?)<\/PROBLEM>/g;
    let pMatch;

    while ((pMatch = problemRegex.exec(blockContent)) !== null) {
      const problemContent = pMatch[1];

      const getText = (tag) => {
        const match = problemContent.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return match ? match[1].trim() : '';
      };

      // Extract items
      const items = [];
      const itemRegex = /<ITEM\s+id="([^"]+)">([\s\S]*?)<\/ITEM>/g;
      let itemMatch;
      while ((itemMatch = itemRegex.exec(problemContent)) !== null) {
        items.push({
          id: itemMatch[1].trim(),
          content: itemMatch[2].trim()
        });
      }

      // Extract correct order
      const correctOrderStr = getText('CORRECT_ORDER');
      const correctOrder = correctOrderStr ? correctOrderStr.split(',').map(s => s.trim()) : [];

      const problem = {
        id: crypto.randomUUID ? crypto.randomUUID() : `parsons-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'parsons',
        prompt: getText('PROMPT'),
        items,
        correct_order: correctOrder
      };

      if (problem.prompt && items.length > 0 && correctOrder.length > 0) {
        problems.push(problem);
      }
    }

    if (problems.length > 0) {
      result.set(lessonId, problems);
    }
  }

  return result;
}

/**
 * Parse Skeleton (faded example/fill-in-gap) problems from XML-tagged content.
 * Format:
 * <SKELETON_PROBLEMS lesson_id="...">
 *   <PROBLEM>
 *     <CONTEXT>Complete this formula</CONTEXT>
 *     <TEMPLATE>The answer is {{gap_1}} times {{gap_2}}</TEMPLATE>
 *     <GAP id="gap_1" correct="value1">
 *       <DISTRACTOR>wrong1</DISTRACTOR>
 *       <DISTRACTOR>wrong2</DISTRACTOR>
 *     </GAP>
 *   </PROBLEM>
 * </SKELETON_PROBLEMS>
 * 
 * @param {string} responseText - Raw XML text from LLM
 * @returns {Map<string, Array>} - Map of lesson_id -> skeleton problems array
 */
export function parseXmlSkeletonProblems(responseText) {
  const result = new Map();
  if (!responseText) return result;

  const blockRegex = /<SKELETON_PROBLEMS\s+lesson_id="([^"]+)">([\s\S]*?)<\/SKELETON_PROBLEMS>/g;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(responseText)) !== null) {
    const lessonId = blockMatch[1].trim();
    const blockContent = blockMatch[2];
    
    if (!lessonId) continue;

    const problems = [];
    const problemRegex = /<PROBLEM>([\s\S]*?)<\/PROBLEM>/g;
    let pMatch;

    while ((pMatch = problemRegex.exec(blockContent)) !== null) {
      const problemContent = pMatch[1];

      const getText = (tag) => {
        const match = problemContent.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return match ? match[1].trim() : '';
      };

      // Extract gaps
      const gaps = [];
      const gapRegex = /<GAP\s+id="([^"]+)"\s+correct="([^"]*)">([\s\S]*?)<\/GAP>/g;
      let gapMatch;
      while ((gapMatch = gapRegex.exec(problemContent)) !== null) {
        const gapContent = gapMatch[3];
        const distractors = [];
        const distractorRegex = /<DISTRACTOR>([\s\S]*?)<\/DISTRACTOR>/g;
        let dMatch;
        while ((dMatch = distractorRegex.exec(gapContent)) !== null) {
          distractors.push(dMatch[1].trim());
        }
        gaps.push({
          id: gapMatch[1].trim(),
          correct_value: gapMatch[2].trim(),
          distractors
        });
      }

      const problem = {
        id: crypto.randomUUID ? crypto.randomUUID() : `skeleton-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'skeleton',
        context: getText('CONTEXT'),
        template: getText('TEMPLATE'),
        gaps
      };

      if (problem.template && gaps.length > 0) {
        problems.push(problem);
      }
    }

    if (problems.length > 0) {
      result.set(lessonId, problems);
    }
  }

  return result;
}

/**
 * Parse Matching (many-to-many) problems from XML-tagged content.
 * Format:
 * <MATCHING_PROBLEMS lesson_id="...">
 *   <PROBLEM>
 *     <PROMPT>Match terms to definitions</PROMPT>
 *     <LEFT>Term 1</LEFT>
 *     <LEFT>Term 2</LEFT>
 *     <RIGHT>Definition A</RIGHT>
 *     <RIGHT>Definition B</RIGHT>
 *     <MATCH left="Term 1" right="Definition A"/>
 *   </PROBLEM>
 * </MATCHING_PROBLEMS>
 * 
 * @param {string} responseText - Raw XML text from LLM
 * @returns {Map<string, Array>} - Map of lesson_id -> matching problems array
 */
export function parseXmlMatchingProblems(responseText) {
  const result = new Map();
  if (!responseText) return result;

  const blockRegex = /<MATCHING_PROBLEMS\s+lesson_id="([^"]+)">([\s\S]*?)<\/MATCHING_PROBLEMS>/g;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(responseText)) !== null) {
    const lessonId = blockMatch[1].trim();
    const blockContent = blockMatch[2];
    
    if (!lessonId) continue;

    const problems = [];
    const problemRegex = /<PROBLEM>([\s\S]*?)<\/PROBLEM>/g;
    let pMatch;

    while ((pMatch = problemRegex.exec(blockContent)) !== null) {
      const problemContent = pMatch[1];

      const getText = (tag) => {
        const match = problemContent.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return match ? match[1].trim() : '';
      };

      // Extract left items
      const leftItems = [];
      const leftRegex = /<LEFT>([\s\S]*?)<\/LEFT>/g;
      let lMatch;
      while ((lMatch = leftRegex.exec(problemContent)) !== null) {
        leftItems.push(lMatch[1].trim());
      }

      // Extract right items
      const rightItems = [];
      const rightRegex = /<RIGHT>([\s\S]*?)<\/RIGHT>/g;
      let rMatch;
      while ((rMatch = rightRegex.exec(problemContent)) !== null) {
        rightItems.push(rMatch[1].trim());
      }

      // Extract matches
      const matches = [];
      const matchRegex = /<MATCH\s+left="([^"]*)"\s+right="([^"]*)"\s*\/>/g;
      let mMatch;
      while ((mMatch = matchRegex.exec(problemContent)) !== null) {
        matches.push({
          left: mMatch[1].trim(),
          right: mMatch[2].trim()
        });
      }

      const problem = {
        id: crypto.randomUUID ? crypto.randomUUID() : `matching-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'matching',
        prompt: getText('PROMPT'),
        left_items: leftItems,
        right_items: rightItems,
        matches
      };

      if (leftItems.length > 0 && rightItems.length > 0 && matches.length > 0) {
        problems.push(problem);
      }
    }

    if (problems.length > 0) {
      result.set(lessonId, problems);
    }
  }

  return result;
}

/**
 * Parse Blackbox (input/output inference) problems from XML-tagged content.
 * Format:
 * <BLACKBOX_PROBLEMS lesson_id="...">
 *   <PROBLEM>
 *     <HIDDEN_RULE>The function doubles the input</HIDDEN_RULE>
 *     <IO input="2" output="4"/>
 *     <IO input="5" output="10"/>
 *     <QUESTION>What does this function do?</QUESTION>
 *   </PROBLEM>
 * </BLACKBOX_PROBLEMS>
 * 
 * @param {string} responseText - Raw XML text from LLM
 * @returns {Map<string, Array>} - Map of lesson_id -> blackbox problems array
 */
export function parseXmlBlackboxProblems(responseText) {
  const result = new Map();
  if (!responseText) return result;

  const blockRegex = /<BLACKBOX_PROBLEMS\s+lesson_id="([^"]+)">([\s\S]*?)<\/BLACKBOX_PROBLEMS>/g;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(responseText)) !== null) {
    const lessonId = blockMatch[1].trim();
    const blockContent = blockMatch[2];
    
    if (!lessonId) continue;

    const problems = [];
    const problemRegex = /<PROBLEM>([\s\S]*?)<\/PROBLEM>/g;
    let pMatch;

    while ((pMatch = problemRegex.exec(blockContent)) !== null) {
      const problemContent = pMatch[1];

      const getText = (tag) => {
        const match = problemContent.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return match ? match[1].trim() : '';
      };

      // Extract I/O pairs
      const ioPairs = [];
      const ioRegex = /<IO\s+input="([^"]*)"\s+output="([^"]*)"\s*\/>/g;
      let ioMatch;
      while ((ioMatch = ioRegex.exec(problemContent)) !== null) {
        ioPairs.push({
          input: ioMatch[1].trim(),
          output: ioMatch[2].trim()
        });
      }

      const problem = {
        id: crypto.randomUUID ? crypto.randomUUID() : `blackbox-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'blackbox',
        hidden_rule: getText('HIDDEN_RULE'),
        io_pairs: ioPairs,
        question: getText('QUESTION')
      };

      if (ioPairs.length > 0 && problem.question) {
        problems.push(problem);
      }
    }

    if (problems.length > 0) {
      result.set(lessonId, problems);
    }
  }

  return result;
}

