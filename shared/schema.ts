import { sql } from "drizzle-orm";
import { pgTable, text, uuid, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const videoGenerations = pgTable("video_generations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: text("task_id").unique().notNull(),
  promptText: text("prompt_text").notNull(),
  imageOriginalPath: text("image_original_path"),
  imageGenerationPath: text("image_generation_path"),
  videoPath: text("video_path"),
  status: text("status").notNull().default("pending").$type<"pending" | "processing" | "completed" | "failed" | "200">(),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow()
});

export const insertVideoGenerationSchema = createInsertSchema(videoGenerations).omit({
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
