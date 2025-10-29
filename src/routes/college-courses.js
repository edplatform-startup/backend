import { Router } from 'express';
import axios from 'axios';
import stringSimilarity from 'string-similarity';

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
    const baseUrl = 'https://api.collegeplanner.io/v1/';

    // Fetch list of supported colleges
    const { data: colleges } = await axios.get(`${baseUrl}colleges`);

    // Assume colleges is an array of {code: 'GeorgiaTech', name: 'Georgia Institute of Technology'}
    const names = colleges.map(c => c.name);
    const bestMatch = stringSimilarity.findBestMatch(college, names).bestMatch;

    if (bestMatch.rating < 0.5) {
      return res.status(400).json({ error: 'No matching college found' });
    }

    const selectedCollege = colleges.find(c => c.name === bestMatch.target);
    const collegeCode = selectedCollege.code;

    // Fetch terms for the college
    const { data: terms } = await axios.get(`${baseUrl}terms?college=${collegeCode}`);

    // Assume terms is an array of strings like '201908'
    if (terms.length === 0) {
      return res.status(404).json({ error: 'No terms found for this college' });
    }
    const latestTerm = terms.sort((a, b) => b.localeCompare(a))[0];

    // Fetch subjects for the term
    const { data: subjects } = await axios.get(`${baseUrl}subjects?college=${collegeCode}&term=${latestTerm}`);

    // Assume subjects is an array of strings like 'ACCT'
    const coursePromises = subjects.map(sub =>
      axios.get(`${baseUrl}courses?college=${collegeCode}&term=${latestTerm}&subject=${sub}`)
        .catch(() => ({ data: [] })) // Handle failed subject fetches gracefully
    );

    const responses = await Promise.all(coursePromises);

    let allCourses = [];
    responses.forEach(res => {
      allCourses = allCourses.concat(res.data.map(row => ({
        code: `${row.department} ${row.course_number}`,
        title: row.course_title
      })));
    });

    // Compute similarities
    const lowerQuery = courseQuery.toLowerCase();
    const coursesWithSim = allCourses.map(course => {
      const lowerText = `${course.code} ${course.title}`.toLowerCase();
      return { ...course, similarity: stringSimilarity.compareTwoStrings(lowerQuery, lowerText) };
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