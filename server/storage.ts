import { 
  videoGenerations, 
  users,
  type VideoGeneration, 
  type InsertVideoGeneration,
  type User,
  type InsertUser 
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, or } from "drizzle-orm";

export interface IStorage {
  createVideoGeneration(generation: InsertVideoGeneration): Promise<VideoGeneration>;
  getVideoGenerationByTaskId(taskId: string): Promise<VideoGeneration | undefined>;
  getVideoGenerationById(id: string): Promise<VideoGeneration | undefined>;
  updateVideoGeneration(taskId: string, updates: Partial<VideoGeneration>): Promise<VideoGeneration | undefined>;
  getCompletedVideoGenerations(limit?: number): Promise<VideoGeneration[]>;
  
  // User management for authentication
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: InsertUser): Promise<User>;
}

export class DatabaseStorage implements IStorage {
  async createVideoGeneration(generation: InsertVideoGeneration): Promise<VideoGeneration> {
    const [created] = await db
      .insert(videoGenerations)
      .values([generation])
      .returning();
    return created;
  }

  async getVideoGenerationByTaskId(taskId: string): Promise<VideoGeneration | undefined> {
    const [generation] = await db
      .select()
      .from(videoGenerations)
      .where(eq(videoGenerations.taskId, taskId));
    return generation || undefined;
  }

  async getVideoGenerationById(id: string): Promise<VideoGeneration | undefined> {
    const [generation] = await db
      .select()
      .from(videoGenerations)
      .where(eq(videoGenerations.id, id));
    return generation || undefined;
  }

  async updateVideoGeneration(taskId: string, updates: Partial<Omit<VideoGeneration, 'id' | 'createdAt'>>): Promise<VideoGeneration | undefined> {
    const [updated] = await db
      .update(videoGenerations)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(videoGenerations.taskId, taskId))
      .returning();
    return updated || undefined;
  }

  async getCompletedVideoGenerations(limit: number = 50): Promise<VideoGeneration[]> {
    return await db
      .select()
      .from(videoGenerations)
      .where(or(eq(videoGenerations.status, "completed"), eq(videoGenerations.status, "200")))
      .orderBy(desc(videoGenerations.createdAt))
      .limit(limit);
  }

  // User management methods for authentication
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async upsertUser(userData: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(userData)
      .onConflictDoUpdate({
        target: users.id,
        set: {
          ...userData,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
  }
}

export const storage = new DatabaseStorage();
