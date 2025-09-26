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
import { AppError, WebhookError, N8nWebhookError, NetworkError, TimeoutError, WebhookConfigurationError, handleDatabaseError, handleWebhookError, handleNetworkError, handleConfigurationError, classifyWebhookError, isWebhookErrorRetryable, asyncHandler } from "./lib/errorHandler";
import { retryManager, withRetry } from "./lib/retryManager";
import { rawBodyMiddleware, webhookSecurityMiddleware } from "./lib/webhookSecurity";

// Webhook timeout configuration (in milliseconds)
const WEBHOOK_TIMEOUT = 60000; // 60 seconds - increased for n8n processing
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 1000; // 1 second

// Helper function to calculate exponential backoff delay
function calculateRetryDelay(retryCount: number): number {
  return BASE_RETRY_DELAY * Math.pow(2, retryCount);
}

// Helper function to validate webhook configuration and connectivity
async function validateWebhookConfiguration(webhookUrl: string, correlationId: string): Promise<void> {
  // Validate URL format
  try {
    const url = new URL(webhookUrl);
    logger.info('Webhook URL validation passed', {
      correlationId,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      type: 'webhook_config_validation'
    });
  } catch (error) {
    handleConfigurationError('N8N_WEBHOOK_URL', 'Invalid URL format', correlationId);
  }

  // Test basic connectivity (POST request with test payload for N8N compatibility)
  try {
    logger.info('Testing webhook endpoint connectivity', {
      correlationId,
      webhookUrl,
      type: 'webhook_connectivity_test'
    });

    // Use minimal test payload for N8N webhook
    const testPayload = JSON.stringify({ test: 'connectivity_check' });
    const connectivityTest = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Fabbitt-VideoGen/1.0-ConnectivityTest'
      },
      body: testPayload,
      signal: AbortSignal.timeout(5000) // 5 second timeout for connectivity test
    });

    logger.info('Webhook connectivity test completed', {
      correlationId,
      webhookUrl,
      status: connectivityTest.status,
      reachable: connectivityTest.ok,
      type: 'webhook_connectivity_result'
    });
  } catch (error: any) {
    logger.warn('Webhook connectivity test failed', {
      correlationId,
      webhookUrl,
      error: error.message,
      errorName: error.name,
      reachable: false,
      type: 'webhook_connectivity_result'
    });
    // Don't throw here - this is just a warning, the actual call might still work
  }
}

// Enhanced error classification with more granular detection
function determineErrorType(error: any): "webhook_failure" | "network_error" | "timeout" | "validation_error" | "configuration_error" | "unknown" {
  // Configuration errors
  if (error instanceof WebhookConfigurationError) {
    return 'configuration_error';
  }

  // Timeout errors (AbortError from fetch timeout)
  if (error.name === 'AbortError' || error.message?.includes('timeout') || error.message?.includes('aborted')) {
    return 'timeout';
  }

  // Network connectivity errors
  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT' || error.message?.includes('ENOTFOUND') ||
      error.message?.includes('Failed to fetch') || error.message?.includes('network')) {
    return 'network_error';
  }

  // Validation errors
  if (error instanceof z.ZodError) {
    return 'validation_error';
  }

  // HTTP status-based classification using our enhanced classifier
  if (error.status || error.statusCode) {
    const statusCode = error.status || error.statusCode;
    const classified = classifyWebhookError(statusCode);

    switch (classified) {
      case 'timeout': return 'timeout';
      case 'network_unreachable': return 'network_error';
      case 'rate_limited': return 'network_error';
      case 'server_error': return 'network_error';
      case 'authentication_failed':
      case 'endpoint_not_found':
      case 'client_error':
        return 'webhook_failure';
      default: return 'webhook_failure';
    }
  }

  return 'unknown';
}

// Helper function to generate webhook health recommendations
function generateWebhookHealthRecommendations(
  successRate: number,
  errorPatterns: Record<string, any>,
  endpointStatus: string
): string[] {
  const recommendations = [];

  if (successRate < 50) {
    recommendations.push('🚨 Critical: Webhook success rate is below 50%. Immediate investigation required.');
  } else if (successRate < 80) {
    recommendations.push('⚠️ Warning: Webhook success rate is below 80%. Review error patterns.');
  }

  if (endpointStatus === 'unreachable') {
    recommendations.push('🔗 Network: Webhook endpoint is unreachable. Check N8N service status and network connectivity.');
  } else if (endpointStatus === 'error') {
    recommendations.push('🔧 Endpoint: Webhook endpoint is responding with errors. Check N8N workflow configuration.');
  }

  // Analyze error patterns for specific recommendations
  const topErrorTypes = Object.entries(errorPatterns)
    .sort(([,a], [,b]) => (b as any).count - (a as any).count)
    .slice(0, 3);

  for (const [errorType, errorData] of topErrorTypes) {
    const data = errorData as any;
    const percentage = Math.round((data.count / Object.values(errorPatterns).reduce((sum: number, p: any) => sum + p.count, 0)) * 100);

    if (errorType === 'timeout' && percentage > 20) {
      recommendations.push(`⏱️ Timeout: ${percentage}% of failures are timeouts. Consider increasing webhook timeout or optimizing N8N workflow performance.`);
    } else if (errorType === 'network_error' && percentage > 20) {
      recommendations.push(`🌐 Network: ${percentage}% of failures are network errors. Check connectivity between your service and N8N.`);
    } else if (errorType === 'webhook_failure' && percentage > 20) {
      recommendations.push(`📨 Webhook: ${percentage}% of failures are webhook-related. Review N8N workflow logic and payload handling.`);
    }
  }

  if (recommendations.length === 0) {
    recommendations.push('✅ System appears healthy. Continue monitoring for any emerging patterns.');
  }

  return recommendations;
}

// Helper function to sanitize payload for logging (remove sensitive data)
function sanitizePayloadForLogging(payload: any): any {
  if (!payload || typeof payload !== 'object') return payload;

  const sanitized = { ...payload };

  // List of keys that might contain sensitive data
  const sensitiveKeys = ['token', 'password', 'key', 'secret', 'auth', 'authorization'];

  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(sensitiveKey => key.toLowerCase().includes(sensitiveKey))) {
      sanitized[key] = '[REDACTED]';
    }
  }

  return sanitized;
}

// Helper function to send webhook with timeout
async function sendWebhookWithTimeout(url: string, payload: any, timeout: number = WEBHOOK_TIMEOUT, correlationId?: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const startTime = Date.now();

  const requestHeaders = {
    'Content-Type': 'application/json',
    'User-Agent': 'Fabbitt-VideoGen/1.0-ConnectivityTest'
  };
  const requestBody = JSON.stringify(payload);
  const sanitizedPayload = sanitizePayloadForLogging(payload);

  // Enhanced structured logging for N8N POST request
  logger.info('N8N webhook request initiated', {
    correlationId,
    webhookUrl: url,
    method: 'POST',
    headers: requestHeaders,
    payloadSize: requestBody.length,
    payload: sanitizedPayload,
    timeout,
    type: 'n8n_webhook_request_start'
  });

  // Verbose console logging for production debugging (temporary)
  console.log('=== N8N WEBHOOK POST REQUEST ===');
  console.log('Correlation ID:', correlationId);
  console.log('URL:', url);

  // Production debugging console logs for webhook URL verification
  console.log('=== WEBHOOK URL VERIFICATION ===');
  console.log('ACTUAL URL BEING CALLED (webhook):', url);
  console.log('🧪 Test URL (from env):', process.env.N8N_WEBHOOK_URL);
  console.log('🔗 URLs match:', url === process.env.N8N_WEBHOOK_URL);
  console.log('=== PAYLOAD COMPARISON ===');
  console.log('📦 Test payload structure: { test: "connectivity_check" }');
  console.log('📦 Current payload keys:', Object.keys(payload));
  console.log('📏 Current payload size:', JSON.stringify(payload).length, 'bytes');
  console.log('📏 Test payload size: ~32 bytes');
  console.log('============================');
  console.log('Method: POST');
  console.log('Headers:', JSON.stringify(requestHeaders, null, 2));
  console.log('Request Body Size:', requestBody.length, 'bytes');
  console.log('Request Body (FULL PAYLOAD):', JSON.stringify(payload, null, 2));
  console.log('Request Body (sanitized):', JSON.stringify(sanitizedPayload, null, 2));
  console.log('Timeout:', timeout, 'ms');
  console.log('Timestamp:', new Date().toISOString());
  console.log('=====================================');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal
    });

    const duration = Date.now() - startTime;

    // Clone response to read body without consuming it
    const responseClone = response.clone();
    let responseText = '';
    try {
      responseText = await responseClone.text();
    } catch (bodyError) {
      responseText = '[Could not read response body]';
      logger.warn('Failed to read webhook response body', {
        correlationId,
        error: bodyError instanceof Error ? bodyError.message : String(bodyError),
        type: 'webhook_response_body_read_error'
      });
    }

    const responseHeaders = Object.fromEntries(response.headers.entries());

    // Enhanced structured logging for N8N POST response
    logger.info('N8N webhook response received', {
      correlationId,
      webhookUrl: url,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: responseHeaders,
      bodySize: responseText.length,
      duration,
      type: 'n8n_webhook_response_success'
    });

    // Verbose console logging for production debugging
    console.log('=== N8N WEBHOOK POST RESPONSE ===');
    console.log('Correlation ID:', correlationId);
    console.log('Status:', response.status);
    console.log('Status Text:', response.statusText);
    console.log('Response OK:', response.ok);
    console.log('Duration:', duration, 'ms');
    console.log('Response Headers:', JSON.stringify(responseHeaders, null, 2));
    console.log('Response Body Size:', responseText.length, 'bytes');
    console.log('Response Body:', responseText);
    console.log('Timestamp:', new Date().toISOString());
    console.log('====================================');

    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;

    const errorType = determineErrorType(error);
    const retryable = isWebhookErrorRetryable((error as any)?.status || 0);

    // Enhanced structured logging for N8N POST error
    logger.error('N8N webhook request failed', {
      correlationId,
      webhookUrl: url,
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown',
      errorType,
      retryable,
      duration,
      timeout,
      type: 'n8n_webhook_request_error'
    });

    // Verbose console logging for production debugging
    console.log('=== N8N WEBHOOK POST ERROR ===');
    console.log('Correlation ID:', correlationId);
    console.log('URL:', url);
    console.log('Duration before error:', duration, 'ms');
    console.log('Error Type:', errorType);
    console.log('Retryable:', retryable);
    console.log('Error Details:');
    if (error instanceof Error) {
      console.log('  Name:', error.name);
      console.log('  Message:', error.message);
      console.log('  Stack:', error.stack);
      console.log('  Code:', (error as any).code);
      console.log('  Status:', (error as any).status);
    } else {
      console.log('  Error (non-Error object):', String(error));
    }
    console.log('Timestamp:', new Date().toISOString());
    console.log('===============================');

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
    handleConfigurationError('N8N_WEBHOOK_URL', 'Environment variable not set', correlationId);
  }

  // Validate webhook configuration and test connectivity
  await validateWebhookConfiguration(n8nWebhookUrl, correlationId);

  logger.info('Starting webhook call process', {
    correlationId,
    taskId,
    webhookUrl: n8nWebhookUrl,
    payloadSize: JSON.stringify(webhookPayload).length,
    type: 'webhook_call_start'
  });

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

    const webhookResponse = await sendWebhookWithTimeout(n8nWebhookUrl, webhookPayload, WEBHOOK_TIMEOUT, correlationId);
    
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

  // Webhook connectivity test endpoint
  app.get("/api/test-webhook-connectivity", async (req, res) => {
    const correlationId = (req as any).correlationId;
    const webhookUrl = process.env.N8N_WEBHOOK_URL;

    if (!webhookUrl) {
      logger.error('N8N_WEBHOOK_URL not configured', {
        correlationId,
        type: 'webhook_connectivity_test_error'
      });

      return res.status(500).json({
        success: false,
        error: 'N8N_WEBHOOK_URL not configured',
        correlationId
      });
    }

    const startTime = Date.now();

    try {
      logger.info('Webhook connectivity test initiated', {
        correlationId,
        webhookUrl,
        type: 'webhook_connectivity_test_start'
      });

      const testResponse = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ hello: 'world' }),
        signal: AbortSignal.timeout(5000)
      });

      const duration = Date.now() - startTime;
      let responseBody;

      try {
        responseBody = await testResponse.json();
      } catch {
        responseBody = await testResponse.text();
      }

      logger.info('Webhook connectivity test completed', {
        correlationId,
        status: testResponse.status,
        ok: testResponse.ok,
        duration,
        type: 'webhook_connectivity_test_success'
      });

      res.json({
        success: testResponse.ok,
        webhookResponse: {
          status: testResponse.status,
          statusText: testResponse.statusText,
          body: responseBody,
          duration
        },
        timestamp: new Date().toISOString(),
        correlationId
      });

    } catch (error: any) {
      const duration = Date.now() - startTime;

      logger.error('Webhook connectivity test failed', {
        correlationId,
        error: error.message,
        errorName: error.name,
        duration,
        type: 'webhook_connectivity_test_error'
      });

      res.status(500).json({
        success: false,
        error: error.message,
        errorName: error.name,
        duration,
        timestamp: new Date().toISOString(),
        correlationId
      });
    }
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

  // Enhanced webhook failure analysis endpoint
  app.get("/api/monitoring/webhook-failures", async (req, res) => {
    try {
      const {
        limit = '50',
        since,
        errorType,
        correlationId: searchCorrelationId,
        taskId
      } = req.query;

      const limitNum = Math.min(parseInt(limit as string), 500); // Max 500 results
      const sinceDate = since ? new Date(since as string) : new Date(Date.now() - 24 * 60 * 60 * 1000); // Default: last 24 hours

      // Get failed video generations with webhook errors
      const failedGenerations = await storage.getFailedVideoGenerations(limitNum, sinceDate);

      // Filter by additional criteria if provided
      let filteredGenerations = failedGenerations;

      if (errorType) {
        filteredGenerations = filteredGenerations.filter(g => g.errorType === errorType);
      }

      if (searchCorrelationId) {
        filteredGenerations = filteredGenerations.filter(g =>
          g.taskId === searchCorrelationId
        );
      }

      if (taskId) {
        filteredGenerations = filteredGenerations.filter(g => g.taskId === taskId);
      }

      // Aggregate error statistics
      const errorStats = filteredGenerations.reduce((stats, gen) => {
        const type = gen.errorType || 'unknown';
        stats[type] = (stats[type] || 0) + 1;
        return stats;
      }, {} as Record<string, number>);

      const statusStats = filteredGenerations.reduce((stats, gen) => {
        const status = gen.webhookResponseStatus || 'no_response';
        stats[status] = (stats[status] || 0) + 1;
        return stats;
      }, {} as Record<string, number>);

      res.json({
        failures: filteredGenerations.map(gen => ({
          id: gen.id,
          taskId: gen.taskId,
          status: gen.status,
          errorMessage: gen.errorMessage,
          errorType: gen.errorType,
          errorDetails: gen.errorDetails,
          webhookResponseStatus: gen.webhookResponseStatus,
          webhookResponseBody: gen.webhookResponseBody,
          retryCount: gen.retryCount,
          lastAttemptAt: gen.lastAttemptAt,
          createdAt: gen.createdAt
        })),
        statistics: {
          total: filteredGenerations.length,
          errorTypes: errorStats,
          responseStatuses: statusStats,
          timeRange: {
            since: sinceDate.toISOString(),
            until: new Date().toISOString()
          }
        },
        correlationId: (req as any).correlationId
      });
    } catch (error) {
      console.error('Webhook failures analysis error:', error);
      res.status(500).json({ error: "Failed to analyze webhook failures" });
    }
  });

  // Webhook request tracing endpoint
  app.get("/api/monitoring/webhook-trace/:correlationId", async (req, res) => {
    try {
      const { correlationId: traceId } = req.params;

      // Get generation by task ID
      const generation = await storage.getVideoGenerationByTaskId(traceId);

      if (!generation) {
        return res.status(404).json({
          error: "No generation found for correlation ID",
          correlationId: (req as any).correlationId
        });
      }

      // Compile trace information
      const trace = {
        generation: {
          id: generation.id,
          taskId: generation.taskId,
          status: generation.status,
          createdAt: generation.createdAt,
          lastAttemptAt: generation.lastAttemptAt,
          promptText: generation.promptText,
          imageOriginalPath: generation.imageOriginalPath
        },
        webhook: {
          errorMessage: generation.errorMessage,
          errorType: generation.errorType,
          errorDetails: generation.errorDetails,
          webhookResponseStatus: generation.webhookResponseStatus,
          webhookResponseBody: generation.webhookResponseBody,
          retryCount: generation.retryCount,
          maxRetries: generation.maxRetries,
          nextRetryAt: generation.nextRetryAt
        },
        analysis: {
          isRetryable: generation.errorType ?
            isWebhookErrorRetryable(parseInt(generation.webhookResponseStatus || '0')) :
            null,
          errorClassification: generation.webhookResponseStatus ?
            classifyWebhookError(parseInt(generation.webhookResponseStatus)) :
            null,
          suggestedActions: [] as string[]
        }
      };

      // Add suggested actions based on error analysis
      if (generation.errorType === 'timeout') {
        trace.analysis.suggestedActions.push('Consider increasing webhook timeout');
        trace.analysis.suggestedActions.push('Check n8n workflow performance');
      } else if (generation.errorType === 'network_error') {
        trace.analysis.suggestedActions.push('Verify n8n endpoint accessibility');
        trace.analysis.suggestedActions.push('Check network connectivity');
      } else if (generation.webhookResponseStatus === '404') {
        trace.analysis.suggestedActions.push('Verify N8N_WEBHOOK_URL configuration');
        trace.analysis.suggestedActions.push('Check n8n workflow webhook endpoint');
      } else if (generation.webhookResponseStatus === '401' || generation.webhookResponseStatus === '403') {
        trace.analysis.suggestedActions.push('Check webhook authentication configuration');
      }

      res.json({
        trace,
        correlationId: (req as any).correlationId
      });
    } catch (error) {
      console.error('Webhook trace error:', error);
      res.status(500).json({ error: "Failed to trace webhook request" });
    }
  });

  // Real-time webhook health monitoring dashboard
  app.get("/api/monitoring/webhook-health", async (req, res) => {
    try {
      const {
        period = '1h' // 1h, 6h, 24h, 7d
      } = req.query;

      const periodMs = {
        '1h': 60 * 60 * 1000,
        '6h': 6 * 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000
      }[period as string] || 60 * 60 * 1000;

      const since = new Date(Date.now() - periodMs);

      // Get recent webhook attempts (both successful and failed)
      const recentGenerations = await storage.getVideoGenerations(100, since);
      const failedGenerations = await storage.getFailedVideoGenerations(100, since);

      // Calculate webhook health metrics
      const totalAttempts = recentGenerations.length;
      const successfulAttempts = recentGenerations.filter(g =>
        g.status === 'completed' || g.status === 'processing'
      ).length;
      const failedAttempts = failedGenerations.length;

      const successRate = totalAttempts > 0 ? (successfulAttempts / totalAttempts) * 100 : 0;

      // Analyze error patterns
      const errorPatterns = failedGenerations.reduce((patterns, gen) => {
        const errorType = gen.errorType || 'unknown';
        const statusCode = gen.webhookResponseStatus || 'no_response';

        if (!patterns[errorType]) {
          patterns[errorType] = { count: 0, statuses: {}, recent: [] };
        }

        patterns[errorType].count++;
        patterns[errorType].statuses[statusCode] = (patterns[errorType].statuses[statusCode] || 0) + 1;

        if (patterns[errorType].recent.length < 3) {
          patterns[errorType].recent.push({
            taskId: gen.taskId,
            errorMessage: gen.errorMessage,
            timestamp: gen.lastAttemptAt || gen.createdAt
          });
        }

        return patterns;
      }, {} as Record<string, any>);

      // Get current webhook endpoint status
      let endpointStatus = 'unknown';
      let endpointResponseTime = null;

      if (process.env.N8N_WEBHOOK_URL) {
        try {
          const startTime = Date.now();
          const testResponse = await fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Fabbitt-VideoGen/1.0-HealthCheck'
            },
            body: JSON.stringify({ test: 'health_check' }),
            signal: AbortSignal.timeout(5000)
          });
          endpointResponseTime = Date.now() - startTime;
          endpointStatus = testResponse.ok ? 'healthy' : 'error';
        } catch (error) {
          endpointStatus = 'unreachable';
        }
      }

      // Calculate performance metrics
      const averageRetries = failedGenerations.reduce((sum, gen) =>
        sum + parseInt(gen.retryCount || '0'), 0
      ) / Math.max(failedGenerations.length, 1);

      res.json({
        period,
        timestamp: new Date().toISOString(),
        webhook: {
          endpoint: process.env.N8N_WEBHOOK_URL ? 'configured' : 'missing',
          status: endpointStatus,
          responseTime: endpointResponseTime
        },
        metrics: {
          totalRequests: totalAttempts,
          successfulRequests: successfulAttempts,
          failedRequests: failedAttempts,
          successRate: Math.round(successRate * 100) / 100,
          averageRetries: Math.round(averageRetries * 100) / 100
        },
        errorAnalysis: {
          patterns: errorPatterns,
          topErrors: Object.entries(errorPatterns)
            .sort(([,a], [,b]) => (b as any).count - (a as any).count)
            .slice(0, 5)
        },
        recommendations: generateWebhookHealthRecommendations(successRate, errorPatterns, endpointStatus),
        correlationId: (req as any).correlationId
      });
    } catch (error) {
      console.error('Webhook health monitoring error:', error);
      res.status(500).json({ error: "Failed to retrieve webhook health data" });
    }
  });

  // Live webhook activity feed
  app.get("/api/monitoring/webhook-activity", async (req, res) => {
    try {
      const {
        limit = '20',
        includeSuccessful = 'false'
      } = req.query;

      const limitNum = Math.min(parseInt(limit as string), 100);
      const includeSuccess = includeSuccessful === 'true';

      // Get recent webhook activities
      const activities = [];

      if (includeSuccess) {
        const recentGenerations = await storage.getVideoGenerations(limitNum, undefined);
        activities.push(...recentGenerations.map(gen => ({
          type: 'webhook_call',
          taskId: gen.taskId,
          status: gen.status,
          timestamp: gen.lastAttemptAt || gen.createdAt,
          success: gen.status === 'completed' || gen.status === 'processing',
          errorType: gen.errorType,
          errorMessage: gen.errorMessage,
          webhookStatus: gen.webhookResponseStatus
        })));
      }

      const failedGenerations = await storage.getFailedVideoGenerations(limitNum);
      activities.push(...failedGenerations.map(gen => ({
        type: 'webhook_failure',
        taskId: gen.taskId,
        status: gen.status,
        timestamp: gen.lastAttemptAt || gen.createdAt,
        success: false,
        errorType: gen.errorType,
        errorMessage: gen.errorMessage,
        webhookStatus: gen.webhookResponseStatus,
        retryCount: gen.retryCount
      })));

      // Sort by timestamp (most recent first)
      activities.sort((a, b) => {
        const timestampA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const timestampB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return timestampB - timestampA;
      });

      res.json({
        activities: activities.slice(0, limitNum),
        correlationId: (req as any).correlationId
      });
    } catch (error) {
      console.error('Webhook activity feed error:', error);
      res.status(500).json({ error: "Failed to retrieve webhook activity" });
    }
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

  // Create video generation - public endpoint
  app.post("/api/generations", async (req, res) => {
    try {
      // Enhanced logging for debugging validation issues
      if (req.body.imagePaths) {
        logger.debug('Request imagePaths validation', {
          correlationId: (req as any).correlationId,
          imagePaths: req.body.imagePaths,
          imagePathsType: typeof req.body.imagePaths,
          imagePathsIsArray: Array.isArray(req.body.imagePaths),
          imagePathsLength: Array.isArray(req.body.imagePaths) ? req.body.imagePaths.length : 'N/A',
          imagePathsItems: Array.isArray(req.body.imagePaths) ? 
            req.body.imagePaths.map((item: any, index: number) => ({
              index,
              value: item,
              type: typeof item
            })) : 'N/A',
          type: 'request_validation_debug'
        });
      }

      // Preprocess request body to filter out null values from imagePaths if present
      const requestBody = { ...req.body };
      if (requestBody.imagePaths && Array.isArray(requestBody.imagePaths)) {
        const originalLength = requestBody.imagePaths.length;
        const originalPaths = [...requestBody.imagePaths];

        requestBody.imagePaths = requestBody.imagePaths.filter(
          (path: any) => path !== null && path !== undefined && typeof path === 'string' && path.trim() !== ''
        );

        // Log if filtering occurred
        if (requestBody.imagePaths.length !== originalLength) {
          logger.warn('Filtered null/invalid values from imagePaths', {
            correlationId: (req as any).correlationId,
            originalPaths,
            originalLength,
            filteredPaths: requestBody.imagePaths,
            filteredLength: requestBody.imagePaths.length,
            type: 'imagepaths_filtering'
          });
        }

        // If no valid paths remain, remove the imagePaths field entirely
        if (requestBody.imagePaths.length === 0) {
          delete requestBody.imagePaths;
        }
      }

      const validatedBody = GenerationCreateRequestSchema.parse(requestBody);

      const taskId = randomUUID();
      const generation = await storage.createVideoGeneration({
        taskId,
        promptText: validatedBody.promptText,
        imageOriginalPath: validatedBody.imagePath || null,
        imagesPaths: validatedBody.imagePaths || undefined,
        status: "pending" as const
      });

      // Get protocol and host for URL construction
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host;

      // Construct full public URLs for multiple images
      const imageUrls = validatedBody.imagePaths?.map(path =>
        `${protocol}://${host}${path}`
      ) || [];

      // Get brand persona image URLs - use production URLs if available, otherwise construct from paths
      const brandPersonaImage1Url = process.env.BASE_MODEL_IMAGE_1_URL ||
        `${protocol}://${host}${(process.env.BASE_MODEL_IMAGE_1 || "/public-objects/base model/basemodel.png").replace(/ /g, '%20')}`;
      const brandPersonaImage2Url = process.env.BASE_MODEL_IMAGE_2_URL ||
        `${protocol}://${host}${(process.env.BASE_MODEL_IMAGE_2 || "/public-objects/base model/basemodel2.png").replace(/ /g, '%20')}`;

      // TEMPORARY: Test with minimal payload to match working connectivity test
      const useMinimalPayload = false; // Set to false to use full payload

      const webhookPayload = useMinimalPayload
        ? { test: 'generation_connectivity_check', taskId } // Minimal payload like test
        : N8nWebhookPayloadSchema.parse({
            taskId,
            promptText: validatedBody.promptText,
            imagePath: validatedBody.imagePath || null,
            image_urls: imageUrls,
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
        // Enhanced validation error logging
        logger.error('Validation failed with details', {
          correlationId: (req as any).correlationId,
          requestBody: req.body,
          validationErrors: error.errors,
          requestBodyType: typeof req.body,
          imagePathsPresent: !!req.body.imagePaths,
          imagePathsValue: req.body.imagePaths,
          type: 'validation_error_details'
        });

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

      // Reconstruct image URLs array from stored paths (for multi-image support)
      const imageUrls = generation.imagesPaths?.map(path =>
        `${protocol}://${host}${path}`
      ) || [];

      // Get brand persona image URLs - use production URLs if available, otherwise construct from paths
      const brandPersonaImage1Url = process.env.BASE_MODEL_IMAGE_1_URL ||
        `${protocol}://${host}${(process.env.BASE_MODEL_IMAGE_1 || "/public-objects/base model/basemodel.png").replace(/ /g, '%20')}`;
      const brandPersonaImage2Url = process.env.BASE_MODEL_IMAGE_2_URL ||
        `${protocol}://${host}${(process.env.BASE_MODEL_IMAGE_2 || "/public-objects/base model/basemodel2.png").replace(/ /g, '%20')}`;

      const webhookPayload = N8nWebhookPayloadSchema.parse({
        taskId: generation.taskId,
        promptText: generation.promptText,
        imagePath: generation.imageOriginalPath,
        image_urls: imageUrls,
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
