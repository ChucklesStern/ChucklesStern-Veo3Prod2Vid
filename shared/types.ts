import { z } from "zod";

export const UploadResponseSchema = z.object({
  objectPath: z.string(),
  mediaUrl: z.string()
});

export const GenerationCreateRequestSchema = z.object({
  promptText: z.string().min(1, "Prompt text is required"),
  imagePath: z.string().optional(),
  brand_persona: z.string().optional()
});

export const GenerationCallbackSchema = z.object({
  taskId: z.string(),
  imageGenerationPath: z.string().optional(),
  videoPath: z.string().optional(),
  status: z.enum(["completed", "failed", "200"]),
  errorMessage: z.string().optional()
});

export const N8nWebhookPayloadSchema = z.object({
  taskId: z.string(),
  promptText: z.string(),
  imagePath: z.string().nullable(),
  Imageurl: z.string().nullable(),
  brandPersonaImage1Url: z.string().nullable(),
  brandPersonaImage2Url: z.string().nullable(),
  brand_persona: z.string().nullable()
});

export const GenerationStatusResponseSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  status: z.enum(["pending", "processing", "completed", "failed", "200"]),
  errorMessage: z.string().nullable(),
  createdAt: z.string()
});

export type UploadResponse = z.infer<typeof UploadResponseSchema>;
export type GenerationCreateRequest = z.infer<typeof GenerationCreateRequestSchema>;
export type GenerationCallback = z.infer<typeof GenerationCallbackSchema>;
export type N8nWebhookPayload = z.infer<typeof N8nWebhookPayloadSchema>;
export type GenerationStatusResponse = z.infer<typeof GenerationStatusResponseSchema>;
