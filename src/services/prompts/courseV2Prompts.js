export function plannerSyllabus({ university, courseName, syllabusText, examFormatDetails, topics } = {}) {
  const syllabusDetails = syllabusText || 'Not provided.';
  const examDetails = examFormatDetails || 'Not provided.';
  const preferredTopics = Array.isArray(topics) && topics.length > 0 ? topics.join(', ') : null;
  const topicLine = preferredTopics ? `\n\nStudent priorities: ${preferredTopics}` : '';

  return [
    {
      role: 'system',
      content:
        'You are a university curriculum architect. Your goal is to extract the STRUCTURAL SKELETON of the course exactly as the professor intends.\n\n1. Analyze the input syllabus.\n2. Identify the primary organizational unit (e.g., "Weeks", "Modules", "Chapters", or "Thematic Units").\n3. Extract the chronological sequence of these units.\n4. For each unit, list the raw concepts mentioned.\n5. IGNORE logistics (grading policies, office hours) unless they describe exam formats.\n6. TITLES MUST BE CLEAN: Do NOT include numbering prefixes like "Week 1:", "Module 1:", "Chapter 1:". Just use the descriptive title.\n\nReturn JSON:\n{\n  "course_structure_type": "Week-based" | "Module-based" | "Topic-based",\n  "skeleton": [\n    {\n      "sequence_order": 1,\n      "title": "Introduction to Limits",\n      "raw_concepts": ["epsilon-delta definition", "limit laws", "continuity"],\n      "is_exam_review": false\n    }\n    ...\n  ]\n}',
    },
    {
      role: 'user',
      content: `University: ${university || 'N/A'}\nCourse: ${courseName || 'N/A'}\n\nSyllabus details:\n${syllabusDetails}\n\nExam format details:\n${examDetails}${topicLine}`,
    },
  ];
}
