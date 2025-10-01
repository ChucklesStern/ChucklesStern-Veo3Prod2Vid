import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { logger } from './logger';
import { metricsCollector } from './metrics';
import { ValidationError } from './errorHandler';

export interface ValidationConfig {
  enableRequestValidation: boolean;
  enableResponseValidation: boolean;
  enableQueryValidation: boolean;
  enableHeaderValidation: boolean;
  strictMode: boolean;
  maxPayloadSize: number;
  sanitizeInputs: boolean;
  logValidationErrors: boolean;
}

export interface ValidationRule {
  endpoint: string;
  method: string;
  requestSchema?: z.ZodSchema;
  responseSchema?: z.ZodSchema;
  querySchema?: z.ZodSchema;
  headerSchema?: z.ZodSchema;
  enabled: boolean;
  description: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: z.ZodError['errors'];
  data?: any;
  sanitizedData?: any;
}

class ValidationManager {
  private config: ValidationConfig;
  private rules: Map<string, ValidationRule>;
  private stats: {
    totalValidations: number;
    successfulValidations: number;
    failedValidations: number;
    validationErrors: Map<string, number>;
  };

  constructor() {
    this.config = {
      enableRequestValidation: true,
      enableResponseValidation: false, // Disabled by default for performance
      enableQueryValidation: true,
      enableHeaderValidation: false,
      strictMode: false,
      maxPayloadSize: 10 * 1024 * 1024, // 10MB
      sanitizeInputs: true,
      logValidationErrors: true
    };

    this.rules = new Map();
    this.stats = {
      totalValidations: 0,
      successfulValidations: 0,
      failedValidations: 0,
      validationErrors: new Map()
    };

    this.initializeDefaultRules();
  }

  private initializeDefaultRules(): void {
    // Enhanced webhook callback validation
    const webhookCallbackRule: ValidationRule = {
      endpoint: '/api/generations/callback',
      method: 'POST',
      requestSchema: z.object({
        taskId: z.string().uuid('Task ID must be a valid UUID'),
        status: z.enum(['completed', 'failed', '200'], {
          errorMap: () => ({ message: 'Status must be completed, failed, or 200' })
        }),
        imageGenerationPath: z.string().optional().refine(
          (path) => !path || path.startsWith('/') || path.startsWith('http'),
          'Image path must be a valid path or URL'
        ),
        videoPath: z.string().optional().refine(
          (path) => !path || path.startsWith('/') || path.startsWith('http'),
          'Video path must be a valid path or URL'
        ),
        errorMessage: z.string().optional().transform(
          (msg) => msg ? this.sanitizeString(msg) : msg
        )
      }).strict(),
      enabled: true,
      description: 'Webhook callback validation with enhanced security'
    };

    // Generation creation validation - DISABLED due to double validation issue
    // The route handler already validates with GenerationCreateRequestSchema
    const generationCreateRule: ValidationRule = {
      endpoint: '/api/generations',
      method: 'POST',
      requestSchema: z.object({
        promptText: z.string()
          .min(1, 'Prompt text is required')
          .max(5000, 'Prompt text must be less than 5000 characters')
          .transform((text) => this.sanitizeString(text)),
        image_urls: z.array(
          z.string().refine(
            (path) => path.startsWith('/public-objects/'),
            'Each image path must be a valid public object path'
          )
        ).max(10, 'Maximum 10 images allowed').optional(),
        brand_persona: z.string().max(2000, 'Brand persona must be less than 2000 characters').optional()
          .transform((text: string | undefined) => text ? this.sanitizeString(text) : text)
      }).strict(),
      querySchema: z.object({
        async: z.enum(['true', 'false']).optional(),
        priority: z.enum(['low', 'normal', 'high']).optional()
      }).strict(),
      enabled: false, // DISABLED - route handler validation is sufficient
      description: 'Video generation request validation with sanitization (DISABLED)'
    };

    // File upload validation
    const uploadRule: ValidationRule = {
      endpoint: '/api/upload',
      method: 'POST',
      headerSchema: z.object({
        'content-type': z.string().refine(
          (type) => type.startsWith('multipart/form-data'),
          'Content type must be multipart/form-data'
        ),
        'content-length': z.string().optional().refine(
          (length) => !length || parseInt(length) <= this.config.maxPayloadSize,
          `File size must be less than ${this.config.maxPayloadSize} bytes`
        )
      }),
      enabled: true,
      description: 'File upload validation with size limits'
    };

    // Health check validation
    const healthRule: ValidationRule = {
      endpoint: '/api/health',
      method: 'GET',
      responseSchema: z.object({
        status: z.enum(['healthy', 'degraded', 'unhealthy']),
        timestamp: z.string(),
        uptime: z.number(),
        version: z.string(),
        environment: z.string(),
        dependencies: z.object({
          database: z.enum(['up', 'down', 'degraded']),
          objectStorage: z.enum(['up', 'down', 'degraded']),
          n8nWebhook: z.enum(['up', 'down', 'degraded'])
        }),
        metrics: z.object({
          requests: z.object({
            total: z.number(),
            successful: z.number(),
            failed: z.number(),
            averageResponseTime: z.number()
          }),
          alerts: z.object({
            active: z.number(),
            recent: z.number()
          })
        }),
        correlationId: z.string()
      }),
      enabled: this.config.enableResponseValidation,
      description: 'Health endpoint response validation'
    };

    // Add rules
    this.addRule(webhookCallbackRule);
    this.addRule(generationCreateRule);
    this.addRule(uploadRule);
    this.addRule(healthRule);
  }

  // Configuration management
  updateConfig(newConfig: Partial<ValidationConfig>): void {
    this.config = { ...this.config, ...newConfig };
    
    logger.info('Validation configuration updated', {
      config: this.config,
      type: 'validation_config_updated'
    });
  }

  getConfig(): ValidationConfig {
    return { ...this.config };
  }

  // Rule management
  addRule(rule: ValidationRule): void {
    const key = `${rule.method}:${rule.endpoint}`;
    this.rules.set(key, rule);
    
    logger.debug('Validation rule added', {
      key,
      description: rule.description,
      enabled: rule.enabled,
      type: 'validation_rule_added'
    });
  }

  updateRule(endpoint: string, method: string, updates: Partial<ValidationRule>): boolean {
    const key = `${method}:${endpoint}`;
    const rule = this.rules.get(key);
    
    if (!rule) return false;

    const updatedRule = { ...rule, ...updates };
    this.rules.set(key, updatedRule);
    
    logger.info('Validation rule updated', {
      key,
      updates,
      type: 'validation_rule_updated'
    });

    return true;
  }

  removeRule(endpoint: string, method: string): boolean {
    const key = `${method}:${endpoint}`;
    const removed = this.rules.delete(key);
    
    if (removed) {
      logger.info('Validation rule removed', {
        key,
        type: 'validation_rule_removed'
      });
    }

    return removed;
  }

  getRules(): ValidationRule[] {
    return Array.from(this.rules.values());
  }

  // Input sanitization
  private sanitizeString(input: string): string {
    if (!this.config.sanitizeInputs) return input;

    return input
      .trim()
      .replace(/[<>]/g, '') // Remove potential HTML tags
      .replace(/javascript:/gi, '') // Remove javascript: URLs
      .replace(/on\w+=/gi, '') // Remove event handlers
      .slice(0, 10000); // Limit length
  }

  // Validation methods
  private validateWithSchema<T>(
    data: any,
    schema: z.ZodSchema<T>,
    correlationId: string,
    context: string
  ): ValidationResult {
    this.stats.totalValidations++;

    try {
      const validatedData = schema.parse(data);
      this.stats.successfulValidations++;
      
      logger.debug(`${context} validation successful`, {
        correlationId,
        dataSize: JSON.stringify(data).length,
        type: 'validation_success'
      });

      return {
        isValid: true,
        errors: [],
        data: validatedData,
        sanitizedData: validatedData
      };

    } catch (error) {
      this.stats.failedValidations++;
      
      if (error instanceof z.ZodError) {
        // Track error types
        for (const issue of error.errors) {
          const errorKey = `${issue.code}:${issue.path.join('.')}`;
          this.stats.validationErrors.set(
            errorKey,
            (this.stats.validationErrors.get(errorKey) || 0) + 1
          );
        }

        if (this.config.logValidationErrors) {
          logger.warn(`${context} validation failed`, {
            correlationId,
            errors: error.errors,
            data: this.config.strictMode ? undefined : JSON.stringify(data),
            type: 'validation_failed'
          });
        }

        return {
          isValid: false,
          errors: error.errors,
          data: this.config.strictMode ? undefined : data
        };
      }

      logger.error(`${context} validation error`, {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        type: 'validation_error'
      });

      return {
        isValid: false,
        errors: [{ 
          code: 'unknown', 
          message: 'Validation failed', 
          path: [] 
        }] as any,
        data: this.config.strictMode ? undefined : data
      };
    }
  }

  // Main validation method
  validate(req: Request, res: Response, correlationId: string): {
    requestValid: boolean;
    queryValid: boolean;
    headerValid: boolean;
    errors: string[];
    validatedData: {
      body?: any;
      query?: any;
      headers?: any;
    };
  } {
    const timer = metricsCollector.startTimer(`validation_${correlationId}`);
    const key = `${req.method}:${req.path}`;
    const rule = this.rules.get(key);
    
    const errors: string[] = [];
    const validatedData: { body?: any; query?: any; headers?: any } = {};
    
    let requestValid = true;
    let queryValid = true;
    let headerValid = true;

    try {
      if (!rule || !rule.enabled) {
        logger.debug('No validation rule found or disabled', {
          correlationId,
          endpoint: req.path,
          method: req.method,
          type: 'validation_skipped'
        });
        
        return {
          requestValid: true,
          queryValid: true,
          headerValid: true,
          errors: [],
          validatedData: {
            body: req.body,
            query: req.query,
            headers: req.headers
          }
        };
      }

      // Validate request body
      if (this.config.enableRequestValidation && rule.requestSchema) {
        const result = this.validateWithSchema(
          req.body,
          rule.requestSchema,
          correlationId,
          'Request body'
        );
        
        if (!result.isValid) {
          requestValid = false;
          errors.push(...result.errors.map(e => `Request: ${e.message}`));
        } else {
          validatedData.body = result.data;
        }
      }

      // Validate query parameters
      if (this.config.enableQueryValidation && rule.querySchema) {
        const result = this.validateWithSchema(
          req.query,
          rule.querySchema,
          correlationId,
          'Query parameters'
        );
        
        if (!result.isValid) {
          queryValid = false;
          errors.push(...result.errors.map(e => `Query: ${e.message}`));
        } else {
          validatedData.query = result.data;
        }
      }

      // Validate headers
      if (this.config.enableHeaderValidation && rule.headerSchema) {
        const result = this.validateWithSchema(
          req.headers,
          rule.headerSchema,
          correlationId,
          'Headers'
        );
        
        if (!result.isValid) {
          headerValid = false;
          errors.push(...result.errors.map(e => `Header: ${e.message}`));
        } else {
          validatedData.headers = result.data;
        }
      }

      const duration = timer();
      const overallValid = requestValid && queryValid && headerValid;

      logger.info('Validation completed', {
        correlationId,
        endpoint: req.path,
        method: req.method,
        requestValid,
        queryValid,
        headerValid,
        overallValid,
        errorCount: errors.length,
        duration,
        type: 'validation_completed'
      });

      // Record metrics
      metricsCollector.recordMetric('validation_duration', duration, 'ms', {
        endpoint: req.path,
        method: req.method,
        valid: overallValid.toString()
      }, correlationId);

      return {
        requestValid,
        queryValid,
        headerValid,
        errors,
        validatedData
      };

    } catch (error) {
      const duration = timer();
      
      logger.error('Validation processing error', {
        correlationId,
        endpoint: req.path,
        method: req.method,
        error: error instanceof Error ? error.message : String(error),
        duration,
        type: 'validation_processing_error'
      });

      // Return original data on validation error
      return {
        requestValid: !this.config.strictMode,
        queryValid: !this.config.strictMode,
        headerValid: !this.config.strictMode,
        errors: ['Validation processing failed'],
        validatedData: {
          body: req.body,
          query: req.query,
          headers: req.headers
        }
      };
    }
  }

  // Response validation
  validateResponse<T>(
    data: any,
    schema: z.ZodSchema<T>,
    correlationId: string,
    endpoint: string
  ): ValidationResult {
    if (!this.config.enableResponseValidation) {
      return {
        isValid: true,
        errors: [],
        data
      };
    }

    return this.validateWithSchema(data, schema, correlationId, 'Response');
  }

  // Get validation statistics
  getStats(): {
    config: ValidationConfig;
    statistics: {
      totalValidations: number;
      successfulValidations: number;
      failedValidations: number;
      successRate: number;
    };
    errorBreakdown: Array<{
      error: string;
      count: number;
    }>;
    topRules: Array<{
      endpoint: string;
      method: string;
      enabled: boolean;
      description: string;
    }>;
  } {
    const successRate = this.stats.totalValidations > 0 
      ? (this.stats.successfulValidations / this.stats.totalValidations) * 100 
      : 0;

    const errorBreakdown = Array.from(this.stats.validationErrors.entries())
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topRules = Array.from(this.rules.values())
      .map(rule => ({
        endpoint: rule.endpoint,
        method: rule.method,
        enabled: rule.enabled,
        description: rule.description
      }))
      .slice(0, 10);

    return {
      config: this.config,
      statistics: {
        totalValidations: this.stats.totalValidations,
        successfulValidations: this.stats.successfulValidations,
        failedValidations: this.stats.failedValidations,
        successRate: Math.round(successRate * 100) / 100
      },
      errorBreakdown,
      topRules
    };
  }

  // Clear statistics
  clearStats(): void {
    this.stats = {
      totalValidations: 0,
      successfulValidations: 0,
      failedValidations: 0,
      validationErrors: new Map()
    };
    
    logger.info('Validation statistics cleared', {
      type: 'validation_stats_cleared'
    });
  }
}

// Create singleton instance
export const validationManager = new ValidationManager();

// Validation middleware
export function validationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const correlationId = (req as any).correlationId;
  
  try {
    const result = validationManager.validate(req, res, correlationId);
    
    if (!result.requestValid || !result.queryValid || !result.headerValid) {
      const error = new ValidationError(
        'Request validation failed',
        {
          requestValid: result.requestValid,
          queryValid: result.queryValid,
          headerValid: result.headerValid,
          errors: result.errors
        },
        correlationId
      );
      
      return next(error);
    }

    // Replace request data with validated data
    if (result.validatedData.body !== undefined) {
      req.body = result.validatedData.body;
    }
    if (result.validatedData.query !== undefined) {
      req.query = result.validatedData.query;
    }

    next();

  } catch (error) {
    logger.error('Validation middleware error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      type: 'validation_middleware_error'
    });
    
    // Allow request to proceed on validation error in non-strict mode
    if (!validationManager.getConfig().strictMode) {
      next();
    } else {
      next(error);
    }
  }
}