import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import collegeCoursesRouter from './routes/college-courses.js';
import coursesRouter from './routes/courses.js';
import flashcardsRouter from './routes/flashcards.js';
import courseStructureRouter from './routes/course-structure.js';
import contentRouter from './routes/content.js';
import chatRouter from './routes/chat.js';

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/', (req, res) => {
  res.json({ name: 'edtech-backend-api', ok: true });
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/college-courses', collegeCoursesRouter);
app.use('/courses', coursesRouter);
app.use('/flashcards', flashcardsRouter);
app.use('/course-structure', courseStructureRouter);
app.use('/content', contentRouter);
app.use('/chat', chatRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error: ' + err.message });
});

export default app;
