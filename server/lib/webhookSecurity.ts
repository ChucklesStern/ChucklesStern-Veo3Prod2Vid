import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';
import { metricsCollector } from './metrics';
import { AppError } from './errorHandler';

export interface WebhookSecurityConfig {
  enableSignatureVerification: boolean;
  webhookSecret?: string;
  signatureHeader: string;
  signaturePrefix: string;
  timestampHeader: string;
  timestampToleranceMs: number;
  enableTimestampValidation: boolean;
  enableReplayProtection: boolean;
  replayWindowMs: number;
}

export interface WebhookSignature {
  timestamp: number;
  signature: string;
  algorithm: string;
}

class WebhookSecurityManager {
  private config: WebhookSecurityConfig;
  private processedWebhooks: Set<string>; // For replay protection
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.config = {
      enableSignatureVerification: true,
      webhookSecret: process.env.WEBHOOK_SECRET,
      signatureHeader: 'x-webhook-signature',
      signaturePrefix: 'sha256=',
      timestampHeader: 'x-webhook-timestamp',
      timestampToleranceMs: 300000, // 5 minutes
      enableTimestampValidation: true,
      enableReplayProtection: true,
      replayWindowMs: 600000 // 10 minutes
    };

    this.processedWebhooks = new Set();

    // Clean up old webhook IDs every 10 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldWebhooks();
    }, 600000);
  }

  updateConfig(newConfig: Partial<WebhookSecurityConfig>): void {
    this.config = { ...this.config, ...newConfig };
    
    logger.info('Webhook security configuration updated', {
      enableSignatureVerification: this.config.enableSignatureVerification,
      enableTimestampValidation: this.config.enableTimestampValidation,
      enableReplayProtection: this.config.enableReplayProtection,
      type: 'webhook_security_config'
    });
  }

  getConfig(): WebhookSecurityConfig {
    return { ...this.config };
  }

  // Generate webhook signature for outgoing webhooks
  generateSignature(payload: string, secret: string, timestamp?: number): string {
    const webhookTimestamp = timestamp || Math.floor(Date.now() / 1000);
    const signedPayload = `${webhookTimestamp}.${payload}`;
    
    const signature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('hex');

    return `${this.config.signaturePrefix}${signature}`;
  }

  // Verify webhook signature
  private verifySignature(
    payload: string, 
    signature: string, 
    timestamp: number, 
    secret: string,
    correlationId: string
  ): boolean {
    if (!this.config.enableSignatureVerification) {
      logger.debug('Webhook signature verification disabled', {
        correlationId,
        type: 'webhook_signature_disabled'
      });
      return true;
    }

    if (!secret) {
      logger.error('Webhook secret not configured', {
        correlationId,
        type: 'webhook_secret_missing'
      });
      return false;
    }

    try {
      // Remove prefix if present
      const cleanSignature = signature.startsWith(this.config.signaturePrefix) 
        ? signature.slice(this.config.signaturePrefix.length)
        : signature;

      // Generate expected signature
      const signedPayload = `${timestamp}.${payload}`;
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(signedPayload, 'utf8')
        .digest('hex');

      // Use crypto.timingSafeEqual to prevent timing attacks
      const signatureBuffer = Buffer.from(cleanSignature, 'hex');
      const expectedBuffer = Buffer.from(expectedSignature, 'hex');

      if (signatureBuffer.length !== expectedBuffer.length) {
        logger.warn('Webhook signature length mismatch', {
          correlationId,
          expectedLength: expectedBuffer.length,
          actualLength: signatureBuffer.length,
          type: 'webhook_signature_length_mismatch'
        });
        return false;
      }

      const isValid = crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

      if (!isValid) {
        logger.warn('Webhook signature verification failed', {
          correlationId,
          timestamp,
          providedSignature: cleanSignature.slice(0, 8) + '...', // Log only first 8 chars
          type: 'webhook_signature_invalid'
        });
      } else {
        logger.debug('Webhook signature verified successfully', {
          correlationId,
          timestamp,
          type: 'webhook_signature_valid'
        });
      }

      return isValid;

    } catch (error) {
      logger.error('Error verifying webhook signature', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        type: 'webhook_signature_error'
      });
      return false;
    }
  }

  // Validate webhook timestamp
  private validateTimestamp(timestamp: number, correlationId: string): boolean {
    if (!this.config.enableTimestampValidation) {
      logger.debug('Webhook timestamp validation disabled', {
        correlationId,
        type: 'webhook_timestamp_disabled'
      });
      return true;
    }

    const now = Date.now();
    const webhookTime = timestamp * 1000; // Convert to milliseconds
    const timeDiff = Math.abs(now - webhookTime);

    if (timeDiff > this.config.timestampToleranceMs) {
      logger.warn('Webhook timestamp outside tolerance window', {
        correlationId,
        webhookTimestamp: new Date(webhookTime).toISOString(),
        currentTime: new Date(now).toISOString(),
        timeDiffMs: timeDiff,
        toleranceMs: this.config.timestampToleranceMs,
        type: 'webhook_timestamp_invalid'
      });
      return false;
    }

    logger.debug('Webhook timestamp validated', {
      correlationId,
      webhookTimestamp: new Date(webhookTime).toISOString(),
      timeDiffMs: timeDiff,
      type: 'webhook_timestamp_valid'
    });

    return true;
  }

  // Check for replay attacks
  private checkReplayProtection(
    payload: string, 
    timestamp: number, 
    correlationId: string
  ): boolean {
    if (!this.config.enableReplayProtection) {
      logger.debug('Webhook replay protection disabled', {
        correlationId,
        type: 'webhook_replay_disabled'
      });
      return true;
    }

    // Create unique identifier for this webhook
    const webhookId = crypto
      .createHash('sha256')
      .update(`${timestamp}.${payload}`)
      .digest('hex');

    if (this.processedWebhooks.has(webhookId)) {
      logger.warn('Webhook replay attack detected', {
        correlationId,
        webhookId: webhookId.slice(0, 16) + '...', // Log only first 16 chars
        timestamp,
        type: 'webhook_replay_detected'
      });
      return false;
    }

    // Add to processed set
    this.processedWebhooks.add(webhookId);

    logger.debug('Webhook replay check passed', {
      correlationId,
      webhookId: webhookId.slice(0, 16) + '...',
      type: 'webhook_replay_valid'
    });

    return true;
  }

  // Parse webhook headers
  private parseWebhookHeaders(req: Request, correlationId: string): WebhookSignature | null {
    const signatureHeader = req.headers[this.config.signatureHeader] as string;
    const timestampHeader = req.headers[this.config.timestampHeader] as string;

    if (!signatureHeader) {
      logger.warn('Missing webhook signature header', {
        correlationId,
        expectedHeader: this.config.signatureHeader,
        availableHeaders: Object.keys(req.headers),
        type: 'webhook_signature_header_missing'
      });
      return null;
    }

    let timestamp: number;
    if (timestampHeader) {
      timestamp = parseInt(timestampHeader, 10);
      if (isNaN(timestamp)) {
        logger.warn('Invalid webhook timestamp header', {
          correlationId,
          timestampHeader,
          type: 'webhook_timestamp_header_invalid'
        });
        return null;
      }
    } else {
      // If no timestamp header, use current time (less secure)
      timestamp = Math.floor(Date.now() / 1000);
      logger.debug('Using current time for webhook timestamp', {
        correlationId,
        timestamp,
        type: 'webhook_timestamp_fallback'
      });
    }

    return {
      timestamp,
      signature: signatureHeader,
      algorithm: 'sha256' // Currently only support SHA256
    };
  }

  // Main webhook verification method
  verifyWebhook(req: Request, rawBody: string, correlationId: string): boolean {
    const timer = metricsCollector.startTimer(`webhook_verification_${correlationId}`);

    try {
      logger.info('Starting webhook verification', {
        correlationId,
        contentLength: rawBody.length,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
        type: 'webhook_verification_start'
      });

      // Parse headers
      const webhookSignature = this.parseWebhookHeaders(req, correlationId);
      if (!webhookSignature) {
        metricsCollector.recordMetric('webhook_verification_failed', 1, 'count', {
          reason: 'header_parsing_failed'
        }, correlationId);
        return false;
      }

      // Validate timestamp
      if (!this.validateTimestamp(webhookSignature.timestamp, correlationId)) {
        metricsCollector.recordMetric('webhook_verification_failed', 1, 'count', {
          reason: 'timestamp_invalid'
        }, correlationId);
        return false;
      }

      // Check replay protection
      if (!this.checkReplayProtection(rawBody, webhookSignature.timestamp, correlationId)) {
        metricsCollector.recordMetric('webhook_verification_failed', 1, 'count', {
          reason: 'replay_detected'
        }, correlationId);
        return false;
      }

      // Verify signature
      const secret = this.config.webhookSecret;
      if (!this.verifySignature(rawBody, webhookSignature.signature, webhookSignature.timestamp, secret!, correlationId)) {
        metricsCollector.recordMetric('webhook_verification_failed', 1, 'count', {
          reason: 'signature_invalid'
        }, correlationId);
        return false;
      }

      const duration = timer();
      
      logger.info('Webhook verification successful', {
        correlationId,
        timestamp: webhookSignature.timestamp,
        duration,
        type: 'webhook_verification_success'
      });

      metricsCollector.recordMetric('webhook_verification_success', 1, 'count', {
        duration: duration.toString()
      }, correlationId);

      return true;

    } catch (error) {
      const duration = timer();
      
      logger.error('Webhook verification error', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        duration,
        type: 'webhook_verification_error'
      });

      metricsCollector.recordMetric('webhook_verification_failed', 1, 'count', {
        reason: 'verification_error'
      }, correlationId);

      return false;
    }
  }

  // Cleanup old webhook IDs to prevent memory leaks
  private cleanupOldWebhooks(): void {
    const cutoffTime = Date.now() - this.config.replayWindowMs;
    const initialSize = this.processedWebhooks.size;
    
    // Since we store hashes, we can't easily determine timestamp
    // In production, consider using a Map with timestamps
    // For now, clear all if size gets too large
    if (this.processedWebhooks.size > 10000) {
      this.processedWebhooks.clear();
      
      logger.info('Cleared webhook replay protection cache', {
        previousSize: initialSize,
        newSize: this.processedWebhooks.size,
        type: 'webhook_replay_cache_cleanup'
      });
    }
  }

  // Get security status
  getSecurityStatus(): {
    config: WebhookSecurityConfig;
    processedWebhooks: number;
    isConfigured: boolean;
  } {
    return {
      config: this.config,
      processedWebhooks: this.processedWebhooks.size,
      isConfigured: !!this.config.webhookSecret
    };
  }

  // Cleanup resources
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.processedWebhooks.clear();
  }
}

// Create singleton instance
export const webhookSecurity = new WebhookSecurityManager();

// Middleware for webhook verification
export function webhookSecurityMiddleware(
  req: Request & { rawBody?: string }, 
  res: Response, 
  next: NextFunction
): void {
  const correlationId = (req as any).correlationId;
  
  // Skip verification if disabled or no secret configured
  if (!webhookSecurity.getConfig().enableSignatureVerification || !webhookSecurity.getConfig().webhookSecret) {
    logger.debug('Webhook security verification skipped', {
      correlationId,
      reason: 'disabled_or_not_configured',
      type: 'webhook_security_skipped'
    });
    return next();
  }

  // Get raw body for verification
  const rawBody = req.rawBody || JSON.stringify(req.body);
  
  // Verify webhook
  const isValid = webhookSecurity.verifyWebhook(req, rawBody, correlationId);
  
  if (!isValid) {
    const error = new AppError(
      'Webhook verification failed',
      401,
      'WEBHOOK_VERIFICATION_FAILED',
      {
        reason: 'Invalid signature, timestamp, or replay detected'
      },
      correlationId
    );
    
    res.status(401).json({
      error: error.toJSON(),
      success: false
    });
    return;
  }

  next();
}

// Middleware to capture raw body for signature verification
export function rawBodyMiddleware(
  req: Request & { rawBody?: string }, 
  res: Response, 
  next: NextFunction
): void {
  if (req.headers['content-type']?.includes('application/json')) {
    let data = '';
    
    req.on('data', (chunk) => {
      data += chunk;
    });
    
    req.on('end', () => {
      req.rawBody = data;
      try {
        req.body = data ? JSON.parse(data) : {};
      } catch (error) {
        req.body = {};
      }
      next();
    });
  } else {
    next();
  }
}