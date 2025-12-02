-- Create the exam_grades table
CREATE TABLE IF NOT EXISTS api.exam_grades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  course_id UUID NOT NULL REFERENCES api.courses(id) ON DELETE CASCADE,
  exam_type TEXT NOT NULL CHECK (exam_type IN ('midterm', 'final')),
  exam_number INTEGER NOT NULL DEFAULT 1,
  score INTEGER NOT NULL,
  feedback TEXT,
  topic_grades JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create an index for faster lookups by course and user
CREATE INDEX IF NOT EXISTS idx_exam_grades_course_user ON api.exam_grades(course_id, user_id);
