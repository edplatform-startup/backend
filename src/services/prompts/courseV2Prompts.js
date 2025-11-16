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
        'You are a meticulous university syllabus architect focused on exam alignment.\n- Locate and rely on the official syllabus/outline for the specified university + course whenever possible (web_search/browse_page allowed).\n- Integrate examFormatDetails to emphasize tested competencies.\n- topic_graph.nodes MUST be exam-relevant conceptual units (e.g., "Asymptotic Analysis"), not logistics/meta items (no "Exam Review", "Study Habits"). Include prerequisite units only when the exam depends on them.\n- Return ONLY JSON with outcomes[], topic_graph{nodes[],edges[]}, sources[].\nEXAMPLE JSON:\n{"outcomes":["Master core concepts","Apply techniques to problems","Analyze complex scenarios"],"topic_graph":{"nodes":[{"id":"node1","title":"Concept Name","summary":"Brief description","refs":["https://example.com/resource"]}],"edges":[{"from":"node1","to":"node2","reason":"prerequisite relationship"}]},"sources":[{"url":"https://university.edu/syllabus","title":"Official Syllabus"}]}',
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
        'Convert a topic graph into 6–10 ordered modules.\nEach module: id, title, dependsOn[], outcomes[], hours_estimate(4–8), covers_nodes[].\nEXAMPLE JSON:\n{"modules":[{"id":"mod1","title":"Module 1: Introduction","dependsOn":[],"outcomes":["Understand basic concepts"],"hours_estimate":6,"covers_nodes":["node1","node2"]}]}\nReturn ONLY JSON.',
    },
  ];
}

export function writerLessons() {
  return [
    {
      role: 'system',
      content:
        'Design concrete lessons for each module.\nSTRICT JSON RULES:\n- Response MUST be valid JSON that JSON.parse can consume with zero errors.\n- No comments, trailing commas, prose, or extra text before/after JSON.\n- Every URL must be a JSON string wrapped in double quotes (e.g. "url": "https://...").\n- Never emit bare URLs, markdown, or code fences.\n- Either return an object { "lessons": [ ... ] } or return just an array [ ... ].\nLESSON REQUIREMENTS:\n- Produce 2-4 lessons per module and ensure course total lessons >= 6.\n- Each lesson object MUST include: id (string), moduleId (string), title (string), objectives (non-empty array of strings), duration_min (number between 40-60 target), reading (array <=3 of {title,url,est_min?}), activities (array of 1-2 objects with allowed types guided_example | problem_set | discussion | project_work), bridge_from[], bridge_to[], cross_refs[].\n- Keep readings credible; use placeholder like "https://example.com/placeholder" only if no source is available.\n- Activities should include clear goal (string) and optional steps[].\n- Honor module outcomes and keep lessons cohesive.\nEXAMPLE JSON FORMAT:\n{"lessons":[{"id":"mod1-lesson1","moduleId":"mod1","title":"Introduction to Topic","objectives":["Understand concept A","Apply technique B"],"duration_min":45,"reading":[{"title":"Resource Name","url":"https://example.com/resource","est_min":10}],"activities":[{"type":"guided_example","goal":"Practice core concepts","steps":["Step 1","Step 2"]}],"bridge_from":[],"bridge_to":[],"cross_refs":[]}]}\nReturn ONLY the JSON payload, no explanation.',
    },
  ];
}

export function assessorAssessments() {
  return [
    {
      role: 'system',
      content:
        'Create assessments aligned to outcomes.\nSTRICT JSON FORMAT:\n- weekly_quizzes: array of objects with moduleId (string) and items (array of 3-6 questions)\n- Each quiz item MUST be either MCQ or FRQ:\n  MCQ: {"type":"mcq","question":"Question text?","options":["A","B","C","D"],"answerIndex":0,"explanation":"Why A is correct","anchors":["lesson_id"]}\n  FRQ: {"type":"frq","prompt":"Question prompt","model_answer":"Expected answer","rubric":"Grading criteria","anchors":["lesson_id"]}\n- project: {"title":"string","brief":"string","milestones":["milestone1","milestone2"],"rubric":"string"}\n- exam_blueprint: {"sections":[{"title":"Section Name","weight_pct":60,"outcomes":["outcome1","outcome2"]}]}\nEXAMPLE JSON:\n{"weekly_quizzes":[{"moduleId":"mod1","items":[{"type":"mcq","question":"What is X?","options":["A","B","C","D"],"answerIndex":0,"explanation":"Brief explanation","anchors":["lesson1"]}]}],"project":{"title":"Final Project","brief":"Description","milestones":["Milestone 1","Milestone 2"],"rubric":"Grading rubric"},"exam_blueprint":{"sections":[{"title":"Core Concepts","weight_pct":60,"outcomes":["Outcome 1","Outcome 2"]}]}}\nKeep explanations/rubrics concise (≤3 sentences) to reduce token usage.\nReturn ONLY JSON with keys weekly_quizzes, project, exam_blueprint — no commentary.',
    },
  ];
}

export function criticCourse() {
  return [
    {
      role: 'system',
      content:
        'You are a strict course auditor. Identify coverage gaps, flow issues, alignment problems, and load imbalance.\nDo NOT violate CoursePackage schema constraints: keep at least the original module count (minimum 4), preserve required arrays/keys, and only adjust content within the existing structure.\nEXAMPLE JSON:\n{"issues":["Issue description 1","Issue description 2"],"revision_patch":{"modules":{"modules":[{"id":"mod1","title":"Updated Title"}]}}}\nReturn JSON: {"issues":[...], "revision_patch": { ...minimal schema-conformant edits... } }',
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
