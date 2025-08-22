import { logger } from './logger';

export interface ApiMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  lastError?: {
    timestamp: string;
    error: string;
    endpoint: string;
  };
  endpointMetrics: Record<string, {
    count: number;
    successCount: number;
    failureCount: number;
    totalDuration: number;
    averageDuration: number;
    lastCalled: string;
  }>;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  environment: string;
  dependencies: {
    database: 'up' | 'down' | 'degraded';
    objectStorage: 'up' | 'down' | 'degraded';
    n8nWebhook: 'up' | 'down' | 'degraded';
  };
  metrics: ApiMetrics;
}

class ApiMonitor {
  private metrics: ApiMetrics;
  private startTime: Date;
  private healthChecks: Map<string, { status: 'up' | 'down' | 'degraded'; lastChecked: Date; error?: string }>;

  constructor() {
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      endpointMetrics: {}
    };
    this.startTime = new Date();
    this.healthChecks = new Map();
  }

  recordRequest(endpoint: string, method: string, statusCode: number, duration: number, correlationId?: string): void {
    const endpointKey = `${method} ${endpoint}`;
    
    // Update global metrics
    this.metrics.totalRequests++;
    if (statusCode < 400) {
      this.metrics.successfulRequests++;
    } else {
      this.metrics.failedRequests++;
      this.metrics.lastError = {
        timestamp: new Date().toISOString(),
        error: `HTTP ${statusCode}`,
        endpoint: endpointKey
      };
    }

    // Update average response time (simple moving average)
    const totalDuration = this.metrics.averageResponseTime * (this.metrics.totalRequests - 1) + duration;
    this.metrics.averageResponseTime = totalDuration / this.metrics.totalRequests;

    // Update endpoint-specific metrics
    if (!this.metrics.endpointMetrics[endpointKey]) {
      this.metrics.endpointMetrics[endpointKey] = {
        count: 0,
        successCount: 0,
        failureCount: 0,
        totalDuration: 0,
        averageDuration: 0,
        lastCalled: new Date().toISOString()
      };
    }

    const endpointMetric = this.metrics.endpointMetrics[endpointKey];
    endpointMetric.count++;
    endpointMetric.totalDuration += duration;
    endpointMetric.averageDuration = endpointMetric.totalDuration / endpointMetric.count;
    endpointMetric.lastCalled = new Date().toISOString();

    if (statusCode < 400) {
      endpointMetric.successCount++;
    } else {
      endpointMetric.failureCount++;
    }

    // Log metrics periodically (every 100 requests in development, 1000 in production)
    const logInterval = process.env.NODE_ENV === 'production' ? 1000 : 100;
    if (this.metrics.totalRequests % logInterval === 0) {
      this.logMetricsSummary();
    }
  }

  recordError(endpoint: string, error: any, correlationId?: string): void {
    this.metrics.lastError = {
      timestamp: new Date().toISOString(),
      error: error.message || String(error),
      endpoint
    };

    logger.error('API Error recorded', {
      correlationId,
      endpoint,
      error: error.message || String(error),
      type: 'api_error'
    });
  }

  updateDependencyHealth(service: string, status: 'up' | 'down' | 'degraded', error?: string): void {
    this.healthChecks.set(service, {
      status,
      lastChecked: new Date(),
      error
    });

    logger.info(`Dependency health updated: ${service} is ${status}`, {
      service,
      status,
      error,
      type: 'dependency_health'
    });
  }

  getHealthStatus(): HealthStatus {
    const uptime = Date.now() - this.startTime.getTime();
    
    // Determine overall health based on dependencies and error rates
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    const errorRate = this.metrics.totalRequests > 0 
      ? this.metrics.failedRequests / this.metrics.totalRequests 
      : 0;

    if (errorRate > 0.5) {
      overallStatus = 'unhealthy';
    } else if (errorRate > 0.1) {
      overallStatus = 'degraded';
    }

    // Check dependency health
    const dependencies = {
      database: this.healthChecks.get('database')?.status || 'up',
      objectStorage: this.healthChecks.get('objectStorage')?.status || 'up',
      n8nWebhook: this.healthChecks.get('n8nWebhook')?.status || 'up'
    };

    if (Object.values(dependencies).some(status => status === 'down')) {
      overallStatus = 'unhealthy';
    } else if (Object.values(dependencies).some(status => status === 'degraded')) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime,
      version: process.env.APP_VERSION || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      dependencies,
      metrics: this.metrics
    };
  }

  private logMetricsSummary(): void {
    const healthStatus = this.getHealthStatus();
    
    logger.info('API Metrics Summary', {
      totalRequests: this.metrics.totalRequests,
      successRate: this.metrics.totalRequests > 0 
        ? (this.metrics.successfulRequests / this.metrics.totalRequests * 100).toFixed(2) + '%'
        : '0%',
      averageResponseTime: Math.round(this.metrics.averageResponseTime) + 'ms',
      status: healthStatus.status,
      type: 'metrics_summary'
    });
  }

  getMetrics(): ApiMetrics {
    return { ...this.metrics };
  }

  // Performance monitoring for long-running operations
  startTimer(operation: string, correlationId?: string): () => number {
    const startTime = Date.now();
    
    logger.debug(`Started: ${operation}`, {
      correlationId,
      operation,
      type: 'timer_start'
    });

    return () => {
      const duration = Date.now() - startTime;
      logger.debug(`Completed: ${operation} in ${duration}ms`, {
        correlationId,
        operation,
        duration,
        type: 'timer_end'
      });
      return duration;
    };
  }

  // Webhook monitoring
  recordWebhookCall(url: string, duration: number, statusCode: number, correlationId?: string): void {
    const success = statusCode >= 200 && statusCode < 300;
    
    if (!success) {
      this.updateDependencyHealth('n8nWebhook', statusCode >= 500 ? 'down' : 'degraded');
    } else {
      this.updateDependencyHealth('n8nWebhook', 'up');
    }

    logger.info(`Webhook call ${success ? 'succeeded' : 'failed'}`, {
      correlationId,
      webhookUrl: url,
      statusCode,
      duration,
      success,
      type: 'webhook_monitoring'
    });
  }
}

// Create singleton instance
export const apiMonitor = new ApiMonitor();

// Express middleware for API monitoring
export function monitoringMiddleware(req: any, res: any, next: any): void {
  const start = Date.now();
  const originalJson = res.json;

  res.json = function(data: any) {
    const duration = Date.now() - start;
    const endpoint = req.route?.path || req.path;
    
    apiMonitor.recordRequest(endpoint, req.method, res.statusCode, duration, req.correlationId);
    
    logger.apiResponse(req.method, endpoint, res.statusCode, duration, {
      correlationId: req.correlationId,
      userId: req.user?.claims?.sub,
      responseSize: JSON.stringify(data).length
    });

    return originalJson.call(this, data);
  };

  logger.apiRequest(req.method, req.path, {
    correlationId: req.correlationId,
    userId: req.user?.claims?.sub,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection.remoteAddress
  });

  next();
}