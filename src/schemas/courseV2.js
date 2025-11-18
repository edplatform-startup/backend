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
// Module/Lesson/Assessment schemas and CoursePackageSchema removed intentionally.
