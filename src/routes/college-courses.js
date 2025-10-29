import { Router } from 'express';
import { getSupabase } from '../supabaseClient.js';
import { stringSimilarity } from 'string-similarity-js';

const router = Router();

// GET /college-courses?college=University%20of%20Washington&course=cs50
router.get('/', async (req, res) => {
  const college = (req.query.college || '').toString().trim();
  const courseQuery = (req.query.course || '').toString().trim();

  if (!college) {
    return res.status(400).json({ error: 'Missing required query parameter: college' });
  }
  if (!courseQuery) {
    return res.status(400).json({ error: 'Missing required query parameter: course' });
  }

  try {
    // Hardcode supported colleges (expand as needed)
    const supportedColleges = [
      { code: 'UW', name: 'University of Washington' },
      // Add more colleges here with corresponding data sources
    ];

    const names = supportedColleges.map(c => c.name);

    // Find best match manually
    let bestRating = 0;
    let bestTarget = null;
    for (const name of names) {
      const sim = stringSimilarity(college, name);
      if (sim > bestRating) {
        bestRating = sim;
        bestTarget = name;
      }
    }

    if (bestRating < 0.5) {
      return res.status(400).json({ error: 'No matching college found' });
    }

    const selectedCollege = supportedColleges.find(c => c.name === bestTarget);
    const collegeCode = selectedCollege.code;

    let allCourses = [];

    if (collegeCode === 'UW') {
      // Fetch from Supabase for UW
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('uw_courses')
        .select('code,title')
        .limit(10000); // Fetch a large number to get all courses

      if (error) {
        console.error('Supabase error:', error);
        return res.status(500).json({ error: 'Failed to fetch courses' });
      }

      allCourses = (data || []).map(row => ({
        code: row.code,
        title: row.title
      }));
    } else {
      // Placeholder for other colleges
      return res.status(400).json({ error: 'College not supported yet' });
    }

    // Compute similarities
    const lowerQuery = courseQuery.toLowerCase();
    const coursesWithSim = allCourses.map(course => {
      const lowerText = `${course.code} ${course.title}`.toLowerCase();
      return { ...course, similarity: stringSimilarity(lowerQuery, lowerText) };
    });

    // Sort by similarity descending and limit to 50
    coursesWithSim.sort((a, b) => b.similarity - a.similarity);
    const items = coursesWithSim.slice(0, 50).map(({ code, title }) => ({ code, title }));

    return res.json({ college, query: courseQuery, count: items.length, items });
  } catch (e) {
    console.error('Error fetching courses:', e);
    return res.status(500).json({ error: 'Failed to fetch courses' });
  }
});

export default router;