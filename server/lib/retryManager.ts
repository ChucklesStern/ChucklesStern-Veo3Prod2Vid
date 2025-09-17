import { logger } from './logger';
import { metricsCollector } from './metrics';
import { alertingSystem } from './alerting';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterMs: number;
  retryableErrors: string[];
  retryableStatusCodes: number[];
  timeoutMs: number;
  enableCircuitBreaker: boolean;
  circuitBreakerThreshold: number;
  circuitBreakerWindowMs: number;
}

export interface RetryAttempt {
  attempt: number;
  delay: number;
  timestamp: Date;
  error?: string;
  statusCode?: number;
  duration: number;
}

export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: RetryAttempt[];
  totalDuration: number;
  finalAttempt: number;
  circuitBreakerTripped?: boolean;
}

export interface CircuitBreakerState {
  isOpen: boolean;
  failures: number;
  lastFailureTime: Date;
  nextAttemptTime: Date;
  totalRequests: number;
  failureRate: number;
}

class RetryManager {
  private config: RetryConfig;
  private circuitBreakers: Map<string, CircuitBreakerState>;
  private retryStats: Map<string, {
    totalAttempts: number;
    successfulRetries: number;
    failedRetries: number;
    averageAttempts: number;
  }>;

  constructor() {
    this.config = {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
      jitterMs: 100,
      retryableErrors: [
        'ECONNRESET',
        'ENOTFOUND',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ECONNABORTED',
        'NETWORK_ERROR',
        'TIMEOUT_ERROR'
      ],
      retryableStatusCodes: [408, 429, 500, 502, 503, 504],
      timeoutMs: 30000,
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 10, // 10 failures in window (increased from 5)
      circuitBreakerWindowMs: 600000 // 10 minutes (increased from 5 minutes)
    };

    this.circuitBreakers = new Map();
    this.retryStats = new Map();
  }

  updateConfig(newConfig: Partial<RetryConfig>): void {
    this.config = { ...this.config, ...newConfig };
    
    logger.info('Retry configuration updated', {
      config: this.config,
      type: 'retry_config_updated'
    });
  }

  getConfig(): RetryConfig {
    return { ...this.config };
  }

  // Calculate delay with exponential backoff and jitter
  private calculateDelay(attempt: number): number {
    const exponentialDelay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1);
    const jitter = Math.random() * this.config.jitterMs;
    const delay = Math.min(exponentialDelay + jitter, this.config.maxDelayMs);
    
    return Math.floor(delay);
  }

  // Check if error is retryable
  private isRetryableError(error: any): boolean {
    if (!error) return false;
    
    const errorCode = error.code || error.name || '';
    const statusCode = error.status || error.statusCode || 0;
    
    return this.config.retryableErrors.includes(errorCode) ||
           this.config.retryableStatusCodes.includes(statusCode);
  }

  // Circuit breaker implementation
  private getCircuitBreakerState(operationId: string): CircuitBreakerState {
    let state = this.circuitBreakers.get(operationId);
    
    if (!state) {
      state = {
        isOpen: false,
        failures: 0,
        lastFailureTime: new Date(0),
        nextAttemptTime: new Date(0),
        totalRequests: 0,
        failureRate: 0
      };
      this.circuitBreakers.set(operationId, state);
    }
    
    return state;
  }

  private updateCircuitBreaker(operationId: string, success: boolean): void {
    if (!this.config.enableCircuitBreaker) return;
    
    const state = this.getCircuitBreakerState(operationId);
    const now = new Date();
    
    state.totalRequests++;
    
    if (success) {
      // Reset on success
      if (state.isOpen) {
        logger.info('Circuit breaker closed after successful request', {
          operationId,
          previousFailures: state.failures,
          type: 'circuit_breaker_closed'
        });
      }
      
      state.failures = 0;
      state.isOpen = false;
      state.nextAttemptTime = new Date(0);
    } else {
      state.failures++;
      state.lastFailureTime = now;
      
      // Calculate failure rate within window
      const windowStart = now.getTime() - this.config.circuitBreakerWindowMs;
      if (state.lastFailureTime.getTime() > windowStart) {
        state.failureRate = state.failures / Math.max(1, state.totalRequests);
      }
      
      // Open circuit breaker if threshold exceeded
      if (state.failures >= this.config.circuitBreakerThreshold) {
        state.isOpen = true;
        state.nextAttemptTime = new Date(now.getTime() + this.config.circuitBreakerWindowMs);
        
        logger.warn('Circuit breaker opened due to failures', {
          operationId,
          failures: state.failures,
          threshold: this.config.circuitBreakerThreshold,
          failureRate: state.failureRate,
          nextAttemptTime: state.nextAttemptTime.toISOString(),
          type: 'circuit_breaker_opened'
        });
        
        alertingSystem.recordError(`circuit_breaker_${operationId}`);
      }
    }
  }

  private isCircuitBreakerOpen(operationId: string): boolean {
    if (!this.config.enableCircuitBreaker) return false;
    
    const state = this.getCircuitBreakerState(operationId);
    
    if (!state.isOpen) return false;
    
    // Check if it's time to attempt again
    if (new Date() > state.nextAttemptTime) {
      logger.info('Circuit breaker attempting half-open state', {
        operationId,
        failures: state.failures,
        type: 'circuit_breaker_half_open'
      });
      return false;
    }
    
    return true;
  }

  // Main retry method
  async retry<T>(
    operation: () => Promise<T>,
    operationId: string,
    correlationId?: string,
    customConfig?: Partial<RetryConfig>
  ): Promise<RetryResult<T>> {
    const config = { ...this.config, ...customConfig };
    const attempts: RetryAttempt[] = [];
    const startTime = Date.now();
    
    logger.info('Starting retry operation', {
      correlationId,
      operationId,
      maxRetries: config.maxRetries,
      timeoutMs: config.timeoutMs,
      type: 'retry_operation_start'
    });

    // Check circuit breaker
    if (this.isCircuitBreakerOpen(operationId)) {
      const circuitState = this.getCircuitBreakerState(operationId);
      
      logger.warn('Operation blocked by circuit breaker', {
        correlationId,
        operationId,
        failures: circuitState.failures,
        nextAttemptTime: circuitState.nextAttemptTime.toISOString(),
        type: 'retry_circuit_breaker_blocked'
      });

      return {
        success: false,
        error: new Error(`Circuit breaker is open for ${operationId}`),
        attempts: [],
        totalDuration: 0,
        finalAttempt: 0,
        circuitBreakerTripped: true
      };
    }

    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
      const attemptStart = Date.now();
      
      try {
        logger.debug('Executing retry attempt', {
          correlationId,
          operationId,
          attempt,
          maxRetries: config.maxRetries,
          type: 'retry_attempt_start'
        });

        // Create timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Operation timeout after ${config.timeoutMs}ms`));
          }, config.timeoutMs);
        });

        // Race between operation and timeout
        const result = await Promise.race([operation(), timeoutPromise]);
        const duration = Date.now() - attemptStart;
        
        // Record successful attempt
        attempts.push({
          attempt,
          delay: 0,
          timestamp: new Date(),
          duration
        });

        // Update circuit breaker
        this.updateCircuitBreaker(operationId, true);

        // Update retry statistics
        this.updateRetryStats(operationId, attempts.length, true);

        const totalDuration = Date.now() - startTime;
        
        logger.info('Retry operation succeeded', {
          correlationId,
          operationId,
          attempt,
          duration,
          totalDuration,
          type: 'retry_operation_success'
        });

        // Record metrics
        metricsCollector.recordMetric('retry_success', 1, 'count', {
          operationId,
          finalAttempt: attempt.toString(),
          totalDuration: totalDuration.toString()
        }, correlationId);

        return {
          success: true,
          data: result,
          attempts,
          totalDuration,
          finalAttempt: attempt
        };

      } catch (error) {
        const duration = Date.now() - attemptStart;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const statusCode = (error as any)?.status || (error as any)?.statusCode;
        
        // Record failed attempt
        attempts.push({
          attempt,
          delay: 0,
          timestamp: new Date(),
          error: errorMessage,
          statusCode,
          duration
        });

        logger.warn('Retry attempt failed', {
          correlationId,
          operationId,
          attempt,
          error: errorMessage,
          statusCode,
          duration,
          type: 'retry_attempt_failed'
        });

        // Check if this is the final attempt
        if (attempt > config.maxRetries) {
          // Update circuit breaker
          this.updateCircuitBreaker(operationId, false);

          // Update retry statistics
          this.updateRetryStats(operationId, attempts.length, false);

          const totalDuration = Date.now() - startTime;
          
          logger.error('Retry operation failed after all attempts', {
            correlationId,
            operationId,
            totalAttempts: attempts.length,
            totalDuration,
            finalError: errorMessage,
            type: 'retry_operation_failed'
          });

          // Record metrics
          metricsCollector.recordMetric('retry_failed', 1, 'count', {
            operationId,
            totalAttempts: attempts.length.toString(),
            totalDuration: totalDuration.toString()
          }, correlationId);

          return {
            success: false,
            error: error instanceof Error ? error : new Error(errorMessage),
            attempts,
            totalDuration,
            finalAttempt: attempt
          };
        }

        // Check if error is retryable
        if (!this.isRetryableError(error)) {
          logger.warn('Non-retryable error encountered', {
            correlationId,
            operationId,
            attempt,
            error: errorMessage,
            statusCode,
            type: 'retry_non_retryable_error'
          });

          // Update circuit breaker
          this.updateCircuitBreaker(operationId, false);

          // Update retry statistics  
          this.updateRetryStats(operationId, attempts.length, false);

          return {
            success: false,
            error: error instanceof Error ? error : new Error(errorMessage),
            attempts,
            totalDuration: Date.now() - startTime,
            finalAttempt: attempt
          };
        }

        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt);
        attempts[attempts.length - 1].delay = delay;
        
        logger.debug('Waiting before next retry attempt', {
          correlationId,
          operationId,
          attempt,
          nextAttempt: attempt + 1,
          delayMs: delay,
          type: 'retry_delay_start'
        });

        // Wait before next attempt
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // This should never be reached due to the loop logic above
    throw new Error('Unexpected end of retry loop');
  }

  // Update retry statistics
  private updateRetryStats(operationId: string, attempts: number, success: boolean): void {
    let stats = this.retryStats.get(operationId);
    
    if (!stats) {
      stats = {
        totalAttempts: 0,
        successfulRetries: 0,
        failedRetries: 0,
        averageAttempts: 0
      };
      this.retryStats.set(operationId, stats);
    }
    
    stats.totalAttempts += attempts;
    
    if (success) {
      stats.successfulRetries++;
    } else {
      stats.failedRetries++;
    }
    
    const totalOperations = stats.successfulRetries + stats.failedRetries;
    stats.averageAttempts = stats.totalAttempts / totalOperations;
  }

  // Convenience method for HTTP requests
  async retryHttpRequest<T>(
    httpOperation: () => Promise<T>,
    operationId: string,
    correlationId?: string
  ): Promise<RetryResult<T>> {
    return this.retry(httpOperation, operationId, correlationId, {
      retryableStatusCodes: [408, 429, 500, 502, 503, 504],
      retryableErrors: ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'],
      maxRetries: 3,
      baseDelayMs: 1000,
      backoffMultiplier: 2
    });
  }

  // Convenience method for webhook calls
  async retryWebhook<T>(
    webhookOperation: () => Promise<T>,
    webhookUrl: string,
    correlationId?: string
  ): Promise<RetryResult<T>> {
    const operationId = `webhook_${new URL(webhookUrl).hostname}`;
    
    return this.retry(webhookOperation, operationId, correlationId, {
      maxRetries: 5,
      baseDelayMs: 2000,
      maxDelayMs: 60000,
      backoffMultiplier: 1.5,
      timeoutMs: 30000
    });
  }

  // Convenience method for database operations
  async retryDatabase<T>(
    dbOperation: () => Promise<T>,
    operationName: string,
    correlationId?: string
  ): Promise<RetryResult<T>> {
    const operationId = `database_${operationName}`;
    
    return this.retry(dbOperation, operationId, correlationId, {
      maxRetries: 2,
      baseDelayMs: 500,
      maxDelayMs: 5000,
      backoffMultiplier: 2,
      retryableErrors: ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'],
      timeoutMs: 10000
    });
  }

  // Get retry statistics
  getStats(): {
    config: RetryConfig;
    operations: Array<{
      operationId: string;
      totalAttempts: number;
      successfulRetries: number;
      failedRetries: number;
      averageAttempts: number;
      successRate: number;
    }>;
    circuitBreakers: Array<{
      operationId: string;
      isOpen: boolean;
      failures: number;
      failureRate: number;
      lastFailureTime: Date;
      nextAttemptTime: Date;
    }>;
  } {
    const operations = Array.from(this.retryStats.entries()).map(([operationId, stats]) => {
      const totalOps = stats.successfulRetries + stats.failedRetries;
      return {
        operationId,
        totalAttempts: stats.totalAttempts,
        successfulRetries: stats.successfulRetries,
        failedRetries: stats.failedRetries,
        averageAttempts: Math.round(stats.averageAttempts * 100) / 100,
        successRate: totalOps > 0 ? Math.round((stats.successfulRetries / totalOps) * 100) : 0
      };
    });

    const circuitBreakers = Array.from(this.circuitBreakers.entries()).map(([operationId, state]) => ({
      operationId,
      isOpen: state.isOpen,
      failures: state.failures,
      failureRate: Math.round(state.failureRate * 100) / 100,
      lastFailureTime: state.lastFailureTime,
      nextAttemptTime: state.nextAttemptTime
    }));

    return {
      config: this.config,
      operations,
      circuitBreakers
    };
  }

  // Reset circuit breaker for specific operation
  resetCircuitBreaker(operationId: string): boolean {
    const state = this.circuitBreakers.get(operationId);
    if (!state) return false;

    state.isOpen = false;
    state.failures = 0;
    state.nextAttemptTime = new Date(0);
    state.failureRate = 0;

    logger.info('Circuit breaker manually reset', {
      operationId,
      type: 'circuit_breaker_reset'
    });

    return true;
  }

  // Clear all statistics
  clearStats(): void {
    this.retryStats.clear();
    this.circuitBreakers.clear();
    
    logger.info('Retry statistics and circuit breakers cleared', {
      type: 'retry_stats_cleared'
    });
  }
}

// Create singleton instance
export const retryManager = new RetryManager();

// Helper function for simple retry operations
export async function withRetry<T>(
  operation: () => Promise<T>,
  operationId: string,
  correlationId?: string,
  config?: Partial<RetryConfig>
): Promise<T> {
  const result = await retryManager.retry(operation, operationId, correlationId, config);
  
  if (!result.success) {
    throw result.error || new Error('Retry operation failed');
  }
  
  return result.data!;
}