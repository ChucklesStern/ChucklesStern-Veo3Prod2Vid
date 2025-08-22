import { randomUUID } from "crypto";

export interface LogLevel {
  ERROR: 'error';
  WARN: 'warn';
  INFO: 'info';
  DEBUG: 'debug';
}

export const LOG_LEVEL: LogLevel = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug'
};

export interface LogContext {
  correlationId?: string;
  userId?: string;
  taskId?: string;
  endpoint?: string;
  method?: string;
  statusCode?: number;
  duration?: number;
  error?: any;
  requestId?: string;
  [key: string]: any;
}

export interface StructuredLogEntry {
  timestamp: string;
  level: string;
  message: string;
  correlationId?: string;
  context?: LogContext;
  service: string;
  version: string;
  environment: string;
}

class Logger {
  private service: string;
  private version: string;
  private environment: string;

  constructor() {
    this.service = 'veo3vidagent-api';
    this.version = process.env.APP_VERSION || '1.0.0';
    this.environment = process.env.NODE_ENV || 'development';
  }

  private formatLog(level: string, message: string, context?: LogContext): StructuredLogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      correlationId: context?.correlationId || context?.requestId,
      context,
      service: this.service,
      version: this.version,
      environment: this.environment
    };
  }

  private output(logEntry: StructuredLogEntry): void {
    if (this.environment === 'development') {
      // Pretty print for development
      const { level, message, correlationId, context } = logEntry;
      const prefix = correlationId ? `[${correlationId.slice(0, 8)}]` : '';
      console.log(`${prefix} ${level.toUpperCase()}: ${message}`, context ? context : '');
    } else {
      // JSON format for production
      console.log(JSON.stringify(logEntry));
    }
  }

  error(message: string, context?: LogContext): void {
    this.output(this.formatLog(LOG_LEVEL.ERROR, message, context));
  }

  warn(message: string, context?: LogContext): void {
    this.output(this.formatLog(LOG_LEVEL.WARN, message, context));
  }

  info(message: string, context?: LogContext): void {
    this.output(this.formatLog(LOG_LEVEL.INFO, message, context));
  }

  debug(message: string, context?: LogContext): void {
    this.output(this.formatLog(LOG_LEVEL.DEBUG, message, context));
  }

  // API-specific logging methods
  apiRequest(method: string, endpoint: string, context?: LogContext): void {
    this.info(`API Request: ${method} ${endpoint}`, {
      ...context,
      method,
      endpoint,
      type: 'api_request'
    });
  }

  apiResponse(method: string, endpoint: string, statusCode: number, duration: number, context?: LogContext): void {
    const level = statusCode >= 400 ? LOG_LEVEL.ERROR : LOG_LEVEL.INFO;
    this.output(this.formatLog(level, `API Response: ${method} ${endpoint} ${statusCode} in ${duration}ms`, {
      ...context,
      method,
      endpoint,
      statusCode,
      duration,
      type: 'api_response'
    }));
  }

  webhookCall(url: string, payload: any, context?: LogContext): void {
    this.info(`Webhook Call: ${url}`, {
      ...context,
      webhookUrl: url,
      payloadSize: JSON.stringify(payload).length,
      type: 'webhook_call'
    });
  }

  webhookResponse(url: string, statusCode: number, duration: number, context?: LogContext): void {
    const level = statusCode >= 400 ? LOG_LEVEL.ERROR : LOG_LEVEL.INFO;
    this.output(this.formatLog(level, `Webhook Response: ${url} ${statusCode} in ${duration}ms`, {
      ...context,
      webhookUrl: url,
      statusCode,
      duration,
      type: 'webhook_response'
    }));
  }

  databaseOperation(operation: string, table: string, duration: number, context?: LogContext): void {
    this.debug(`Database: ${operation} on ${table} in ${duration}ms`, {
      ...context,
      operation,
      table,
      duration,
      type: 'database_operation'
    });
  }

  fileOperation(operation: string, filePath: string, duration: number, context?: LogContext): void {
    this.info(`File Operation: ${operation} ${filePath} in ${duration}ms`, {
      ...context,
      operation,
      filePath,
      duration,
      type: 'file_operation'
    });
  }
}

// Create singleton instance
export const logger = new Logger();

// Correlation ID generation utility
export function generateCorrelationId(): string {
  return randomUUID();
}

// Express middleware for correlation ID
export function correlationMiddleware(req: any, res: any, next: any): void {
  req.correlationId = req.headers['x-correlation-id'] || generateCorrelationId();
  res.setHeader('X-Correlation-ID', req.correlationId);
  next();
}