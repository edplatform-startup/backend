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
