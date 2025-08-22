import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { logger } from './logger';
import { metricsCollector } from './metrics';
import { alertingSystem } from './alerting';
import { AppError, ValidationError, RateLimitError } from './errorHandler';

export interface ApiManagerConfig {
  enableRateLimit: boolean;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  enableIdempotency: boolean;
  idempotencyTtlMs: number;
  enableRequestValidation: boolean;
  enableResponseValidation: boolean;
  maxRequestSize: string;
  timeoutMs: number;
}

export interface ApiRequest<T = any> {
  correlationId: string;
  userId?: string;
  endpoint: string;
  method: string;
  body: T;
  headers: Record<string, string>;
  query: Record<string, any>;
  timestamp: Date;
  ip: string;
  userAgent?: string;
}

export interface ApiResponse<T = any> {
  correlationId: string;
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  timestamp: string;
  duration: number;
  statusCode: number;
}

export interface IdempotencyRecord {
  correlationId: string;
  response: ApiResponse;
  timestamp: Date;
  ttl: number;
}

export interface RateLimitRecord {
  requests: number[];
  blocked: boolean;
  resetTime: Date;
}

class ApiManager {
  private config: ApiManagerConfig;
  private rateLimitStore: Map<string, RateLimitRecord>;
  private idempotencyStore: Map<string, IdempotencyRecord>;
  private requestTimers: Map<string, number>;

  constructor() {
    this.config = {
      enableRateLimit: true,
      rateLimitWindowMs: 60000, // 1 minute
      rateLimitMaxRequests: 100, // 100 requests per minute per IP
      enableIdempotency: true,
      idempotencyTtlMs: 300000, // 5 minutes
      enableRequestValidation: true,
      enableResponseValidation: false, // Disabled by default for performance
      maxRequestSize: '10mb',
      timeoutMs: 30000 // 30 seconds
    };

    this.rateLimitStore = new Map();
    this.idempotencyStore = new Map();
    this.requestTimers = new Map();

    // Cleanup old records every 5 minutes
    setInterval(() => {
      this.cleanupOldRecords();
    }, 300000);
  }

  // Configuration management
  updateConfig(newConfig: Partial<ApiManagerConfig>): void {
    this.config = { ...this.config, ...newConfig };
    
    logger.info('API Manager configuration updated', {
      config: this.config,
      type: 'api_manager_config'
    });
  }

  getConfig(): ApiManagerConfig {
    return { ...this.config };
  }

  // Rate limiting implementation
  private checkRateLimit(clientId: string, correlationId: string): boolean {
    if (!this.config.enableRateLimit) return true;

    const now = Date.now();
    const windowStart = now - this.config.rateLimitWindowMs;
    
    let record = this.rateLimitStore.get(clientId);
    if (!record) {
      record = {
        requests: [],
        blocked: false,
        resetTime: new Date(now + this.config.rateLimitWindowMs)
      };
      this.rateLimitStore.set(clientId, record);
    }

    // Remove requests outside the window
    record.requests = record.requests.filter(timestamp => timestamp > windowStart);
    
    // Check if limit exceeded
    if (record.requests.length >= this.config.rateLimitMaxRequests) {
      record.blocked = true;
      record.resetTime = new Date(now + this.config.rateLimitWindowMs);
      
      logger.warn('Rate limit exceeded', {
        correlationId,
        clientId,
        requestCount: record.requests.length,
        limit: this.config.rateLimitMaxRequests,
        windowMs: this.config.rateLimitWindowMs,
        type: 'rate_limit_exceeded'
      });

      return false;
    }

    // Add current request
    record.requests.push(now);
    record.blocked = false;
    
    return true;
  }

  // Idempotency implementation
  private checkIdempotency(idempotencyKey: string, correlationId: string): IdempotencyRecord | null {
    if (!this.config.enableIdempotency || !idempotencyKey) return null;

    const record = this.idempotencyStore.get(idempotencyKey);
    if (!record) return null;

    // Check if record is still valid (not expired)
    if (Date.now() - record.timestamp.getTime() > record.ttl) {
      this.idempotencyStore.delete(idempotencyKey);
      return null;
    }

    logger.info('Idempotent request detected', {
      correlationId,
      idempotencyKey,
      originalCorrelationId: record.correlationId,
      age: Date.now() - record.timestamp.getTime(),
      type: 'idempotent_request'
    });

    return record;
  }

  private storeIdempotentResponse(
    idempotencyKey: string, 
    response: ApiResponse, 
    correlationId: string
  ): void {
    if (!this.config.enableIdempotency || !idempotencyKey) return;

    const record: IdempotencyRecord = {
      correlationId,
      response,
      timestamp: new Date(),
      ttl: this.config.idempotencyTtlMs
    };

    this.idempotencyStore.set(idempotencyKey, record);

    logger.debug('Stored idempotent response', {
      correlationId,
      idempotencyKey,
      ttl: this.config.idempotencyTtlMs,
      type: 'idempotent_store'
    });
  }

  // Request validation
  private validateRequest<T>(
    body: any, 
    schema: z.ZodSchema<T>, 
    correlationId: string
  ): T {
    if (!this.config.enableRequestValidation) return body;

    try {
      const validatedData = schema.parse(body);
      
      logger.debug('Request validation successful', {
        correlationId,
        bodySize: JSON.stringify(body).length,
        type: 'request_validation_success'
      });

      return validatedData;
    } catch (error) {
      logger.warn('Request validation failed', {
        correlationId,
        error: error instanceof z.ZodError ? error.errors : String(error),
        body: JSON.stringify(body),
        type: 'request_validation_failed'
      });

      if (error instanceof z.ZodError) {
        throw new ValidationError(
          'Request validation failed',
          error.errors,
          correlationId
        );
      }

      throw new AppError(
        'Invalid request format',
        400,
        'REQUEST_VALIDATION_ERROR',
        { originalError: String(error) },
        correlationId
      );
    }
  }

  // Response validation
  private validateResponse<T>(
    data: any, 
    schema: z.ZodSchema<T>, 
    correlationId: string
  ): T {
    if (!this.config.enableResponseValidation) return data;

    try {
      const validatedData = schema.parse(data);
      
      logger.debug('Response validation successful', {
        correlationId,
        dataSize: JSON.stringify(data).length,
        type: 'response_validation_success'
      });

      return validatedData;
    } catch (error) {
      logger.error('Response validation failed', {
        correlationId,
        error: error instanceof z.ZodError ? error.errors : String(error),
        data: JSON.stringify(data),
        type: 'response_validation_failed'
      });

      // Don't throw for response validation - log error but return original data
      return data;
    }
  }

  // Cleanup old records
  private cleanupOldRecords(): void {
    const now = Date.now();
    
    // Cleanup rate limit records
    let rateLimitCleaned = 0;
    for (const [clientId, record] of Array.from(this.rateLimitStore.entries())) {
      if (record.resetTime.getTime() < now) {
        this.rateLimitStore.delete(clientId);
        rateLimitCleaned++;
      }
    }

    // Cleanup idempotency records
    let idempotencyCleaned = 0;
    for (const [key, record] of Array.from(this.idempotencyStore.entries())) {
      if (now - record.timestamp.getTime() > record.ttl) {
        this.idempotencyStore.delete(key);
        idempotencyCleaned++;
      }
    }

    if (rateLimitCleaned > 0 || idempotencyCleaned > 0) {
      logger.debug('Cleaned up old API manager records', {
        rateLimitCleaned,
        idempotencyCleaned,
        type: 'api_manager_cleanup'
      });
    }
  }

  // Main API processing method
  async processRequest<TRequest, TResponse>(
    req: Request,
    res: Response,
    options: {
      requestSchema?: z.ZodSchema<TRequest>;
      responseSchema?: z.ZodSchema<TResponse>;
      idempotencyKey?: string;
      handler: (validatedRequest: TRequest, apiReq: ApiRequest<TRequest>) => Promise<TResponse>;
    }
  ): Promise<void> {
    const correlationId = (req as any).correlationId;
    const startTime = Date.now();
    
    try {
      // Build API request context
      const apiRequest: ApiRequest<TRequest> = {
        correlationId,
        userId: (req as any).user?.claims?.sub,
        endpoint: req.path,
        method: req.method,
        body: req.body,
        headers: req.headers as Record<string, string>,
        query: req.query,
        timestamp: new Date(),
        ip: req.ip || req.connection.remoteAddress || 'unknown',
        userAgent: req.headers['user-agent']
      };

      // Rate limiting check
      const clientId = apiRequest.userId || apiRequest.ip;
      if (!this.checkRateLimit(clientId, correlationId)) {
        const rateLimitRecord = this.rateLimitStore.get(clientId);
        
        metricsCollector.recordMetric('rate_limit_exceeded', 1, 'count', {
          clientId,
          endpoint: req.path
        }, correlationId);

        alertingSystem.recordError(req.path);

        throw new RateLimitError(
          this.config.rateLimitMaxRequests,
          `${this.config.rateLimitWindowMs}ms`,
          correlationId
        );
      }

      // Idempotency check
      if (options.idempotencyKey) {
        const existingRecord = this.checkIdempotency(options.idempotencyKey, correlationId);
        if (existingRecord) {
          const response = existingRecord.response;
          response.duration = Date.now() - startTime;
          
          res.status(response.statusCode).json(response);
      return;
        }
      }

      // Request validation
      let validatedRequest: TRequest = req.body;
      if (options.requestSchema) {
        validatedRequest = this.validateRequest(
          req.body, 
          options.requestSchema, 
          correlationId
        );
      }

      // Execute handler
      logger.info('Processing API request', {
        correlationId,
        endpoint: apiRequest.endpoint,
        method: apiRequest.method,
        userId: apiRequest.userId,
        ip: apiRequest.ip,
        hasIdempotencyKey: !!options.idempotencyKey,
        type: 'api_request_start'
      });

      const handlerResult = await options.handler(validatedRequest, apiRequest);

      // Response validation
      let validatedResponse: Awaited<TResponse> = await Promise.resolve(handlerResult);
      if (options.responseSchema) {
        validatedResponse = this.validateResponse(
          handlerResult,
          options.responseSchema,
          correlationId
        ) as Awaited<TResponse>;
      }

      // Build API response
      const duration = Date.now() - startTime;
      const apiResponse: ApiResponse<TResponse> = {
        correlationId,
        success: true,
        data: validatedResponse,
        timestamp: new Date().toISOString(),
        duration,
        statusCode: 200
      };

      // Store idempotent response if applicable
      if (options.idempotencyKey) {
        this.storeIdempotentResponse(options.idempotencyKey, apiResponse, correlationId);
      }

      // Record metrics
      metricsCollector.recordMetric('api_request_success', 1, 'count', {
        endpoint: req.path,
        method: req.method
      }, correlationId);

      logger.info('API request completed successfully', {
        correlationId,
        endpoint: apiRequest.endpoint,
        method: apiRequest.method,
        duration,
        responseSize: JSON.stringify(validatedResponse).length,
        type: 'api_request_success'
      });

      res.status(200).json(apiResponse);
      return;

    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Record error metrics
      metricsCollector.recordMetric('api_request_error', 1, 'count', {
        endpoint: req.path,
        method: req.method,
        errorType: error instanceof AppError ? error.code : 'unknown'
      }, correlationId);

      alertingSystem.recordError(req.path);

      logger.error('API request failed', {
        correlationId,
        endpoint: req.path,
        method: req.method,
        duration,
        error: error instanceof Error ? error.message : String(error),
        type: 'api_request_error'
      });

      // Re-throw to let error handler middleware handle it
      throw error;
    }
  }

  // Get current status and statistics
  getStatus(): {
    config: ApiManagerConfig;
    rateLimitStats: {
      totalClients: number;
      blockedClients: number;
      totalRequests: number;
    };
    idempotencyStats: {
      totalKeys: number;
      cacheHitRate: number;
    };
    uptime: number;
  } {
    const blockedClients = Array.from(this.rateLimitStore.values()).filter(r => r.blocked).length;
    const totalRequests = Array.from(this.rateLimitStore.values())
      .reduce((sum, record) => sum + record.requests.length, 0);

    return {
      config: this.config,
      rateLimitStats: {
        totalClients: this.rateLimitStore.size,
        blockedClients,
        totalRequests
      },
      idempotencyStats: {
        totalKeys: this.idempotencyStore.size,
        cacheHitRate: 0 // TODO: Implement cache hit tracking
      },
      uptime: process.uptime()
    };
  }
}

// Create singleton instance
export const apiManager = new ApiManager();

// Middleware factory for rate limiting
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = (req as any).correlationId;
  const clientId = (req as any).user?.claims?.sub || req.ip || req.connection.remoteAddress || 'unknown';
  
  const rateLimitRecord = apiManager['rateLimitStore'].get(clientId);
  
  if (rateLimitRecord) {
    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', apiManager['config'].rateLimitMaxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, apiManager['config'].rateLimitMaxRequests - rateLimitRecord.requests.length));
    res.setHeader('X-RateLimit-Reset', rateLimitRecord.resetTime.toISOString());
    
    if (rateLimitRecord.blocked) {
      res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests',
          correlationId,
          retryAfter: rateLimitRecord.resetTime.toISOString()
        },
        success: false,
        timestamp: new Date().toISOString()
      });
      return;
    }
  }
  
  next();
}