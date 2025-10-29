import { Router } from 'express';
import { stringSimilarity } from 'string-similarity-js';

const fetch = (await import('node-fetch')).default;

const router = Router();

const BASE_URL = 'https://api.collegeplanner.io/v1/';

// Helper to fetch JSON from API
async function fetchApi(endpoint) {
  const response = await fetch(`${BASE_URL}${endpoint}`);
  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`);
  }
  return await response.json();
}

// GET /college-courses?college=University%20of%20Washington[&subject=CS][&course=101]
router.get('/', async (req, res) => {
  const collegeQuery = (req.query.college || '').toString().trim();
  const subjectQuery = (req.query.subject || '').toString().trim();
  const courseQuery = (req.query.course || '').toString().trim();

  if (!collegeQuery) {
    return res.status(400).json({ error: 'Missing required query parameter: college' });
  }

  if (courseQuery && !subjectQuery) {
    return res.status(400).json({ error: 'Subject is required when course is specified' });
  }

  try {
    // Fetch all colleges
    const allColleges = await fetchApi('colleges');

    // Compute similarities for colleges
    const collegesWithSim = allColleges.map(college => {
      const lowerText = college.full_name.toLowerCase();
      return { ...college, similarity: stringSimilarity(collegeQuery.toLowerCase(), lowerText) };
    });

    // Sort by similarity descending
    collegesWithSim.sort((a, b) => b.similarity - a.similarity);

    // If no subject and no course, return matching colleges
    if (!subjectQuery && !courseQuery) {
      const items = collegesWithSim
        .filter(c => c.similarity >= 0.5)
        .slice(0, 50)
        .map(({ abbr_name, full_name }) => ({ code: abbr_name, title: full_name }));

      return res.json({ query: collegeQuery, count: items.length, items });
    }

    // Find best college match
    const bestCollege = collegesWithSim[0];
    if (bestCollege.similarity < 0.5) {
      return res.status(400).json({ error: 'No matching college found' });
    }
    const selectedCollege = bestCollege.abbr_name;
    const collegeName = bestCollege.full_name;

    // Fetch terms for the college
    const terms = await fetchApi(`terms?college=${selectedCollege}`);

    // Sort terms by term_code descending and pick the most recent
    terms.sort((a, b) => b.term_code.localeCompare(a.term_code));
    const latestTerm = terms[0]?.term_code;
    if (!latestTerm) {
      return res.status(400).json({ error: 'No terms found for the college' });
    }

    // Fetch subjects for the latest term
    const allSubjects = await fetchApi(`subjects?college=${selectedCollege}&term=${latestTerm}`);

    // If subject provided but no course, return matching subjects
    if (subjectQuery && !courseQuery) {
      const subjectsWithSim = allSubjects.map(subject => {
        const lowerText = `${subject.subj_abbr} ${subject.subj_name}`.toLowerCase();
        return { ...subject, similarity: stringSimilarity(subjectQuery.toLowerCase(), lowerText) };
      });

      subjectsWithSim.sort((a, b) => b.similarity - a.similarity);
      const items = subjectsWithSim
        .filter(s => s.similarity >= 0.5)
        .slice(0, 50)
        .map(({ subj_abbr, subj_name }) => ({ code: subj_abbr, title: subj_name }));

      return res.json({ college: collegeName, term: latestTerm, query: subjectQuery, count: items.length, items });
    }

    // If here, subject and course provided: find matching courses
    // Find best subject match
    const subjectsWithSim = allSubjects.map(subject => {
      const lowerText = `${subject.subj_abbr} ${subject.subj_name}`.toLowerCase();
      return { ...subject, similarity: stringSimilarity(subjectQuery.toLowerCase(), lowerText) };
    });

    subjectsWithSim.sort((a, b) => b.similarity - a.similarity);
    const bestSubject = subjectsWithSim[0];
    if (bestSubject.similarity < 0.5) {
      return res.status(400).json({ error: 'No matching subject found' });
    }
    const selectedSubject = bestSubject.subj_abbr;
    const subjectName = bestSubject.subj_name;

    // Fetch courses for the subject
    const allCourses = await fetchApi(`courses?college=${selectedCollege}&term=${latestTerm}&subject=${selectedSubject}`);

    // Compute similarities for courses
    const coursesWithSim = allCourses.map(course => {
      const lowerText = `${course.course_name} ${course.course_title}`.toLowerCase();
      return { ...course, similarity: stringSimilarity(courseQuery.toLowerCase(), lowerText) };
    });

    // Sort by similarity descending and limit to 50
    coursesWithSim.sort((a, b) => b.similarity - a.similarity);
    const items = coursesWithSim
      .slice(0, 50)
      .map(({ course_name, course_title }) => ({ code: course_name, title: course_title }));

    return res.json({ college: collegeName, term: latestTerm, subject: subjectName, query: courseQuery, count: items.length, items });
  } catch (e) {
    console.error('Error fetching data:', e);
    return res.status(500).json({ error: 'Failed to fetch data' });
  }
});

export default router;