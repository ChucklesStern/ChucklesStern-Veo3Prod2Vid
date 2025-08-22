import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { logger } from './logger';
import { apiMonitor } from './monitoring';

export interface ApiError {
  code: string;
  message: string;
  details?: any;
  correlationId?: string;
  statusCode: number;
  timestamp: string;
  endpoint?: string;
  method?: string;
  stack?: string;
}

export interface ErrorContext {
  correlationId?: string;
  userId?: string;
  taskId?: string;
  endpoint?: string;
  method?: string;
  requestBody?: any;
  userAgent?: string;
  ip?: string;
}

export class AppError extends Error {
  public code: string;
  public statusCode: number;
  public details?: any;
  public correlationId?: string;
  public isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    details?: any,
    correlationId?: string
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.correlationId = correlationId;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): ApiError {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      correlationId: this.correlationId,
      statusCode: this.statusCode,
      timestamp: new Date().toISOString(),
      stack: process.env.NODE_ENV === 'development' ? this.stack : undefined
    };
  }
}

// Predefined error types
export class ValidationError extends AppError {
  constructor(message: string, details?: any, correlationId?: string) {
    super(message, 400, 'VALIDATION_ERROR', details, correlationId);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, correlationId?: string) {
    super(`${resource} not found`, 404, 'NOT_FOUND', { resource }, correlationId);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized', correlationId?: string) {
    super(message, 401, 'UNAUTHORIZED', undefined, correlationId);
  }
}

export class WebhookError extends AppError {
  constructor(message: string, statusCode: number, details?: any, correlationId?: string) {
    super(message, 500, 'WEBHOOK_ERROR', { webhookStatusCode: statusCode, ...details }, correlationId);
  }
}

export class ExternalServiceError extends AppError {
  constructor(service: string, message: string, details?: any, correlationId?: string) {
    super(`${service} error: ${message}`, 502, 'EXTERNAL_SERVICE_ERROR', { service, ...details }, correlationId);
  }
}

export class RateLimitError extends AppError {
  constructor(limit: number, window: string, correlationId?: string) {
    super('Rate limit exceeded', 429, 'RATE_LIMIT_EXCEEDED', { limit, window }, correlationId);
  }
}

// Error handler middleware
export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const correlationId = (req as any).correlationId;
  const context: ErrorContext = {
    correlationId,
    userId: (req as any).user?.claims?.sub,
    endpoint: req.path,
    method: req.method,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection.remoteAddress
  };

  let apiError: ApiError;

  if (error instanceof AppError) {
    // Known application errors
    apiError = error.toJSON();
    apiError.endpoint = req.path;
    apiError.method = req.method;
    
    logger.warn(`Application Error: ${error.message}`, {
      ...context,
      error: error.toJSON(),
      type: 'application_error'
    });
  } else if (error instanceof z.ZodError) {
    // Zod validation errors
    apiError = {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: error.errors,
      correlationId,
      statusCode: 400,
      timestamp: new Date().toISOString(),
      endpoint: req.path,
      method: req.method
    };

    logger.warn('Validation Error', {
      ...context,
      validationErrors: error.errors,
      type: 'validation_error'
    });
  } else if (error.name === 'MulterError') {
    // File upload errors
    const statusCode = (error as any).code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    apiError = {
      code: 'FILE_UPLOAD_ERROR',
      message: error.message,
      details: { code: (error as any).code },
      correlationId,
      statusCode,
      timestamp: new Date().toISOString(),
      endpoint: req.path,
      method: req.method
    };

    logger.warn('File Upload Error', {
      ...context,
      multerError: (error as any).code,
      type: 'file_upload_error'
    });
  } else {
    // Unexpected errors
    apiError = {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production' 
        ? 'Internal server error' 
        : error.message,
      details: process.env.NODE_ENV === 'development' ? { stack: error.stack } : undefined,
      correlationId,
      statusCode: 500,
      timestamp: new Date().toISOString(),
      endpoint: req.path,
      method: req.method,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    };

    logger.error(`Unexpected Error: ${error.message}`, {
      ...context,
      error: error.message,
      stack: error.stack,
      type: 'unexpected_error'
    });
  }

  // Record error in monitoring
  apiMonitor.recordError(req.path, error, correlationId);

  // Send error response
  res.status(apiError.statusCode).json({
    error: apiError,
    success: false
  });
}

// Async error wrapper
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Error context enhancer
export function enhanceErrorContext(req: Request): ErrorContext {
  return {
    correlationId: (req as any).correlationId,
    userId: (req as any).user?.claims?.sub,
    endpoint: req.path,
    method: req.method,
    requestBody: req.method !== 'GET' ? req.body : undefined,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection.remoteAddress
  };
}

// Database error helper
export function handleDatabaseError(error: any, operation: string, correlationId?: string): never {
  logger.error(`Database error during ${operation}`, {
    correlationId,
    operation,
    error: error.message,
    code: error.code,
    type: 'database_error'
  });

  throw new AppError(
    `Database operation failed: ${operation}`,
    500,
    'DATABASE_ERROR',
    { operation, originalError: error.message },
    correlationId
  );
}

// Webhook error helper
export function handleWebhookError(
  url: string, 
  statusCode: number, 
  responseBody: string, 
  correlationId?: string
): never {
  logger.error(`Webhook call failed: ${url}`, {
    correlationId,
    webhookUrl: url,
    statusCode,
    responseBody,
    type: 'webhook_error'
  });

  throw new WebhookError(
    `Webhook call failed with status ${statusCode}`,
    statusCode,
    { url, responseBody },
    correlationId
  );
}

// File operation error helper
export function handleFileError(operation: string, filePath: string, error: any, correlationId?: string): never {
  logger.error(`File operation failed: ${operation}`, {
    correlationId,
    operation,
    filePath,
    error: error.message,
    type: 'file_error'
  });

  throw new AppError(
    `File operation failed: ${operation}`,
    500,
    'FILE_ERROR',
    { operation, filePath, originalError: error.message },
    correlationId
  );
}