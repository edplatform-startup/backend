export function plannerSyllabus(university, courseName) {
  return [
    {
      role: 'system',
      content:
        'You are a meticulous university course architect. Use authoritative curriculum/syllabus sources when tools are enabled.\nReturn ONLY JSON conforming to: outcomes[], topic_graph{nodes[],edges[]}, sources[].',
    },
    {
      role: 'user',
      content: `University: ${university || 'N/A'}\nCourse: ${courseName || 'N/A'}\nTask: Produce syllabus JSON with outcomes (3+), concept nodes (id,title,summary,refs), prerequisite edges (from,to,reason), and sources (title,url).`,
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
        'Design concrete lessons for each module.\nEach lesson: id, moduleId, title, objectives(1–3), duration_min(40–60),\nreadings (<=3, each {title,url,est_min?}), activities(1–2 of: guided_example | problem_set | discussion),\nbridge_from[], bridge_to[], cross_refs[].\nWhen tools are enabled you may find readings. Return ONLY JSON.',
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
