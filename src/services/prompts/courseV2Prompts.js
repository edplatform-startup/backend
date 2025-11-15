export function plannerSyllabus({ university, courseName, syllabusText, examFormatDetails, topics } = {}) {
  const context = [];
  if (syllabusText) {
    context.push(`Syllabus notes: ${syllabusText}`);
  }
  if (examFormatDetails) {
    context.push(`Exam format: ${examFormatDetails}`);
  }
  if (Array.isArray(topics) && topics.length > 0) {
    context.push(`Preferred topics (student ranked): ${topics.join(', ')}`);
  }

  const contextBlock = context.length ? `\n\nContext:\n${context.join('\n')}` : '';

  return [
    {
      role: 'system',
      content:
        'You are a meticulous university syllabus architect focused on exam alignment.\n- Locate and rely on the official syllabus/outline for the specified university + course whenever possible (web_search/browse_page allowed).\n- Integrate examFormatDetails to emphasize tested competencies.\n- topic_graph.nodes MUST be exam-relevant conceptual units (e.g., "Asymptotic Analysis"), not logistics/meta items (no "Exam Review", "Study Habits"). Include prerequisite units only when the exam depends on them.\n- Return ONLY JSON with outcomes[], topic_graph{nodes[],edges[]}, sources[].',
    },
    {
      role: 'user',
      content: `University: ${university || 'N/A'}\nCourse: ${courseName || 'N/A'}\nTask: Produce syllabus JSON with outcomes (3+), concept nodes (id,title,summary,refs), prerequisite edges (from,to,reason), and sources (title,url).${contextBlock}`,
    },
  ];
}

export function plannerModules() {
  return [
    {
      role: 'system',
      content:
        'Convert a topic graph into 6–10 ordered modules.\nEach module: id, title, dependsOn[], outcomes[], hours_estimate(4–8), covers_nodes[].\nReturn ONLY JSON.',
    },
  ];
}

export function writerLessons() {
  return [
    {
      role: 'system',
      content:
        'Design concrete lessons for each module.\nSTRICT JSON RULES:\n- Response MUST be valid JSON that JSON.parse can consume with zero errors.\n- No comments, trailing commas, prose, or extra text before/after JSON.\n- Every URL must be a JSON string wrapped in double quotes (e.g. "url": "https://...").\n- Never emit bare URLs, markdown, or code fences.\n- Either return an object { "lessons": [ ... ] } or return just an array [ ... ].\nLESSON REQUIREMENTS:\n- Produce 2-4 lessons per module and ensure course total lessons >= 6.\n- Each lesson object MUST include: id (string), moduleId (string), title (string), objectives (non-empty array of strings), duration_min (number between 40-60 target), reading (array <=3 of {title,url,est_min?}), activities (array of 1-2 objects with allowed types guided_example | problem_set | discussion | project_work), bridge_from[], bridge_to[], cross_refs[].\n- Keep readings credible; use placeholder like "https://example.com/placeholder" only if no source is available.\n- Activities should include clear goal (string) and optional steps[].\n- Honor module outcomes and keep lessons cohesive.\nReturn ONLY the JSON payload, no explanation.',
    },
  ];
}

export function assessorAssessments() {
  return [
    {
      role: 'system',
      content:
        'Create assessments aligned to outcomes.\nweekly_quizzes: 3–6 items per module (MCQ or FRQ), each with anchors (lesson or node ids).\nproject: title, brief, milestones[], rubric.\nexam_blueprint: sections[] with weight_pct and outcomes[].\nReturn ONLY JSON.',
    },
  ];
}

export function criticCourse() {
  return [
    {
      role: 'system',
      content:
        'You are a strict course auditor. Identify coverage gaps, flow issues, alignment problems, and load imbalance.\nReturn JSON: {"issues":[...], "revision_patch": { ...minimal schema-conformant edits... } }',
    },
  ];
}

export function selectorModules() {
  return [
    {
      role: 'system',
      content:
        'Select or merge the best module plan for: full node coverage, DAG order, balanced hours, and outcome alignment.\nReturn ONLY the final plan JSON.',
    },
  ];
}
