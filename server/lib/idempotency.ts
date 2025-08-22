import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';
import { metricsCollector } from './metrics';

export interface IdempotencyConfig {
  enabled: boolean;
  ttlMs: number;
  maxKeys: number;
  keyHeader: string;
  skipMethods: string[];
  skipPaths: string[];
  hashRequestBody: boolean;
  includeUserId: boolean;
}

export interface IdempotencyRecord {
  key: string;
  correlationId: string;
  requestHash: string;
  response: {
    statusCode: number;
    body: any;
    headers: Record<string, string>;
  };
  timestamp: Date;
  ttl: number;
  hitCount: number;
  lastAccessed: Date;
}

export interface IdempotencyStats {
  totalKeys: number;
  hitRate: number;
  averageAge: number;
  oldestKey: Date | null;
  newestKey: Date | null;
  totalHits: number;
  totalMisses: number;
}

class IdempotencyManager {
  private config: IdempotencyConfig;
  private cache: Map<string, IdempotencyRecord>;
  private stats: {
    hits: number;
    misses: number;
    evictions: number;
  };
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.config = {
      enabled: true,
      ttlMs: 300000, // 5 minutes
      maxKeys: 10000, // Maximum number of keys to store
      keyHeader: 'idempotency-key',
      skipMethods: ['GET', 'HEAD', 'OPTIONS'],
      skipPaths: ['/api/health', '/api/monitoring'],
      hashRequestBody: true,
      includeUserId: true
    };

    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };

    // Cleanup expired records every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredRecords();
    }, 300000);
  }

  updateConfig(newConfig: Partial<IdempotencyConfig>): void {
    this.config = { ...this.config, ...newConfig };
    
    logger.info('Idempotency configuration updated', {
      config: this.config,
      type: 'idempotency_config_updated'
    });
  }

  getConfig(): IdempotencyConfig {
    return { ...this.config };
  }

  // Generate idempotency key from request
  private generateKeyFromRequest(req: Request, correlationId: string): string {
    const components: string[] = [];
    
    // Add endpoint and method
    components.push(req.method);
    components.push(req.path);
    
    // Add user ID if enabled and available
    if (this.config.includeUserId && (req as any).user?.claims?.sub) {
      components.push((req as any).user.claims.sub);
    }
    
    // Add request body hash if enabled
    if (this.config.hashRequestBody && req.body) {
      const bodyHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(req.body))
        .digest('hex');
      components.push(bodyHash);
    }
    
    // Add query parameters
    if (Object.keys(req.query).length > 0) {
      const queryHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(req.query))
        .digest('hex');
      components.push(queryHash);
    }
    
    const keyString = components.join('|');
    const key = crypto.createHash('sha256').update(keyString).digest('hex');
    
    logger.debug('Generated idempotency key from request', {
      correlationId,
      method: req.method,
      path: req.path,
      hasBody: !!req.body,
      hasQuery: Object.keys(req.query).length > 0,
      keyComponents: components.length,
      key: key.slice(0, 16) + '...', // Log only first 16 chars
      type: 'idempotency_key_generated'
    });
    
    return key;
  }

  // Create request hash for validation
  private createRequestHash(req: Request): string {
    const requestData = {
      method: req.method,
      path: req.path,
      body: req.body,
      query: req.query,
      userId: (req as any).user?.claims?.sub
    };
    
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(requestData))
      .digest('hex');
  }

  // Check if request should be processed for idempotency
  private shouldProcessRequest(req: Request): boolean {
    // Skip if disabled
    if (!this.config.enabled) {
      return false;
    }
    
    // Skip certain methods
    if (this.config.skipMethods.includes(req.method)) {
      return false;
    }
    
    // Skip certain paths
    if (this.config.skipPaths.some(path => req.path.startsWith(path))) {
      return false;
    }
    
    return true;
  }

  // Store response for idempotency
  storeResponse(
    key: string, 
    response: { statusCode: number; body: any; headers: Record<string, string> },
    requestHash: string,
    correlationId: string
  ): void {
    if (!this.config.enabled) return;

    // Check if we need to evict old records
    if (this.cache.size >= this.config.maxKeys) {
      this.evictOldestRecord();
    }

    const record: IdempotencyRecord = {
      key,
      correlationId,
      requestHash,
      response,
      timestamp: new Date(),
      ttl: this.config.ttlMs,
      hitCount: 0,
      lastAccessed: new Date()
    };

    this.cache.set(key, record);

    logger.debug('Stored idempotency response', {
      correlationId,
      key: key.slice(0, 16) + '...',
      statusCode: response.statusCode,
      ttlMs: this.config.ttlMs,
      cacheSize: this.cache.size,
      type: 'idempotency_response_stored'
    });

    metricsCollector.recordMetric('idempotency_store', 1, 'count', {
      statusCode: response.statusCode.toString()
    }, correlationId);
  }

  // Retrieve cached response
  getCachedResponse(
    key: string, 
    requestHash: string, 
    correlationId: string
  ): IdempotencyRecord | null {
    if (!this.config.enabled) return null;

    const record = this.cache.get(key);
    if (!record) {
      this.stats.misses++;
      
      logger.debug('Idempotency cache miss', {
        correlationId,
        key: key.slice(0, 16) + '...',
        cacheSize: this.cache.size,
        type: 'idempotency_cache_miss'
      });

      metricsCollector.recordMetric('idempotency_miss', 1, 'count', {}, correlationId);
      return null;
    }

    // Check if record is expired
    const age = Date.now() - record.timestamp.getTime();
    if (age > record.ttl) {
      this.cache.delete(key);
      this.stats.misses++;
      
      logger.debug('Idempotency cache expired', {
        correlationId,
        key: key.slice(0, 16) + '...',
        age,
        ttl: record.ttl,
        type: 'idempotency_cache_expired'
      });

      metricsCollector.recordMetric('idempotency_expired', 1, 'count', {}, correlationId);
      return null;
    }

    // Validate request hash to ensure it's the same request
    if (record.requestHash !== requestHash) {
      this.stats.misses++;
      
      logger.warn('Idempotency request hash mismatch', {
        correlationId,
        key: key.slice(0, 16) + '...',
        expectedHash: record.requestHash.slice(0, 16) + '...',
        actualHash: requestHash.slice(0, 16) + '...',
        type: 'idempotency_hash_mismatch'
      });

      metricsCollector.recordMetric('idempotency_hash_mismatch', 1, 'count', {}, correlationId);
      return null;
    }

    // Update access statistics
    record.hitCount++;
    record.lastAccessed = new Date();
    this.stats.hits++;

    logger.info('Idempotency cache hit', {
      correlationId,
      originalCorrelationId: record.correlationId,
      key: key.slice(0, 16) + '...',
      age,
      hitCount: record.hitCount,
      statusCode: record.response.statusCode,
      type: 'idempotency_cache_hit'
    });

    metricsCollector.recordMetric('idempotency_hit', 1, 'count', {
      statusCode: record.response.statusCode.toString(),
      age: Math.floor(age / 1000).toString()
    }, correlationId);

    return record;
  }

  // Evict oldest record when cache is full
  private evictOldestRecord(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    for (const [key, record] of Array.from(this.cache.entries())) {
      if (record.lastAccessed.getTime() < oldestTime) {
        oldestTime = record.lastAccessed.getTime();
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
      
      logger.debug('Evicted oldest idempotency record', {
        key: oldestKey.slice(0, 16) + '...',
        age: Date.now() - oldestTime,
        cacheSize: this.cache.size,
        type: 'idempotency_eviction'
      });
    }
  }

  // Cleanup expired records
  private cleanupExpiredRecords(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, record] of Array.from(this.cache.entries())) {
      const age = now - record.timestamp.getTime();
      if (age > record.ttl) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug('Cleaned up expired idempotency records', {
        cleanedCount,
        remainingCount: this.cache.size,
        type: 'idempotency_cleanup'
      });
    }

    metricsCollector.recordMetric('idempotency_cleanup', cleanedCount, 'count');
  }

  // Get statistics
  getStats(): IdempotencyStats {
    const records = Array.from(this.cache.values());
    const now = Date.now();
    
    let totalAge = 0;
    let oldestTime = now;
    let newestTime = 0;
    let totalHits = 0;

    for (const record of records) {
      const age = now - record.timestamp.getTime();
      totalAge += age;
      totalHits += record.hitCount;
      
      if (record.timestamp.getTime() < oldestTime) {
        oldestTime = record.timestamp.getTime();
      }
      if (record.timestamp.getTime() > newestTime) {
        newestTime = record.timestamp.getTime();
      }
    }

    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? (this.stats.hits / totalRequests) * 100 : 0;
    const averageAge = records.length > 0 ? totalAge / records.length : 0;

    return {
      totalKeys: this.cache.size,
      hitRate,
      averageAge,
      oldestKey: records.length > 0 ? new Date(oldestTime) : null,
      newestKey: records.length > 0 ? new Date(newestTime) : null,
      totalHits: totalHits,
      totalMisses: this.stats.misses
    };
  }

  // Clear all cached records
  clear(): void {
    const previousSize = this.cache.size;
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
    
    logger.info('Cleared idempotency cache', {
      previousSize,
      type: 'idempotency_cache_cleared'
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
export const idempotencyManager = new IdempotencyManager();

// Middleware for idempotency handling
export function idempotencyMiddleware(
  req: Request, 
  res: Response, 
  next: NextFunction
): void {
  const correlationId = (req as any).correlationId;
  
  // Check if this request should be processed for idempotency
  if (!idempotencyManager['shouldProcessRequest'](req)) {
    return next();
  }

  // Get idempotency key from header or generate from request
  let idempotencyKey = req.headers[idempotencyManager.getConfig().keyHeader] as string;
  
  if (!idempotencyKey) {
    // Generate key from request if no header provided
    idempotencyKey = idempotencyManager['generateKeyFromRequest'](req, correlationId);
    
    logger.debug('Generated idempotency key for request', {
      correlationId,
      method: req.method,
      path: req.path,
      key: idempotencyKey.slice(0, 16) + '...',
      type: 'idempotency_key_auto_generated'
    });
  }

  // Create request hash for validation
  const requestHash = idempotencyManager['createRequestHash'](req);

  // Check for cached response
  const cachedRecord = idempotencyManager.getCachedResponse(idempotencyKey, requestHash, correlationId);
  
  if (cachedRecord) {
    // Return cached response
    res.set(cachedRecord.response.headers);
    res.set('X-Idempotency-Hit', 'true');
    res.set('X-Idempotency-Key', idempotencyKey.slice(0, 16) + '...');
    res.set('X-Original-Correlation-ID', cachedRecord.correlationId);
    
    res.status(cachedRecord.response.statusCode).json(cachedRecord.response.body);
    return;
  }

  // Store idempotency info for response storage
  (req as any).idempotencyKey = idempotencyKey;
  (req as any).idempotencyRequestHash = requestHash;

  // Intercept response to store it
  const originalJson = res.json;
  const originalSend = res.send;
  
  res.json = function(data: any) {
    // Store response in idempotency cache
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(res.getHeaders())) {
      if (typeof value === 'string') {
        responseHeaders[key] = value;
      }
    }

    idempotencyManager.storeResponse(
      idempotencyKey,
      {
        statusCode: res.statusCode,
        body: data,
        headers: responseHeaders
      },
      requestHash,
      correlationId
    );

    // Add idempotency headers
    res.set('X-Idempotency-Hit', 'false');
    res.set('X-Idempotency-Key', idempotencyKey.slice(0, 16) + '...');

    return originalJson.call(this, data);
  };

  res.send = function(data: any) {
    // Store response in idempotency cache for non-JSON responses
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(res.getHeaders())) {
      if (typeof value === 'string') {
        responseHeaders[key] = value;
      }
    }

    idempotencyManager.storeResponse(
      idempotencyKey,
      {
        statusCode: res.statusCode,
        body: data,
        headers: responseHeaders
      },
      requestHash,
      correlationId
    );

    // Add idempotency headers
    res.set('X-Idempotency-Hit', 'false');
    res.set('X-Idempotency-Key', idempotencyKey.slice(0, 16) + '...');

    return originalSend.call(this, data);
  };

  next();
}