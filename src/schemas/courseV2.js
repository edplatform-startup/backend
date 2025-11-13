import { z } from 'zod';

export const UrlSchema = z.string().url();

export const TopicNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  refs: z.array(UrlSchema).default([]),
});

export const TopicEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().min(1),
});

export const TopicGraphSchema = z.object({
  nodes: z.array(TopicNodeSchema).min(4),
  edges: z.array(TopicEdgeSchema),
});

export const SyllabusSchema = z.object({
  outcomes: z.array(z.string().min(1)).min(3),
  topic_graph: TopicGraphSchema,
  sources: z
    .array(
      z.object({
        url: UrlSchema,
        title: z.string().min(1),
      }),
    )
    .min(1),
});

export const ModuleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  outcomes: z.array(z.string().min(1)).min(1),
  hours_estimate: z.number().int().positive(),
  covers_nodes: z.array(z.string().min(1)).min(1),
});

export const ModulesSchema = z.object({
  modules: z.array(ModuleSchema).min(4),
});

const ReadingSchema = z.object({
  title: z.string().min(1),
  url: UrlSchema,
  est_min: z.number().int().positive().optional(),
});

const ActivitySchema = z.object({
  type: z.enum(['guided_example', 'problem_set', 'discussion', 'project_work']),
  goal: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1).optional(),
});

export const LessonSchema = z.object({
  id: z.string().min(1),
  moduleId: z.string().min(1),
  title: z.string().min(1),
  objectives: z.array(z.string().min(1)).min(1),
  duration_min: z.number().int().positive(),
  reading: z.array(ReadingSchema).max(3).default([]),
  activities: z.array(ActivitySchema).default([]),
  bridge_from: z.array(z.string()).default([]),
  bridge_to: z.array(z.string()).default([]),
  cross_refs: z
    .array(
      z.object({
        toLessonId: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .default([]),
});

export const LessonsSchema = z.object({
  lessons: z.array(LessonSchema).min(6),
});

const MCQSchema = z.object({
  type: z.literal('mcq'),
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(3),
  answerIndex: z.number().int().nonnegative(),
  explanation: z.string().min(1).optional(),
  anchors: z.array(z.string()).default([]),
});

const FRQSchema = z.object({
  type: z.literal('frq'),
  prompt: z.string().min(1),
  model_answer: z.string().min(1),
  rubric: z.string().min(1),
  anchors: z.array(z.string()).default([]),
});

export const AssessmentsSchema = z.object({
  weekly_quizzes: z
    .array(
      z.object({
        moduleId: z.string().min(1),
        items: z.array(z.union([MCQSchema, FRQSchema])).min(3),
      }),
    )
    .min(2),
  project: z.object({
    title: z.string().min(1),
    brief: z.string().min(1),
    milestones: z.array(z.string().min(1)).min(2),
    rubric: z.string().min(1),
  }),
  exam_blueprint: z.object({
    sections: z
      .array(
        z.object({
          title: z.string().min(1),
          weight_pct: z.number().positive(),
          outcomes: z.array(z.string().min(1)).min(1),
        }),
      )
      .min(2),
  }),
});

export const TimeEstimateSchema = z.object({
  reading: z.number().int().nonnegative(),
  video: z.number().int().nonnegative(),
  practice: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const CoursePackageSchema = z.object({
  syllabus: SyllabusSchema,
  modules: ModulesSchema,
  lessons: LessonsSchema,
  assessments: AssessmentsSchema,
  study_time_min: TimeEstimateSchema,
});
