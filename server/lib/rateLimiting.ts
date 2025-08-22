import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';
import { metricsCollector } from './metrics';
import { alertingSystem } from './alerting';

export interface RateLimitRule {
  id: string;
  name: string;
  windowMs: number;
  maxRequests: number;
  keyGenerator: (req: Request) => string;
  skipPaths?: string[];
  skipMethods?: string[];
  skipCondition?: (req: Request) => boolean;
  message: string;
  headers: boolean;
  enabled: boolean;
}

export interface RateLimitRecord {
  requests: number[];
  blocked: boolean;
  resetTime: Date;
  totalRequests: number;
  blockedRequests: number;
  firstRequest: Date;
  lastRequest: Date;
}

export interface RateLimitStats {
  totalRules: number;
  activeRules: number;
  totalClients: number;
  blockedClients: number;
  totalRequests: number;
  blockedRequests: number;
  topClients: Array<{
    clientId: string;
    requests: number;
    blocked: boolean;
    lastSeen: Date;
  }>;
}

class RateLimitManager {
  private rules: Map<string, RateLimitRule>;
  private stores: Map<string, Map<string, RateLimitRecord>>; // ruleId -> clientId -> record
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.rules = new Map();
    this.stores = new Map();

    // Initialize default rules
    this.initializeDefaultRules();

    // Cleanup old records every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldRecords();
    }, 300000);
  }

  private initializeDefaultRules(): void {
    const defaultRules: RateLimitRule[] = [
      {
        id: 'global',
        name: 'Global Rate Limit',
        windowMs: 60000, // 1 minute
        maxRequests: 100,
        keyGenerator: (req: Request) => this.getClientId(req),
        message: 'Too many requests from this client',
        headers: true,
        enabled: true
      },
      {
        id: 'api_strict',
        name: 'API Strict Rate Limit',
        windowMs: 60000, // 1 minute
        maxRequests: 30,
        keyGenerator: (req: Request) => `api_${this.getClientId(req)}`,
        skipPaths: ['/api/health', '/api/monitoring'],
        skipMethods: ['GET'],
        message: 'Too many API requests from this client',
        headers: true,
        enabled: true
      },
      {
        id: 'webhook_callback',
        name: 'Webhook Callback Rate Limit',
        windowMs: 300000, // 5 minutes
        maxRequests: 50,
        keyGenerator: (req: Request) => `webhook_${req.ip || 'unknown'}`,
        skipCondition: (req: Request) => !req.path.includes('/callback'),
        message: 'Too many webhook callbacks from this source',
        headers: false,
        enabled: true
      },
      {
        id: 'upload',
        name: 'File Upload Rate Limit',
        windowMs: 300000, // 5 minutes
        maxRequests: 10,
        keyGenerator: (req: Request) => `upload_${this.getClientId(req)}`,
        skipCondition: (req: Request) => !req.path.includes('/upload'),
        message: 'Too many file uploads from this client',
        headers: true,
        enabled: true
      },
      {
        id: 'generation',
        name: 'Video Generation Rate Limit',
        windowMs: 3600000, // 1 hour
        maxRequests: 20,
        keyGenerator: (req: Request) => `generation_${this.getClientId(req)}`,
        skipCondition: (req: Request) => !req.path.includes('/generations') || req.method !== 'POST',
        message: 'Too many video generation requests from this client',
        headers: true,
        enabled: true
      }
    ];

    for (const rule of defaultRules) {
      this.addRule(rule);
    }
  }

  private getClientId(req: Request): string {
    return (req as any).user?.claims?.sub || req.ip || req.connection.remoteAddress || 'unknown';
  }

  // Rule management
  addRule(rule: RateLimitRule): void {
    this.rules.set(rule.id, rule);
    this.stores.set(rule.id, new Map());
    
    logger.info('Rate limit rule added', {
      ruleId: rule.id,
      name: rule.name,
      windowMs: rule.windowMs,
      maxRequests: rule.maxRequests,
      enabled: rule.enabled,
      type: 'rate_limit_rule_added'
    });
  }

  updateRule(ruleId: string, updates: Partial<RateLimitRule>): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;

    const updatedRule = { ...rule, ...updates };
    this.rules.set(ruleId, updatedRule);
    
    logger.info('Rate limit rule updated', {
      ruleId,
      updates,
      type: 'rate_limit_rule_updated'
    });

    return true;
  }

  removeRule(ruleId: string): boolean {
    const removed = this.rules.delete(ruleId);
    if (removed) {
      this.stores.delete(ruleId);
      
      logger.info('Rate limit rule removed', {
        ruleId,
        type: 'rate_limit_rule_removed'
      });
    }
    return removed;
  }

  getRules(): RateLimitRule[] {
    return Array.from(this.rules.values());
  }

  // Check if request should be limited
  private shouldApplyRule(rule: RateLimitRule, req: Request): boolean {
    if (!rule.enabled) return false;

    // Check skip paths
    if (rule.skipPaths && rule.skipPaths.some(path => req.path.startsWith(path))) {
      return false;
    }

    // Check skip methods
    if (rule.skipMethods && rule.skipMethods.includes(req.method)) {
      return false;
    }

    // Check custom skip condition
    if (rule.skipCondition && rule.skipCondition(req)) {
      return false;
    }

    return true;
  }

  // Check rate limit for a specific rule
  private checkRuleLimit(
    rule: RateLimitRule, 
    clientId: string, 
    correlationId: string
  ): { allowed: boolean; record: RateLimitRecord } {
    const store = this.stores.get(rule.id)!;
    const now = Date.now();
    const windowStart = now - rule.windowMs;

    let record = store.get(clientId);
    if (!record) {
      record = {
        requests: [],
        blocked: false,
        resetTime: new Date(now + rule.windowMs),
        totalRequests: 0,
        blockedRequests: 0,
        firstRequest: new Date(),
        lastRequest: new Date()
      };
      store.set(clientId, record);
    }

    // Remove requests outside the window
    record.requests = record.requests.filter(timestamp => timestamp > windowStart);
    
    // Update statistics
    record.totalRequests++;
    record.lastRequest = new Date();

    // Check if limit exceeded
    if (record.requests.length >= rule.maxRequests) {
      record.blocked = true;
      record.blockedRequests++;
      record.resetTime = new Date(now + rule.windowMs);
      
      logger.warn('Rate limit exceeded', {
        correlationId,
        ruleId: rule.id,
        ruleName: rule.name,
        clientId,
        requestCount: record.requests.length,
        maxRequests: rule.maxRequests,
        windowMs: rule.windowMs,
        totalRequests: record.totalRequests,
        blockedRequests: record.blockedRequests,
        type: 'rate_limit_exceeded'
      });

      // Record metrics
      metricsCollector.recordMetric('rate_limit_exceeded', 1, 'count', {
        ruleId: rule.id,
        ruleName: rule.name
      }, correlationId);

      // Alert if too many blocks
      if (record.blockedRequests > 10) {
        alertingSystem.recordError(`rate_limit_${rule.id}`);
      }

      return { allowed: false, record };
    }

    // Add current request
    record.requests.push(now);
    record.blocked = false;
    
    logger.debug('Rate limit check passed', {
      correlationId,
      ruleId: rule.id,
      clientId,
      requestCount: record.requests.length,
      maxRequests: rule.maxRequests,
      remainingRequests: rule.maxRequests - record.requests.length,
      type: 'rate_limit_passed'
    });

    // Record metrics
    metricsCollector.recordMetric('rate_limit_checked', 1, 'count', {
      ruleId: rule.id,
      allowed: 'true'
    }, correlationId);

    return { allowed: true, record };
  }

  // Main rate limiting check
  checkRateLimit(req: Request, correlationId: string): {
    allowed: boolean;
    rule?: RateLimitRule;
    record?: RateLimitRecord;
    headers: Record<string, string>;
  } {
    const headers: Record<string, string> = {};
    
    for (const rule of Array.from(this.rules.values())) {
      if (!this.shouldApplyRule(rule, req)) continue;

      const clientId = rule.keyGenerator(req);
      const { allowed, record } = this.checkRuleLimit(rule, clientId, correlationId);

      // Add headers if enabled
      if (rule.headers) {
        headers[`X-RateLimit-${rule.id}-Limit`] = rule.maxRequests.toString();
        headers[`X-RateLimit-${rule.id}-Remaining`] = Math.max(0, rule.maxRequests - record.requests.length).toString();
        headers[`X-RateLimit-${rule.id}-Reset`] = record.resetTime.toISOString();
        
        if (!allowed) {
          headers[`X-RateLimit-${rule.id}-Retry-After`] = Math.ceil((record.resetTime.getTime() - Date.now()) / 1000).toString();
        }
      }

      if (!allowed) {
        return {
          allowed: false,
          rule,
          record,
          headers
        };
      }
    }

    return {
      allowed: true,
      headers
    };
  }

  // Get rate limit status for a client
  getClientStatus(clientId: string): Array<{
    rule: RateLimitRule;
    record: RateLimitRecord;
    remaining: number;
    resetTime: Date;
  }> {
    const status: Array<{
      rule: RateLimitRule;
      record: RateLimitRecord;
      remaining: number;
      resetTime: Date;
    }> = [];

    for (const rule of Array.from(this.rules.values())) {
      const store = this.stores.get(rule.id);
      if (!store) continue;

      const record = store.get(clientId);
      if (!record) continue;

      const now = Date.now();
      const windowStart = now - rule.windowMs;
      const activeRequests = record.requests.filter(timestamp => timestamp > windowStart).length;
      const remaining = Math.max(0, rule.maxRequests - activeRequests);

      status.push({
        rule,
        record,
        remaining,
        resetTime: record.resetTime
      });
    }

    return status;
  }

  // Cleanup old records
  private cleanupOldRecords(): void {
    const now = Date.now();
    let totalCleaned = 0;

    for (const [ruleId, store] of Array.from(this.stores.entries())) {
      const rule = this.rules.get(ruleId);
      if (!rule) continue;

      const cutoffTime = now - (rule.windowMs * 2); // Keep records for 2x window time
      
      for (const [clientId, record] of Array.from(store.entries())) {
        if (record.lastRequest.getTime() < cutoffTime) {
          store.delete(clientId);
          totalCleaned++;
        }
      }
    }

    if (totalCleaned > 0) {
      logger.debug('Cleaned up old rate limit records', {
        totalCleaned,
        type: 'rate_limit_cleanup'
      });
    }
  }

  // Get statistics
  getStats(): RateLimitStats {
    let totalClients = 0;
    let blockedClients = 0;
    let totalRequests = 0;
    let blockedRequests = 0;
    const clientStats = new Map<string, {
      requests: number;
      blocked: boolean;
      lastSeen: Date;
    }>();

    for (const [ruleId, store] of Array.from(this.stores.entries())) {
      for (const [clientId, record] of Array.from(store.entries())) {
        totalClients++;
        totalRequests += record.totalRequests;
        blockedRequests += record.blockedRequests;
        
        if (record.blocked) {
          blockedClients++;
        }

        // Aggregate client stats across rules
        const existing = clientStats.get(clientId);
        if (!existing || record.lastRequest > existing.lastSeen) {
          clientStats.set(clientId, {
            requests: record.totalRequests,
            blocked: record.blocked,
            lastSeen: record.lastRequest
          });
        }
      }
    }

    // Get top clients by request count
    const topClients = Array.from(clientStats.entries())
      .map(([clientId, stats]) => ({
        clientId: clientId.length > 20 ? clientId.slice(0, 20) + '...' : clientId,
        requests: stats.requests,
        blocked: stats.blocked,
        lastSeen: stats.lastSeen
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 10);

    return {
      totalRules: this.rules.size,
      activeRules: Array.from(this.rules.values()).filter(rule => rule.enabled).length,
      totalClients: clientStats.size,
      blockedClients,
      totalRequests,
      blockedRequests,
      topClients
    };
  }

  // Reset rate limits for a client
  resetClient(clientId: string): boolean {
    let resetCount = 0;
    
    for (const store of Array.from(this.stores.values())) {
      if (store.delete(clientId)) {
        resetCount++;
      }
    }

    if (resetCount > 0) {
      logger.info('Reset rate limits for client', {
        clientId,
        rulesReset: resetCount,
        type: 'rate_limit_client_reset'
      });
    }

    return resetCount > 0;
  }

  // Clear all rate limit data
  clear(): void {
    for (const store of Array.from(this.stores.values())) {
      store.clear();
    }
    
    logger.info('Cleared all rate limit data', {
      type: 'rate_limit_clear_all'
    });
  }

  // Cleanup resources
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.clear();
  }
}

// Create singleton instance
export const rateLimitManager = new RateLimitManager();

// Main rate limiting middleware
export function rateLimitMiddleware(
  req: Request, 
  res: Response, 
  next: NextFunction
): void {
  const correlationId = (req as any).correlationId;
  const startTime = Date.now();
  
  try {
    const result = rateLimitManager.checkRateLimit(req, correlationId);
    
    // Add rate limit headers
    for (const [key, value] of Object.entries(result.headers)) {
      res.setHeader(key, value);
    }
    
    if (!result.allowed && result.rule && result.record) {
      const duration = Date.now() - startTime;
      
      logger.warn('Request blocked by rate limit', {
        correlationId,
        ruleId: result.rule.id,
        ruleName: result.rule.name,
        clientId: result.rule.keyGenerator(req),
        path: req.path,
        method: req.method,
        duration,
        retryAfter: Math.ceil((result.record.resetTime.getTime() - Date.now()) / 1000),
        type: 'rate_limit_blocked'
      });

      res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: result.rule.message,
          details: {
            rule: result.rule.name,
            limit: result.rule.maxRequests,
            window: result.rule.windowMs,
            retryAfter: result.record.resetTime.toISOString()
          },
          correlationId
        },
        success: false,
        timestamp: new Date().toISOString()
      });
    }

    const duration = Date.now() - startTime;
    
    logger.debug('Rate limit check completed', {
      correlationId,
      allowed: result.allowed,
      duration,
      rulesChecked: rateLimitManager.getRules().filter(rule => rule.enabled).length,
      type: 'rate_limit_check_completed'
    });

    next();

  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.error('Rate limit check error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      duration,
      type: 'rate_limit_error'
    });

    // Allow request to proceed on error
    next();
  }
}