import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import collegeCoursesRouter from './routes/college-courses.js';
import coursesRouter from './routes/courses.js';
import flashcardsRouter from './routes/flashcards.js';
import contentRouter from './routes/content.js';
import chatRouter from './routes/chat.js';

const app = express();

app.use(cors());
// Increase JSON and URL-encoded body limits to support inline files and rich context
app.use(express.json({ limit: process.env.REQUEST_BODY_LIMIT || '150mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.REQUEST_BODY_LIMIT || '150mb' }));
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
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    return res.status(413).json({
      error: 'Payload too large',
      details: 'The request body exceeded the allowed size. Consider sending files by URL or reducing inline content.',
      maxAllowed: process.env.REQUEST_BODY_LIMIT || '150mb',
    });
  }
  res.status(500).json({ error: 'Internal Server Error: ' + err.message });
});

export default app;
