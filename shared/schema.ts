import { sql } from "drizzle-orm";
import { pgTable, text, uuid, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const videoGenerations = pgTable("video_generations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: text("task_id").unique().notNull(),
  promptText: text("prompt_text").notNull(),
  imageOriginalPath: text("image_original_path"),
  imagesPaths: jsonb("images_paths").$type<string[]>(),
  imageGenerationPath: text("image_generation_path"),
  videoPath: text("video_path"),
  status: text("status").notNull().default("pending").$type<"pending" | "processing" | "completed" | "failed" | "200">(),
  errorMessage: text("error_message"),
  errorDetails: jsonb("error_details"),
  errorType: text("error_type").$type<"webhook_failure" | "network_error" | "timeout" | "validation_error" | "unknown">(),
  retryCount: text("retry_count").default("0"),
  maxRetries: text("max_retries").default("3"),
  nextRetryAt: timestamp("next_retry_at"),
  webhookResponseStatus: text("webhook_response_status"),
  webhookResponseBody: text("webhook_response_body"),
  lastAttemptAt: timestamp("last_attempt_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow()
});

export const insertVideoGenerationSchema = createInsertSchema(videoGenerations, {
  status: z.enum(["pending", "processing", "completed", "failed", "200"]).optional(),
  errorType: z.enum(["webhook_failure", "network_error", "timeout", "validation_error", "unknown"]).optional(),
  retryCount: z.string().optional(),
  maxRetries: z.string().optional(),
  imagesPaths: z.array(z.string()).max(10, "Maximum 10 images allowed").optional()
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true
});

export type InsertVideoGeneration = z.infer<typeof insertVideoGenerationSchema>;
export type VideoGeneration = typeof videoGenerations.$inferSelect;

// Session storage table for authentication
export const sessions = pgTable(
  "sessions",
  {
    sid: text("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// User storage table for Replit authentication
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").unique(),
  name: text("name"),
  profileImageUrl: text("profile_image_url"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  createdAt: true,
  updatedAt: true
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
