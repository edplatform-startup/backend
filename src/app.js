import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import coursesRouter from './routes/courses.js';
import chatRouter from './routes/chat.js';
import analyticsRouter from './routes/analytics.js';
import feedbackRouter from './routes/feedback.js';
import { requireAuth } from './middleware/auth.js';

const app = express();

app.use(cors());
// Increase JSON and URL-encoded body limits to support inline files and rich context
app.use(express.json({ limit: process.env.REQUEST_BODY_LIMIT || '1gb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.REQUEST_BODY_LIMIT || '1gb' }));
app.use(morgan('dev'));

// Public endpoints (no auth required)
app.get('/', (req, res) => {
  res.json({ name: 'edtech-backend-api', ok: true });
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Protected endpoints (JWT auth required)
app.use('/courses', requireAuth, coursesRouter);
app.use('/chat', requireAuth, chatRouter);
app.use('/analytics', requireAuth, analyticsRouter);
app.use('/feedback', requireAuth, feedbackRouter);

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
      maxAllowed: process.env.REQUEST_BODY_LIMIT || '1gb',
    });
  }
  res.status(500).json({ error: 'Internal Server Error: ' + err.message });
});

export default app;
