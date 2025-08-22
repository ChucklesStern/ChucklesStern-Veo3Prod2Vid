import { logger } from './logger';
import { metricsCollector } from './metrics';

export interface AlertRule {
  id: string;
  name: string;
  condition: 'error_rate' | 'response_time' | 'webhook_failures' | 'system_health';
  threshold: number;
  timeWindow: number; // in minutes
  enabled: boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
}

export interface Alert {
  id: string;
  ruleId: string;
  name: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  value: number;
  threshold: number;
  timestamp: string;
  status: 'firing' | 'resolved';
  correlationIds?: string[];
  metadata?: Record<string, any>;
}

export interface AlertingConfig {
  enableConsoleAlerts: boolean;
  enableWebhookAlerts: boolean;
  webhookUrl?: string;
  errorRateThreshold: number;
  responseTimeThreshold: number;
  webhookFailureThreshold: number;
  memoryUsageThreshold: number;
}

class AlertingSystem {
  private rules: Map<string, AlertRule>;
  private activeAlerts: Map<string, Alert>;
  private alertHistory: Alert[];
  private config: AlertingConfig;
  private errorCounts: Map<string, number[]>; // endpoint -> timestamps
  private responseTimes: Map<string, number[]>; // endpoint -> response times
  private webhookFailures: number[];
  private lastSystemCheck: number;

  constructor() {
    this.rules = new Map();
    this.activeAlerts = new Map();
    this.alertHistory = [];
    this.errorCounts = new Map();
    this.responseTimes = new Map();
    this.webhookFailures = [];
    this.lastSystemCheck = Date.now();

    this.config = {
      enableConsoleAlerts: true,
      enableWebhookAlerts: false,
      errorRateThreshold: 10, // 10% error rate
      responseTimeThreshold: 5000, // 5 seconds
      webhookFailureThreshold: 3, // 3 consecutive failures
      memoryUsageThreshold: 85 // 85% memory usage
    };

    this.initializeDefaultRules();
    this.startMonitoring();
  }

  private initializeDefaultRules(): void {
    const defaultRules: AlertRule[] = [
      {
        id: 'high_error_rate',
        name: 'High Error Rate',
        condition: 'error_rate',
        threshold: this.config.errorRateThreshold,
        timeWindow: 5,
        enabled: true,
        severity: 'high',
        description: 'API error rate exceeds threshold'
      },
      {
        id: 'slow_response_time',
        name: 'Slow Response Time',
        condition: 'response_time',
        threshold: this.config.responseTimeThreshold,
        timeWindow: 5,
        enabled: true,
        severity: 'medium',
        description: 'API response time exceeds threshold'
      },
      {
        id: 'webhook_failures',
        name: 'Webhook Failures',
        condition: 'webhook_failures',
        threshold: this.config.webhookFailureThreshold,
        timeWindow: 10,
        enabled: true,
        severity: 'critical',
        description: 'Multiple webhook failures detected'
      },
      {
        id: 'system_health',
        name: 'System Health',
        condition: 'system_health',
        threshold: this.config.memoryUsageThreshold,
        timeWindow: 5,
        enabled: true,
        severity: 'high',
        description: 'System resource usage is high'
      }
    ];

    defaultRules.forEach(rule => this.rules.set(rule.id, rule));
  }

  private startMonitoring(): void {
    // Check alerts every minute
    setInterval(() => {
      this.evaluateAlerts();
    }, 60000);

    // Clean up old data every hour
    setInterval(() => {
      this.cleanupOldData();
    }, 3600000);
  }

  // Record error for error rate tracking
  recordError(endpoint: string, timestamp: number = Date.now()): void {
    if (!this.errorCounts.has(endpoint)) {
      this.errorCounts.set(endpoint, []);
    }
    
    this.errorCounts.get(endpoint)!.push(timestamp);
  }

  // Record response time
  recordResponseTime(endpoint: string, duration: number): void {
    if (!this.responseTimes.has(endpoint)) {
      this.responseTimes.set(endpoint, []);
    }
    
    this.responseTimes.get(endpoint)!.push(duration);
    
    // Keep only last 100 response times per endpoint
    const times = this.responseTimes.get(endpoint)!;
    if (times.length > 100) {
      times.shift();
    }
  }

  // Record webhook failure
  recordWebhookFailure(timestamp: number = Date.now()): void {
    this.webhookFailures.push(timestamp);
    
    // Keep only last 20 failures
    if (this.webhookFailures.length > 20) {
      this.webhookFailures.shift();
    }
  }

  private evaluateAlerts(): void {
    for (const [ruleId, rule] of Array.from(this.rules.entries())) {
      if (!rule.enabled) continue;

      const alertValue = this.calculateAlertValue(rule);
      if (alertValue === null) continue;

      const isTriggered = this.isAlertTriggered(rule, alertValue);
      const existingAlert = this.activeAlerts.get(ruleId);

      if (isTriggered && !existingAlert) {
        // Fire new alert
        this.fireAlert(rule, alertValue);
      } else if (!isTriggered && existingAlert) {
        // Resolve existing alert
        this.resolveAlert(ruleId);
      }
    }
  }

  private calculateAlertValue(rule: AlertRule): number | null {
    const now = Date.now();
    const windowMs = rule.timeWindow * 60 * 1000;
    const cutoffTime = now - windowMs;

    switch (rule.condition) {
      case 'error_rate':
        return this.calculateErrorRate(cutoffTime);
      
      case 'response_time':
        return this.calculateAverageResponseTime(cutoffTime);
      
      case 'webhook_failures':
        return this.countRecentWebhookFailures(cutoffTime);
      
      case 'system_health':
        return this.calculateMemoryUsagePercent();
      
      default:
        return null;
    }
  }

  private calculateErrorRate(cutoffTime: number): number {
    let totalRequests = 0;
    let totalErrors = 0;

    for (const [endpoint, errors] of Array.from(this.errorCounts.entries())) {
      const recentErrors = errors.filter((timestamp: number) => timestamp > cutoffTime);
      totalErrors += recentErrors.length;
      
      // Estimate total requests (errors are subset of total requests)
      // This is simplified - in production you'd track all requests
      totalRequests += recentErrors.length * 10; // Assume error rate is roughly 10% of requests
    }

    return totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
  }

  private calculateAverageResponseTime(cutoffTime: number): number {
    let totalTime = 0;
    let totalCount = 0;

    for (const times of Array.from(this.responseTimes.values())) {
      totalTime += times.reduce((sum: number, time: number) => sum + time, 0);
      totalCount += times.length;
    }

    return totalCount > 0 ? totalTime / totalCount : 0;
  }

  private countRecentWebhookFailures(cutoffTime: number): number {
    return this.webhookFailures.filter(timestamp => timestamp > cutoffTime).length;
  }

  private calculateMemoryUsagePercent(): number {
    const memUsage = process.memoryUsage();
    return (memUsage.heapUsed / memUsage.heapTotal) * 100;
  }

  private isAlertTriggered(rule: AlertRule, value: number): boolean {
    return value >= rule.threshold;
  }

  private fireAlert(rule: AlertRule, value: number): void {
    const alert: Alert = {
      id: `${rule.id}_${Date.now()}`,
      ruleId: rule.id,
      name: rule.name,
      severity: rule.severity,
      message: `${rule.description}. Current value: ${value.toFixed(2)}, Threshold: ${rule.threshold}`,
      value,
      threshold: rule.threshold,
      timestamp: new Date().toISOString(),
      status: 'firing',
      metadata: {
        condition: rule.condition,
        timeWindow: rule.timeWindow
      }
    };

    this.activeAlerts.set(rule.id, alert);
    this.alertHistory.push(alert);

    // Keep only last 1000 alerts in history
    if (this.alertHistory.length > 1000) {
      this.alertHistory.shift();
    }

    this.sendAlert(alert);

    logger.error(`ALERT FIRED: ${alert.name}`, {
      alertId: alert.id,
      severity: alert.severity,
      value: alert.value,
      threshold: alert.threshold,
      message: alert.message,
      type: 'alert_fired'
    });
  }

  private resolveAlert(ruleId: string): void {
    const alert = this.activeAlerts.get(ruleId);
    if (!alert) return;

    alert.status = 'resolved';
    this.activeAlerts.delete(ruleId);

    logger.info(`ALERT RESOLVED: ${alert.name}`, {
      alertId: alert.id,
      duration: Date.now() - new Date(alert.timestamp).getTime(),
      type: 'alert_resolved'
    });

    this.sendAlertResolution(alert);
  }

  private sendAlert(alert: Alert): void {
    if (this.config.enableConsoleAlerts) {
      console.error(`🚨 [${alert.severity.toUpperCase()}] ${alert.name}: ${alert.message}`);
    }

    if (this.config.enableWebhookAlerts && this.config.webhookUrl) {
      this.sendWebhookAlert(alert).catch(error => {
        logger.error('Failed to send webhook alert', {
          alertId: alert.id,
          error: error.message,
          type: 'alert_webhook_error'
        });
      });
    }
  }

  private sendAlertResolution(alert: Alert): void {
    if (this.config.enableConsoleAlerts) {
      console.info(`✅ [RESOLVED] ${alert.name}`);
    }
  }

  private async sendWebhookAlert(alert: Alert): Promise<void> {
    if (!this.config.webhookUrl) return;

    const payload = {
      alert,
      timestamp: new Date().toISOString(),
      service: 'veo3vidagent-api'
    };

    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Webhook alert failed: ${response.status} ${response.statusText}`);
    }
  }

  private cleanupOldData(): void {
    const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago

    // Clean up error counts
    for (const [endpoint, errors] of Array.from(this.errorCounts.entries())) {
      const recentErrors = errors.filter((timestamp: number) => timestamp > cutoffTime);
      this.errorCounts.set(endpoint, recentErrors);
    }

    // Clean up webhook failures
    this.webhookFailures = this.webhookFailures.filter(timestamp => timestamp > cutoffTime);

    logger.debug('Cleaned up old alerting data', {
      cutoffTime: new Date(cutoffTime).toISOString(),
      type: 'alerting_cleanup'
    });
  }

  // Public API methods
  getActiveAlerts(): Alert[] {
    return Array.from(this.activeAlerts.values());
  }

  getAlertHistory(limit: number = 50): Alert[] {
    return this.alertHistory.slice(-limit);
  }

  getAlertRules(): AlertRule[] {
    return Array.from(this.rules.values());
  }

  updateRule(ruleId: string, updates: Partial<AlertRule>): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;

    const updatedRule = { ...rule, ...updates };
    this.rules.set(ruleId, updatedRule);

    logger.info('Alert rule updated', {
      ruleId,
      updates,
      type: 'alert_rule_updated'
    });

    return true;
  }

  addRule(rule: AlertRule): void {
    this.rules.set(rule.id, rule);
    
    logger.info('Alert rule added', {
      ruleId: rule.id,
      rule,
      type: 'alert_rule_added'
    });
  }

  removeRule(ruleId: string): boolean {
    const removed = this.rules.delete(ruleId);
    
    if (removed) {
      // Resolve any active alert for this rule
      this.resolveAlert(ruleId);
      
      logger.info('Alert rule removed', {
        ruleId,
        type: 'alert_rule_removed'
      });
    }

    return removed;
  }

  updateConfig(config: Partial<AlertingConfig>): void {
    this.config = { ...this.config, ...config };
    
    logger.info('Alerting configuration updated', {
      config: this.config,
      type: 'alerting_config_updated'
    });
  }

  getStatus(): {
    activeAlerts: number;
    totalRules: number;
    enabledRules: number;
    recentAlerts: number;
    config: AlertingConfig;
  } {
    const recentAlerts = this.alertHistory.filter(
      alert => Date.now() - new Date(alert.timestamp).getTime() < 24 * 60 * 60 * 1000
    ).length;

    return {
      activeAlerts: this.activeAlerts.size,
      totalRules: this.rules.size,
      enabledRules: Array.from(this.rules.values()).filter(rule => rule.enabled).length,
      recentAlerts,
      config: this.config
    };
  }
}

// Create singleton instance
export const alertingSystem = new AlertingSystem();

// Middleware to integrate with API monitoring
export function alertingMiddleware(req: any, res: any, next: any): void {
  const originalSend = res.send;
  
  res.send = function(data: any) {
    const duration = Date.now() - req.startTime;
    
    // Record response time
    alertingSystem.recordResponseTime(req.path, duration);
    
    // Record error if status >= 400
    if (res.statusCode >= 400) {
      alertingSystem.recordError(req.path);
    }

    return originalSend.call(this, data);
  };

  req.startTime = Date.now();
  next();
}