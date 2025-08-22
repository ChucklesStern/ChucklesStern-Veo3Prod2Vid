import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import { randomUUID } from "crypto";
import { ObjectStorageService, ObjectNotFoundError, objectStorageClient, parseObjectPath } from "./objectStorage";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replitAuth";
import {
  GenerationCreateRequestSchema,
  GenerationCallbackSchema,
  N8nWebhookPayloadSchema,
  UploadResponseSchema,
  RetryGenerationRequestSchema,
  RetryGenerationResponseSchema
} from "@shared/types";
import { z } from "zod";

// Webhook timeout configuration (in milliseconds)
const WEBHOOK_TIMEOUT = 30000; // 30 seconds
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 1000; // 1 second

// Helper function to calculate exponential backoff delay
function calculateRetryDelay(retryCount: number): number {
  return BASE_RETRY_DELAY * Math.pow(2, retryCount);
}

// Helper function to determine error type
function determineErrorType(error: any): "webhook_failure" | "network_error" | "timeout" | "validation_error" | "unknown" {
  if (error.name === 'AbortError' || error.message?.includes('timeout')) {
    return 'timeout';
  }
  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
    return 'network_error';
  }
  if (error instanceof z.ZodError) {
    return 'validation_error';
  }
  if (error.status >= 400 && error.status < 500) {
    return 'webhook_failure';
  }
  return 'unknown';
}

// Helper function to send webhook with timeout
async function sendWebhookWithTimeout(url: string, payload: any, timeout: number = WEBHOOK_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Enhanced webhook handler with error capture and retry logic
async function handleWebhookCall(taskId: string, webhookPayload: any): Promise<{
  success: boolean;
  shouldRetry: boolean;
  errorDetails?: any;
}> {
  const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!n8nWebhookUrl) {
    throw new Error("N8N_WEBHOOK_URL not configured");
  }

  let webhookResponse: Response;
  let responseBody: string = "";
  let errorType: "webhook_failure" | "network_error" | "timeout" | "validation_error" | "unknown" = "unknown";
  
  try {
    // Record attempt time
    await storage.updateVideoGeneration(taskId, { 
      lastAttemptAt: new Date() 
    });

    webhookResponse = await sendWebhookWithTimeout(n8nWebhookUrl, webhookPayload);
    
    // Always capture response body for analysis
    try {
      responseBody = await webhookResponse.text();
    } catch (bodyError) {
      console.warn('Failed to read response body:', bodyError);
      responseBody = "Failed to read response body";
    }

    if (!webhookResponse.ok) {
      errorType = determineErrorType({ status: webhookResponse.status });
      
      const errorDetails = {
        status: webhookResponse.status,
        statusText: webhookResponse.statusText,
        body: responseBody,
        headers: Object.fromEntries(webhookResponse.headers.entries()),
        timestamp: new Date().toISOString()
      };

      await storage.updateVideoGeneration(taskId, {
        status: "failed",
        errorMessage: `Webhook failed with status ${webhookResponse.status}: ${webhookResponse.statusText}`,
        errorDetails,
        errorType,
        webhookResponseStatus: webhookResponse.status.toString(),
        webhookResponseBody: responseBody
      });

      // Determine if we should retry based on error type and status
      const shouldRetry = errorType === "network_error" || 
                         errorType === "timeout" || 
                         (webhookResponse.status >= 500 && webhookResponse.status < 600);

      return {
        success: false,
        shouldRetry,
        errorDetails
      };
    }

    // Success case
    return {
      success: true,
      shouldRetry: false
    };

  } catch (error: any) {
    errorType = determineErrorType(error);
    
    const errorDetails = {
      message: error.message,
      type: error.name,
      code: error.code,
      stack: error.stack,
      timestamp: new Date().toISOString()
    };

    await storage.updateVideoGeneration(taskId, {
      status: "failed",
      errorMessage: `Webhook call failed: ${error.message}`,
      errorDetails,
      errorType,
      webhookResponseStatus: null,
      webhookResponseBody: responseBody || null
    });

    // Network errors and timeouts are retryable
    const shouldRetry = errorType === "network_error" || errorType === "timeout";

    return {
      success: false,
      shouldRetry,
      errorDetails
    };
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PNG, JPG, WEBP, GIF allowed.'));
    }
  }
});

export async function registerRoutes(app: Express): Promise<Server> {
  const objectStorageService = new ObjectStorageService();

  // Setup Replit authentication
  await setupAuth(app);

  // CORS middleware
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (origin.includes('localhost') || origin.includes('replit'))) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ ok: true });
  });

  // Public object serving endpoint
  app.get("/public-objects/:filePath(*)", async (req, res) => {
    const filePath = req.params.filePath;
    try {
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        return res.status(404).json({ error: "File not found" });
      }
      await objectStorageService.downloadObject(file, res);
    } catch (error) {
      console.error("Error serving public object:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // Upload endpoint - requires authentication
  app.post("/api/upload", isAuthenticated, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file provided" });
      }

      // Create filename with extension
      const fileExtension = req.file.originalname.split('.').pop() || 'jpg';
      const filename = `${randomUUID()}.${fileExtension}`;

      // Get public upload URL
      const uploadURL = await objectStorageService.getPublicUploadURL(filename);
      
      // Upload file using the presigned URL
      const uploadResponse = await fetch(uploadURL, {
        method: 'PUT',
        body: req.file.buffer,
        headers: {
          'Content-Type': req.file.mimetype
        }
      });

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed: ${uploadResponse.statusText}`);
      }

      // Create public URL path
      const publicPath = `/public-objects/uploads/${filename}`;
      const mediaUrl = publicPath;

      const response = UploadResponseSchema.parse({
        objectPath: publicPath,
        mediaUrl
      });

      res.json(response);
    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Upload failed' });
    }
  });

  // Auth routes
  app.get('/api/auth/user', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });



  // List files in object storage
  app.get("/api/storage/list/:directory?", async (req, res) => {
    try {
      const { directory = "public" } = req.params;
      const objectStorageService = new ObjectStorageService();
      
      if (directory === "public") {
        const searchPaths = objectStorageService.getPublicObjectSearchPaths();
        const files = [];
        
        for (const searchPath of searchPaths) {
          const { bucketName, objectName } = parseObjectPath(searchPath);
          const bucket = objectStorageClient.bucket(bucketName);
          
          const [bucketFiles] = await bucket.getFiles({
            prefix: objectName + "/",
            delimiter: "/"
          });
          
          files.push(...bucketFiles.map(file => ({
            name: file.name,
            size: file.metadata.size,
            updated: file.metadata.updated,
            contentType: file.metadata.contentType
          })));
        }
        
        res.json({ files, directory: "public" });
      } else {
        res.status(400).json({ error: "Only public directory listing is supported" });
      }
    } catch (error) {
      console.error("Error listing storage files:", error);
      res.status(500).json({ error: "Failed to list files" });
    }
  });

  // Media serving endpoint
  app.get("/api/media/:key", async (req, res) => {
    try {
      const key = decodeURIComponent(req.params.key);
      const objectPath = `/objects/${key}`;
      
      const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
      await objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      console.error('Media serving error:', error);
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Media not found" });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create video generation - requires authentication
  app.post("/api/generations", isAuthenticated, async (req, res) => {
    try {
      const validatedBody = GenerationCreateRequestSchema.parse(req.body);
      
      const taskId = randomUUID();
      const generation = await storage.createVideoGeneration({
        taskId,
        promptText: validatedBody.promptText,
        imageOriginalPath: validatedBody.imagePath || null,
        status: "pending" as const
      });

      // Get protocol and host for URL construction
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host;

      // Construct full public URL for the image
      let imageUrl = null;
      if (validatedBody.imagePath) {
        imageUrl = `${protocol}://${host}${validatedBody.imagePath}`;
      }

      // Get brand persona image URLs - construct dynamically using current host
      const brandPersonaImage1Path = process.env.BASE_MODEL_IMAGE_1 || "/public-objects/base model/basemodel.png";
      const brandPersonaImage2Path = process.env.BASE_MODEL_IMAGE_2 || "/public-objects/base model/basemodel2.png";
      
      const brandPersonaImage1Url = `${protocol}://${host}${brandPersonaImage1Path}`;
      const brandPersonaImage2Url = `${protocol}://${host}${brandPersonaImage2Path}`;

      const webhookPayload = N8nWebhookPayloadSchema.parse({
        taskId,
        promptText: validatedBody.promptText,
        imagePath: validatedBody.imagePath || null,
        Imageurl: imageUrl,
        brandPersonaImage1Url,
        brandPersonaImage2Url,
        brand_persona: validatedBody.brand_persona || null
      });

      // Use enhanced webhook handler
      const webhookResult = await handleWebhookCall(taskId, webhookPayload);
      
      if (!webhookResult.success) {
        if (webhookResult.shouldRetry) {
          // Set up for retry with exponential backoff
          const retryCount = 0;
          const nextRetryAt = new Date(Date.now() + calculateRetryDelay(retryCount));
          
          await storage.updateVideoGeneration(taskId, {
            retryCount: retryCount.toString(),
            maxRetries: MAX_RETRIES.toString(),
            nextRetryAt
          });
          
          throw new Error(`Webhook failed but will be retried. Next retry at: ${nextRetryAt.toISOString()}`);
        } else {
          throw new Error(`Webhook failed permanently: ${webhookResult.errorDetails?.message || 'Unknown error'}`);
        }
      }

      // Update status to processing on success
      await storage.updateVideoGeneration(taskId, { status: "processing" });

      res.json({ id: generation.id, taskId: generation.taskId });
    } catch (error) {
      console.error('Generation creation error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Generation failed' });
    }
  });

  // n8n callback endpoint
  app.post("/api/generations/callback", async (req, res) => {
    try {
      const validatedBody = GenerationCallbackSchema.parse(req.body);
      
      const updated = await storage.updateVideoGeneration(validatedBody.taskId, {
        status: validatedBody.status,
        imageGenerationPath: validatedBody.imageGenerationPath || null,
        videoPath: validatedBody.videoPath || null,
        errorMessage: validatedBody.errorMessage || null
      });

      if (!updated) {
        return res.status(404).json({ error: "Generation not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Callback error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      res.status(500).json({ error: "Callback processing failed" });
    }
  });

  // Get completed generations - requires authentication
  app.get("/api/generations", isAuthenticated, async (req, res) => {
    try {
      const onlyCompleted = req.query.onlyCompleted === 'true';
      
      if (onlyCompleted) {
        const generations = await storage.getCompletedVideoGenerations(50);
        // Only return generations with video_path
        const completedWithVideos = generations.filter(g => g.videoPath);
        res.json(completedWithVideos);
      } else {
        // For now, only support completed filter as per requirements
        res.json([]);
      }
    } catch (error) {
      console.error('Get generations error:', error);
      res.status(500).json({ error: "Failed to fetch generations" });
    }
  });

  // Get generation status by taskId - requires authentication
  app.get("/api/generations/status/:taskId", isAuthenticated, async (req, res) => {
    try {
      const generation = await storage.getVideoGenerationByTaskId(req.params.taskId);
      if (!generation) {
        return res.status(404).json({ error: "Generation not found" });
      }
      // Return all status-relevant fields including new error handling fields
      res.json({
        id: generation.id,
        taskId: generation.taskId,
        status: generation.status,
        errorMessage: generation.errorMessage,
        errorDetails: generation.errorDetails,
        errorType: generation.errorType,
        retryCount: generation.retryCount,
        maxRetries: generation.maxRetries,
        nextRetryAt: generation.nextRetryAt?.toISOString() || null,
        webhookResponseStatus: generation.webhookResponseStatus,
        webhookResponseBody: generation.webhookResponseBody,
        lastAttemptAt: generation.lastAttemptAt?.toISOString() || null,
        createdAt: generation.createdAt
      });
    } catch (error) {
      console.error('Get generation status error:', error);
      res.status(500).json({ error: "Failed to fetch generation status" });
    }
  });

  // Get single generation - requires authentication
  app.get("/api/generations/:id", isAuthenticated, async (req, res) => {
    try {
      const generation = await storage.getVideoGenerationById(req.params.id);
      if (!generation) {
        return res.status(404).json({ error: "Generation not found" });
      }
      res.json(generation);
    } catch (error) {
      console.error('Get generation error:', error);
      res.status(500).json({ error: "Failed to fetch generation" });
    }
  });

  // Manual retry endpoint - requires authentication
  app.post("/api/generations/retry", isAuthenticated, async (req, res) => {
    try {
      const validatedBody = RetryGenerationRequestSchema.parse(req.body);
      
      const generation = await storage.getVideoGenerationByTaskId(validatedBody.taskId);
      if (!generation) {
        return res.status(404).json({ error: "Generation not found" });
      }

      if (generation.status !== "failed") {
        return res.status(400).json({ error: "Only failed generations can be retried" });
      }

      const currentRetryCount = parseInt(generation.retryCount || "0");
      const maxRetries = parseInt(generation.maxRetries || "3");

      if (currentRetryCount >= maxRetries) {
        return res.status(400).json({ error: "Maximum retry attempts exceeded" });
      }

      // Reconstruct the webhook payload
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host;

      let imageUrl = null;
      if (generation.imageOriginalPath) {
        imageUrl = `${protocol}://${host}${generation.imageOriginalPath}`;
      }

      const brandPersonaImage1Path = process.env.BASE_MODEL_IMAGE_1 || "/public-objects/base model/basemodel.png";
      const brandPersonaImage2Path = process.env.BASE_MODEL_IMAGE_2 || "/public-objects/base model/basemodel2.png";
      
      const brandPersonaImage1Url = `${protocol}://${host}${brandPersonaImage1Path}`;
      const brandPersonaImage2Url = `${protocol}://${host}${brandPersonaImage2Path}`;

      const webhookPayload = N8nWebhookPayloadSchema.parse({
        taskId: generation.taskId,
        promptText: generation.promptText,
        imagePath: generation.imageOriginalPath,
        Imageurl: imageUrl,
        brandPersonaImage1Url,
        brandPersonaImage2Url,
        brand_persona: null // Brand persona is not stored, defaulting to null
      });

      // Reset status to pending for retry
      await storage.updateVideoGeneration(generation.taskId, {
        status: "pending",
        errorMessage: null,
        errorDetails: null,
        errorType: null,
        webhookResponseStatus: null,
        webhookResponseBody: null
      });

      // Attempt webhook call
      const webhookResult = await handleWebhookCall(generation.taskId, webhookPayload);
      
      if (!webhookResult.success) {
        const newRetryCount = currentRetryCount + 1;
        
        if (webhookResult.shouldRetry && newRetryCount < maxRetries) {
          // Schedule next retry
          const nextRetryAt = new Date(Date.now() + calculateRetryDelay(newRetryCount));
          
          await storage.updateVideoGeneration(generation.taskId, {
            retryCount: newRetryCount.toString(),
            nextRetryAt
          });

          const response = RetryGenerationResponseSchema.parse({
            success: false,
            message: `Retry failed. Next automatic retry scheduled for ${nextRetryAt.toISOString()}`,
            nextRetryAt: nextRetryAt.toISOString()
          });
          
          return res.json(response);
        } else {
          // No more retries
          await storage.updateVideoGeneration(generation.taskId, {
            retryCount: newRetryCount.toString(),
            nextRetryAt: null
          });

          const response = RetryGenerationResponseSchema.parse({
            success: false,
            message: "Retry failed permanently. Maximum retry attempts exceeded."
          });
          
          return res.json(response);
        }
      }

      // Success - update to processing
      await storage.updateVideoGeneration(generation.taskId, { 
        status: "processing",
        retryCount: (currentRetryCount + 1).toString()
      });

      const response = RetryGenerationResponseSchema.parse({
        success: true,
        message: "Retry successful. Generation is now processing."
      });

      res.json(response);
    } catch (error) {
      console.error('Manual retry error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Retry failed' });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
