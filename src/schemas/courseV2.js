import { z } from 'zod';

const RawConceptSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));

export const CourseUnitSchema = z.object({
  sequence_order: z.number().int().positive(),
  title: z.string().min(1),
  raw_concepts: z.array(RawConceptSchema).default([]),
  is_exam_review: z.boolean().default(false),
});

export const CourseSkeletonSchema = z.object({
  course_structure_type: z.enum(['Week-based', 'Module-based', 'Topic-based']),
  skeleton: z.array(CourseUnitSchema).min(1),
});

export const SyllabusSchema = CourseSkeletonSchema;
// Module/Lesson/Assessment schemas and CoursePackageSchema removed intentionally.

const BloomLevelSchema = z.enum(['Remember', 'Understand', 'Apply', 'Analyze', 'Evaluate']);
const YieldSchema = z.enum(['High', 'Medium', 'Low']);

export const CompetencySubtopicSchema = z.object({
  id: z.string().min(1),
  overviewId: z.string().min(1),
  title: z.string().min(1),
  bloom_level: BloomLevelSchema,
  estimated_study_time_minutes: z.number().int().positive(),
  importance_score: z.number().int().min(1).max(10),
  exam_relevance_reasoning: z.string().min(1),
  yield: YieldSchema,
});

export const OverviewTopicSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  original_skeleton_ref: z.string().min(1),
  subtopics: z.array(CompetencySubtopicSchema).min(1),
});

export const TopicMapSchema = z.object({
  overviewTopics: z.array(OverviewTopicSchema).min(1),
});
