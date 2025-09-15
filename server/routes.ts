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
import { logger } from "./lib/logger";
import { metricsCollector } from "./lib/metrics";
import { alertingSystem } from "./lib/alerting";
import { AppError, WebhookError, handleDatabaseError, handleWebhookError, asyncHandler } from "./lib/errorHandler";
import { retryManager, withRetry } from "./lib/retryManager";
import { rawBodyMiddleware, webhookSecurityMiddleware } from "./lib/webhookSecurity";

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

// Enhanced webhook handler with retry manager and error capture
async function handleWebhookCall(taskId: string, webhookPayload: any, correlationId: string): Promise<{
  success: boolean;
  errorDetails?: any;
  attempts: number;
  totalDuration: number;
}> {
  const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!n8nWebhookUrl) {
    throw new Error("N8N_WEBHOOK_URL not configured");
  }

  // Use retry manager for webhook calls
  const webhookOperation = async () => {
    logger.debug('Executing webhook call', {
      correlationId,
      taskId,
      url: n8nWebhookUrl,
      payloadSize: JSON.stringify(webhookPayload).length,
      type: 'webhook_call_attempt'
    });

    // Record attempt time
    await storage.updateVideoGeneration(taskId, { 
      lastAttemptAt: new Date() 
    });

    const webhookResponse = await sendWebhookWithTimeout(n8nWebhookUrl, webhookPayload);
    
    // Always capture response body for analysis
    let responseBody: string = "";
    try {
      responseBody = await webhookResponse.text();
    } catch (bodyError) {
      logger.warn('Failed to read webhook response body', {
        correlationId,
        taskId,
        error: bodyError,
        type: 'webhook_response_body_error'
      });
      responseBody = "Failed to read response body";
    }

    if (!webhookResponse.ok) {
      const errorType = determineErrorType({ status: webhookResponse.status });
      
      const errorDetails = {
        status: webhookResponse.status,
        statusText: webhookResponse.statusText,
        body: responseBody,
        headers: Object.fromEntries(webhookResponse.headers.entries()),
        timestamp: new Date().toISOString()
      };

      // Update database with error details
      await storage.updateVideoGeneration(taskId, {
        status: "failed",
        errorMessage: `Webhook failed with status ${webhookResponse.status}: ${webhookResponse.statusText}`,
        errorDetails,
        errorType,
        webhookResponseStatus: webhookResponse.status.toString(),
        webhookResponseBody: responseBody
      });

      // Create error for retry manager
      const error = new Error(`Webhook failed with status ${webhookResponse.status}: ${webhookResponse.statusText}`);
      (error as any).status = webhookResponse.status;
      (error as any).statusCode = webhookResponse.status;
      throw error;
    }

    // Success case - return response for logging
    return {
      status: webhookResponse.status,
      body: responseBody,
      headers: Object.fromEntries(webhookResponse.headers.entries())
    };
  };

  try {
    const result = await retryManager.retryWebhook(
      webhookOperation,
      n8nWebhookUrl,
      correlationId
    );

    if (result.success) {
      logger.info('Webhook call succeeded', {
        correlationId,
        taskId,
        attempts: result.finalAttempt,
        totalDuration: result.totalDuration,
        type: 'webhook_call_success'
      });

      return {
        success: true,
        attempts: result.finalAttempt,
        totalDuration: result.totalDuration
      };
    } else {
      const errorDetails = {
        error: result.error?.message,
        attempts: result.attempts,
        totalDuration: result.totalDuration,
        finalAttempt: result.finalAttempt,
        circuitBreakerTripped: result.circuitBreakerTripped
      };

      logger.error('Webhook call failed after all retries', {
        correlationId,
        taskId,
        ...errorDetails,
        type: 'webhook_call_failed'
      });

      return {
        success: false,
        errorDetails,
        attempts: result.finalAttempt,
        totalDuration: result.totalDuration
      };
    }

  } catch (error: any) {
    const errorDetails = {
      message: error.message,
      type: error.name,
      code: error.code,
      stack: error.stack,
      timestamp: new Date().toISOString()
    };

    logger.error('Webhook call processing error', {
      correlationId,
      taskId,
      error: error.message,
      type: 'webhook_call_error'
    });

    return {
      success: false,
      errorDetails,
      attempts: 1,
      totalDuration: 0
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

  // Enhanced health check with full system status
  app.get("/api/health", async (req, res) => {
    const { apiMonitor } = await import("./lib/monitoring");
    const { alertingSystem } = await import("./lib/alerting");
    
    const healthStatus = apiMonitor.getHealthStatus();
    const alertingStatus = alertingSystem.getStatus();
    
    res.json({
      status: healthStatus.status,
      timestamp: healthStatus.timestamp,
      uptime: healthStatus.uptime,
      version: healthStatus.version,
      environment: healthStatus.environment,
      dependencies: healthStatus.dependencies,
      metrics: {
        requests: {
          total: healthStatus.metrics.totalRequests,
          successful: healthStatus.metrics.successfulRequests,
          failed: healthStatus.metrics.failedRequests,
          averageResponseTime: Math.round(healthStatus.metrics.averageResponseTime)
        },
        alerts: {
          active: alertingStatus.activeAlerts,
          recent: alertingStatus.recentAlerts
        }
      },
      correlationId: (req as any).correlationId
    });
  });

  // Detailed metrics endpoint
  app.get("/api/monitoring/metrics", async (req, res) => {
    const { metricsCollector } = await import("./lib/metrics");
    const { apiMonitor } = await import("./lib/monitoring");
    
    const metrics = metricsCollector.getMetricsSummary();
    const apiMetrics = apiMonitor.getMetrics();
    
    res.json({
      timestamp: new Date().toISOString(),
      api: apiMetrics,
      detailed: metrics,
      correlationId: (req as any).correlationId
    });
  });

  // Alerts endpoint
  app.get("/api/monitoring/alerts", async (req, res) => {
    const { alertingSystem } = await import("./lib/alerting");
    
    const activeAlerts = alertingSystem.getActiveAlerts();
    const alertHistory = alertingSystem.getAlertHistory(100);
    const alertRules = alertingSystem.getAlertRules();
    
    res.json({
      active: activeAlerts,
      history: alertHistory,
      rules: alertRules,
      status: alertingSystem.getStatus(),
      correlationId: (req as any).correlationId
    });
  });

  // API Manager status endpoint
  app.get("/api/monitoring/api-manager", async (req, res) => {
    const { rateLimitManager } = await import("./lib/rateLimiting");
    const { validationManager } = await import("./lib/validation");
    const { idempotencyManager } = await import("./lib/idempotency");
    const { retryManager } = await import("./lib/retryManager");
    const { webhookSecurity } = await import("./lib/webhookSecurity");
    
    res.json({
      rateLimiting: rateLimitManager.getStats(),
      validation: validationManager.getStats(),
      idempotency: idempotencyManager.getStats(),
      retry: retryManager.getStats(),
      webhookSecurity: webhookSecurity.getSecurityStatus(),
      correlationId: (req as any).correlationId
    });
  });

  // Rate limiting management endpoints
  app.get("/api/monitoring/rate-limits", async (req, res) => {
    const { rateLimitManager } = await import("./lib/rateLimiting");
    
    res.json({
      rules: rateLimitManager.getRules(),
      stats: rateLimitManager.getStats(),
      correlationId: (req as any).correlationId
    });
  });

  app.post("/api/monitoring/rate-limits/reset/:clientId", async (req, res) => {
    const { rateLimitManager } = await import("./lib/rateLimiting");
    const { clientId } = req.params;
    
    const reset = rateLimitManager.resetClient(clientId);
    
    res.json({
      success: reset,
      message: reset ? `Rate limits reset for client ${clientId}` : `Client ${clientId} not found`,
      correlationId: (req as any).correlationId
    });
  });

  // Circuit breaker management
  app.post("/api/monitoring/circuit-breaker/reset/:operationId", async (req, res) => {
    const { retryManager } = await import("./lib/retryManager");
    const { operationId } = req.params;
    
    const reset = retryManager.resetCircuitBreaker(operationId);
    
    res.json({
      success: reset,
      message: reset ? `Circuit breaker reset for ${operationId}` : `Operation ${operationId} not found`,
      correlationId: (req as any).correlationId
    });
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

      // Get brand persona image URLs - use production URLs if available, otherwise construct from paths
      const brandPersonaImage1Url = process.env.BASE_MODEL_IMAGE_1_URL || 
        `${protocol}://${host}${encodeURI(process.env.BASE_MODEL_IMAGE_1 || "/public-objects/base model/basemodel.png")}`;
      const brandPersonaImage2Url = process.env.BASE_MODEL_IMAGE_2_URL || 
        `${protocol}://${host}${encodeURI(process.env.BASE_MODEL_IMAGE_2 || "/public-objects/base model/basemodel2.png")}`;

      const webhookPayload = N8nWebhookPayloadSchema.parse({
        taskId,
        promptText: validatedBody.promptText,
        imagePath: validatedBody.imagePath || null,
        Imageurl: imageUrl,
        brandPersonaImage1Url,
        brandPersonaImage2Url,
        brand_persona: validatedBody.brand_persona || null
      });

      // Use enhanced webhook handler with retry manager
      const webhookResult = await handleWebhookCall(taskId, webhookPayload, (req as any).correlationId);
      
      if (!webhookResult.success) {
        logger.error('Webhook call failed', {
          correlationId: (req as any).correlationId,
          taskId,
          attempts: webhookResult.attempts,
          totalDuration: webhookResult.totalDuration,
          errorDetails: webhookResult.errorDetails,
          type: 'generation_webhook_failed'
        });

        throw new AppError(
          `Webhook failed after ${webhookResult.attempts} attempts`,
          500,
          'WEBHOOK_CALL_FAILED',
          webhookResult.errorDetails,
          (req as any).correlationId
        );
      }

      logger.info('Webhook call completed successfully', {
        correlationId: (req as any).correlationId,
        taskId,
        attempts: webhookResult.attempts,
        totalDuration: webhookResult.totalDuration,
        type: 'generation_webhook_success'
      });

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

  // Enhanced n8n callback endpoint with security and observability
  app.post("/api/generations/callback", 
    rawBodyMiddleware,
    webhookSecurityMiddleware,
    asyncHandler(async (req: any, res) => {
    const timer = metricsCollector.startTimer(`webhook_callback_${req.correlationId}`);
    
    logger.info('Webhook callback received', {
      correlationId: req.correlationId,
      bodySize: JSON.stringify(req.body).length,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      type: 'webhook_callback_start'
    });

    try {
      const validatedBody = GenerationCallbackSchema.parse(req.body);
      
      logger.info('Webhook callback validated', {
        correlationId: req.correlationId,
        taskId: validatedBody.taskId,
        status: validatedBody.status,
        hasImage: !!validatedBody.imageGenerationPath,
        hasVideo: !!validatedBody.videoPath,
        hasError: !!validatedBody.errorMessage,
        type: 'webhook_callback_validated'
      });

      const dbTimer = metricsCollector.startTimer(`db_update_${req.correlationId}`);
      const updated = await storage.updateVideoGeneration(validatedBody.taskId, {
        status: validatedBody.status,
        imageGenerationPath: validatedBody.imageGenerationPath || null,
        videoPath: validatedBody.videoPath || null,
        errorMessage: validatedBody.errorMessage || null
      });
      const dbDuration = dbTimer();

      metricsCollector.recordDatabaseQuery(
        'updateVideoGeneration', 
        dbDuration, 
        !!updated, 
        req.correlationId
      );

      if (!updated) {
        logger.warn('Generation not found for callback', {
          correlationId: req.correlationId,
          taskId: validatedBody.taskId,
          type: 'webhook_callback_not_found'
        });
        throw new AppError(`Generation not found: ${validatedBody.taskId}`, 404, 'GENERATION_NOT_FOUND', {
          taskId: validatedBody.taskId
        }, req.correlationId);
      }

      const duration = timer();
      
      logger.info('Webhook callback processed successfully', {
        correlationId: req.correlationId,
        taskId: validatedBody.taskId,
        status: validatedBody.status,
        duration,
        dbDuration,
        type: 'webhook_callback_success'
      });

      // Record webhook success metrics
      metricsCollector.recordWebhookCall('callback', duration, 200, false, req.correlationId);

      res.json({ 
        success: true, 
        correlationId: req.correlationId,
        processedAt: new Date().toISOString()
      });

    } catch (error) {
      const duration = timer();
      
      if (error instanceof AppError) {
        throw error; // Re-throw app errors for proper handling
      }

      logger.error('Webhook callback processing error', {
        correlationId: req.correlationId,
        error: error instanceof Error ? error.message : String(error),
        duration,
        type: 'webhook_callback_error'
      });

      // Record webhook failure metrics
      metricsCollector.recordWebhookCall('callback', duration, 500, false, req.correlationId);
      alertingSystem.recordError('/api/generations/callback');

      throw new AppError(
        'Callback processing failed',
        500,
        'CALLBACK_PROCESSING_ERROR',
        { originalError: error instanceof Error ? error.message : String(error) },
        req.correlationId
      );
    }
  }));

  // Get completed generations - requires authentication
  app.get("/api/generations", isAuthenticated, async (req, res) => {
    try {
      const onlyCompleted = req.query.onlyCompleted === 'true';
      
      if (onlyCompleted) {
        const generations = await storage.getCompletedVideoGenerations(50);
        // Only return generations with video_path AND no error message (double safety check)
        const completedWithVideos = generations.filter(g => 
          g.videoPath && 
          !g.errorMessage
        );
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
      const webhookResult = await handleWebhookCall(generation.taskId, webhookPayload, (req as any).correlationId);
      
      if (!webhookResult.success) {
        const newRetryCount = currentRetryCount + 1;
        
        if (!webhookResult.success && newRetryCount < maxRetries) {
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
