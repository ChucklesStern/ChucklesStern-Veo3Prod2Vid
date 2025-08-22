import { logger } from './logger';

export interface PerformanceMetric {
  name: string;
  value: number;
  unit: 'ms' | 'count' | 'bytes' | 'percent';
  timestamp: string;
  labels?: Record<string, string>;
  correlationId?: string;
}

export interface DatabaseMetrics {
  queryCount: number;
  totalQueryTime: number;
  averageQueryTime: number;
  slowQueries: Array<{
    query: string;
    duration: number;
    timestamp: string;
  }>;
}

export interface WebhookMetrics {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  averageResponseTime: number;
  timeouts: number;
  retries: number;
}

export interface FileOperationMetrics {
  uploads: number;
  downloads: number;
  totalUploadSize: number;
  totalDownloadSize: number;
  averageUploadTime: number;
  averageDownloadTime: number;
  failures: number;
}

export interface SystemMetrics {
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
  cpuUsage: {
    user: number;
    system: number;
  };
  uptime: number;
}

class MetricsCollector {
  private metrics: Map<string, PerformanceMetric[]>;
  private databaseMetrics: DatabaseMetrics;
  private webhookMetrics: WebhookMetrics;
  private fileMetrics: FileOperationMetrics;
  private timers: Map<string, number>;
  private lastSystemMetricsCollection: number;

  constructor() {
    this.metrics = new Map();
    this.timers = new Map();
    this.lastSystemMetricsCollection = Date.now();

    this.databaseMetrics = {
      queryCount: 0,
      totalQueryTime: 0,
      averageQueryTime: 0,
      slowQueries: []
    };

    this.webhookMetrics = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      averageResponseTime: 0,
      timeouts: 0,
      retries: 0
    };

    this.fileMetrics = {
      uploads: 0,
      downloads: 0,
      totalUploadSize: 0,
      totalDownloadSize: 0,
      averageUploadTime: 0,
      averageDownloadTime: 0,
      failures: 0
    };

    // Collect system metrics every 60 seconds
    setInterval(() => {
      this.collectSystemMetrics();
    }, 60000);
  }

  // Generic metric recording
  recordMetric(name: string, value: number, unit: 'ms' | 'count' | 'bytes' | 'percent', labels?: Record<string, string>, correlationId?: string): void {
    const metric: PerformanceMetric = {
      name,
      value,
      unit,
      timestamp: new Date().toISOString(),
      labels,
      correlationId
    };

    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }

    const metricArray = this.metrics.get(name)!;
    metricArray.push(metric);

    // Keep only last 1000 metrics per type to prevent memory leaks
    if (metricArray.length > 1000) {
      metricArray.shift();
    }

    // Log significant metrics
    if (unit === 'ms' && value > 5000) {
      logger.warn(`Slow operation detected: ${name}`, {
        correlationId,
        duration: value,
        labels,
        type: 'slow_operation'
      });
    }
  }

  // Timer utilities
  startTimer(operationId: string): () => number {
    this.timers.set(operationId, Date.now());
    
    return () => {
      return this.endTimer(operationId);
    };
  }

  endTimer(operationId: string, metricName?: string, labels?: Record<string, string>, correlationId?: string): number {
    const startTime = this.timers.get(operationId);
    if (!startTime) {
      logger.warn(`Timer not found: ${operationId}`, { correlationId, type: 'timer_error' });
      return 0;
    }

    const duration = Date.now() - startTime;
    this.timers.delete(operationId);

    if (metricName) {
      this.recordMetric(metricName, duration, 'ms', labels, correlationId);
    }

    return duration;
  }

  // Database metrics
  recordDatabaseQuery(query: string, duration: number, success: boolean, correlationId?: string): void {
    this.databaseMetrics.queryCount++;
    this.databaseMetrics.totalQueryTime += duration;
    this.databaseMetrics.averageQueryTime = this.databaseMetrics.totalQueryTime / this.databaseMetrics.queryCount;

    // Track slow queries (> 1 second)
    if (duration > 1000) {
      this.databaseMetrics.slowQueries.push({
        query,
        duration,
        timestamp: new Date().toISOString()
      });

      // Keep only last 50 slow queries
      if (this.databaseMetrics.slowQueries.length > 50) {
        this.databaseMetrics.slowQueries.shift();
      }
    }

    this.recordMetric('database_query_duration', duration, 'ms', { 
      success: success.toString(),
      slow: (duration > 1000).toString()
    }, correlationId);

    logger.debug(`Database query executed in ${duration}ms`, {
      correlationId,
      duration,
      success,
      slow: duration > 1000,
      type: 'database_query'
    });
  }

  // Webhook metrics
  recordWebhookCall(url: string, duration: number, statusCode: number, isRetry: boolean = false, correlationId?: string): void {
    this.webhookMetrics.totalCalls++;
    
    if (isRetry) {
      this.webhookMetrics.retries++;
    }

    if (statusCode >= 200 && statusCode < 300) {
      this.webhookMetrics.successfulCalls++;
    } else {
      this.webhookMetrics.failedCalls++;
    }

    if (statusCode === 408 || duration >= 30000) {
      this.webhookMetrics.timeouts++;
    }

    // Update average response time
    this.webhookMetrics.averageResponseTime = 
      (this.webhookMetrics.averageResponseTime * (this.webhookMetrics.totalCalls - 1) + duration) / this.webhookMetrics.totalCalls;

    this.recordMetric('webhook_duration', duration, 'ms', {
      status: statusCode.toString(),
      success: (statusCode >= 200 && statusCode < 300).toString(),
      retry: isRetry.toString(),
      timeout: (duration >= 30000).toString()
    }, correlationId);

    logger.info(`Webhook call completed in ${duration}ms`, {
      correlationId,
      webhookUrl: url,
      duration,
      statusCode,
      isRetry,
      type: 'webhook_call'
    });
  }

  // File operation metrics
  recordFileUpload(fileSize: number, duration: number, success: boolean, correlationId?: string): void {
    this.fileMetrics.uploads++;
    
    if (success) {
      this.fileMetrics.totalUploadSize += fileSize;
      this.fileMetrics.averageUploadTime = 
        (this.fileMetrics.averageUploadTime * (this.fileMetrics.uploads - 1) + duration) / this.fileMetrics.uploads;
    } else {
      this.fileMetrics.failures++;
    }

    this.recordMetric('file_upload_duration', duration, 'ms', {
      success: success.toString(),
      sizeCategory: this.getFileSizeCategory(fileSize)
    }, correlationId);

    this.recordMetric('file_upload_size', fileSize, 'bytes', {
      success: success.toString()
    }, correlationId);
  }

  recordFileDownload(fileSize: number, duration: number, success: boolean, correlationId?: string): void {
    this.fileMetrics.downloads++;
    
    if (success) {
      this.fileMetrics.totalDownloadSize += fileSize;
      this.fileMetrics.averageDownloadTime = 
        (this.fileMetrics.averageDownloadTime * (this.fileMetrics.downloads - 1) + duration) / this.fileMetrics.downloads;
    } else {
      this.fileMetrics.failures++;
    }

    this.recordMetric('file_download_duration', duration, 'ms', {
      success: success.toString(),
      sizeCategory: this.getFileSizeCategory(fileSize)
    }, correlationId);
  }

  private getFileSizeCategory(size: number): string {
    if (size < 100 * 1024) return 'small';      // < 100KB
    if (size < 1024 * 1024) return 'medium';    // < 1MB
    if (size < 10 * 1024 * 1024) return 'large'; // < 10MB
    return 'xlarge';                             // >= 10MB
  }

  // System metrics collection
  private collectSystemMetrics(): void {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    const systemMetrics: SystemMetrics = {
      memoryUsage: memUsage,
      cpuUsage,
      uptime: process.uptime()
    };

    // Record memory metrics
    this.recordMetric('memory_rss', memUsage.rss, 'bytes');
    this.recordMetric('memory_heap_used', memUsage.heapUsed, 'bytes');
    this.recordMetric('memory_heap_total', memUsage.heapTotal, 'bytes');

    // Record CPU metrics
    this.recordMetric('cpu_user', cpuUsage.user, 'count');
    this.recordMetric('cpu_system', cpuUsage.system, 'count');

    // Record uptime
    this.recordMetric('uptime', systemMetrics.uptime, 'count');

    logger.debug('System metrics collected', {
      memoryUsageMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      uptimeHours: Math.round(systemMetrics.uptime / 3600),
      type: 'system_metrics'
    });

    this.lastSystemMetricsCollection = Date.now();
  }

  // Get aggregated metrics for monitoring
  getMetricsSummary(): {
    database: DatabaseMetrics;
    webhook: WebhookMetrics;
    fileOperations: FileOperationMetrics;
    system: SystemMetrics;
    customMetrics: Record<string, {
      count: number;
      average: number;
      min: number;
      max: number;
      latest: number;
    }>;
  } {
    const customMetrics: Record<string, any> = {};

    for (const [name, metrics] of Array.from(this.metrics.entries())) {
      if (metrics.length === 0) continue;

      const values = metrics.map((m: PerformanceMetric) => m.value);
      customMetrics[name] = {
        count: values.length,
        average: values.reduce((a: number, b: number) => a + b, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        latest: values[values.length - 1]
      };
    }

    return {
      database: this.databaseMetrics,
      webhook: this.webhookMetrics,
      fileOperations: this.fileMetrics,
      system: {
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        uptime: process.uptime()
      },
      customMetrics
    };
  }

  // Clear old metrics (call periodically to prevent memory leaks)
  clearOldMetrics(olderThanHours: number = 24): void {
    const cutoffTime = Date.now() - (olderThanHours * 60 * 60 * 1000);

    for (const [name, metrics] of Array.from(this.metrics.entries())) {
      const filteredMetrics = metrics.filter((m: PerformanceMetric) => 
        new Date(m.timestamp).getTime() > cutoffTime
      );
      this.metrics.set(name, filteredMetrics);
    }

    logger.info(`Cleared metrics older than ${olderThanHours} hours`, {
      type: 'metrics_cleanup'
    });
  }
}

// Create singleton instance
export const metricsCollector = new MetricsCollector();

// Middleware for automatic performance tracking
export function performanceMiddleware(req: any, res: any, next: any): void {
  const operationId = `${req.method}_${req.path}_${Date.now()}`;
  metricsCollector.startTimer(operationId);

  const originalSend = res.send;
  res.send = function(data: any) {
    const duration = metricsCollector.endTimer(operationId);
    
    metricsCollector.recordMetric('api_request_duration', duration, 'ms', {
      method: req.method,
      endpoint: req.path,
      statusCode: res.statusCode.toString(),
      success: (res.statusCode < 400).toString()
    }, req.correlationId);

    return originalSend.call(this, data);
  };

  next();
}