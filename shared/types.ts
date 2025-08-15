import { z } from "zod";

export const UploadResponseSchema = z.object({
  objectPath: z.string(),
  mediaUrl: z.string()
});

export const GenerationCreateRequestSchema = z.object({
  promptText: z.string().min(1, "Prompt text is required"),
  imagePath: z.string().optional()
});

export const GenerationCallbackSchema = z.object({
  taskId: z.string(),
  imageGenerationPath: z.string().optional(),
  videoPath: z.string().optional(),
  status: z.enum(["completed", "failed"]),
  errorMessage: z.string().optional()
});

export const N8nWebhookPayloadSchema = z.object({
  taskId: z.string(),
  promptText: z.string(),
  imagePath: z.string().nullable()
});

export type UploadResponse = z.infer<typeof UploadResponseSchema>;
export type GenerationCreateRequest = z.infer<typeof GenerationCreateRequestSchema>;
export type GenerationCallback = z.infer<typeof GenerationCallbackSchema>;
export type N8nWebhookPayload = z.infer<typeof N8nWebhookPayloadSchema>;
