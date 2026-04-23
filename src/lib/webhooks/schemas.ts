import { z } from 'zod';

// Event names mirror the POST call sites. Adding a new one requires:
//   1. extending this union
//   2. adding a matching payload schema below + to webhookPayload
//   3. wiring an emit() call at the source route
export const WEBHOOK_EVENTS = ['image.created', 'image.updated', 'comment.created', 'report.created'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const API_VERSION = '2026-04-23';

const envelope = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  apiVersion: z.literal(API_VERSION)
});

const imagePart = z.object({
  id: z.number().int(),
  slug: z.string(),
  blobUrl: z.string().url(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  takenAt: z.string().datetime().nullable(),
  uploadedAt: z.string().datetime()
});

const captionPart = z.object({
  variant: z.number().int(),
  text: z.string(),
  isSlugSource: z.boolean()
});

const tagPart = z.object({
  tag: z.string(),
  source: z.enum(['taxonomy', 'freeform']),
  confidence: z.number().nullable().optional()
});

export const imageCreatedPayload = envelope.extend({
  event: z.literal('image.created'),
  image: imagePart,
  captions: z.array(captionPart),
  tags: z.array(tagPart)
});

export const imageUpdatedPayload = envelope.extend({
  event: z.literal('image.updated'),
  image: imagePart,
  captions: z.array(captionPart),
  tags: z.array(tagPart)
});

export const commentCreatedPayload = envelope.extend({
  event: z.literal('comment.created'),
  comment: z.object({
    id: z.number().int(),
    imageSlug: z.string(),
    body: z.string(),
    status: z.enum(['pending', 'approved', 'rejected']),
    createdAt: z.string().datetime()
  })
});

export const reportCreatedPayload = envelope.extend({
  event: z.literal('report.created'),
  report: z.object({
    id: z.number().int(),
    targetType: z.enum(['image', 'comment']),
    imageSlug: z.string().nullable().optional(),
    commentId: z.number().int().nullable().optional(),
    reason: z.string().nullable(),
    createdAt: z.string().datetime()
  })
});

export const webhookPayload = z.discriminatedUnion('event', [
  imageCreatedPayload,
  imageUpdatedPayload,
  commentCreatedPayload,
  reportCreatedPayload
]);

export type WebhookPayload = z.infer<typeof webhookPayload>;
export type ImageCreatedPayload = z.infer<typeof imageCreatedPayload>;
export type ImageUpdatedPayload = z.infer<typeof imageUpdatedPayload>;
export type CommentCreatedPayload = z.infer<typeof commentCreatedPayload>;
export type ReportCreatedPayload = z.infer<typeof reportCreatedPayload>;
