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
