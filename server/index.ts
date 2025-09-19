import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { logger, correlationMiddleware } from "./lib/logger";
import { monitoringMiddleware, apiMonitor } from "./lib/monitoring";
import { errorHandler, handleConfigurationError } from "./lib/errorHandler";
import { performanceMiddleware, metricsCollector } from "./lib/metrics";
import { alertingMiddleware, alertingSystem } from "./lib/alerting";
import { rateLimitMiddleware } from "./lib/rateLimiting";
import { validationMiddleware } from "./lib/validation";
import { idempotencyMiddleware } from "./lib/idempotency";
import { rawBodyMiddleware, webhookSecurityMiddleware } from "./lib/webhookSecurity";

// Environment configuration validation function
async function validateEnvironmentConfiguration(): Promise<void> {
  const startupId = 'startup-validation';

  logger.info('Starting environment configuration validation', {
    correlationId: startupId,
    environment: process.env.NODE_ENV,
    type: 'startup_validation_start'
  });

  const requiredEnvVars = [
    'DATABASE_URL',
    'N8N_WEBHOOK_URL'
  ];

  const warnings = [];
  const errors = [];

  // Check required environment variables
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      errors.push(`Missing required environment variable: ${envVar}`);
    } else {
      logger.info(`Environment variable validated: ${envVar}`, {
        correlationId: startupId,
        envVar,
        hasValue: true,
        type: 'env_var_validation'
      });
    }
  }

  // Validate N8N_WEBHOOK_URL format if present
  if (process.env.N8N_WEBHOOK_URL) {
    try {
      const webhookUrl = new URL(process.env.N8N_WEBHOOK_URL);
      logger.info('N8N webhook URL format validation passed', {
        correlationId: startupId,
        protocol: webhookUrl.protocol,
        hostname: webhookUrl.hostname,
        port: webhookUrl.port || 'default',
        type: 'webhook_url_validation'
      });

      // Test webhook endpoint connectivity at startup (non-blocking)
      try {
        logger.info('Testing N8N webhook endpoint connectivity', {
          correlationId: startupId,
          webhookUrl: process.env.N8N_WEBHOOK_URL,
          type: 'startup_webhook_connectivity_test'
        });

        const connectivityTest = await fetch(process.env.N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Fabbitt-VideoGen/1.0-StartupTest'
          },
          body: JSON.stringify({ test: 'startup_connectivity_check' }),
          signal: AbortSignal.timeout(10000) // 10 second timeout at startup
        });

        logger.info('N8N webhook endpoint is reachable', {
          correlationId: startupId,
          webhookUrl: process.env.N8N_WEBHOOK_URL,
          status: connectivityTest.status,
          reachable: true,
          type: 'startup_webhook_connectivity_result'
        });
      } catch (error: any) {
        warnings.push(`N8N webhook endpoint connectivity test failed: ${error.message}`);
        logger.warn('N8N webhook endpoint connectivity test failed', {
          correlationId: startupId,
          webhookUrl: process.env.N8N_WEBHOOK_URL,
          error: error.message,
          reachable: false,
          type: 'startup_webhook_connectivity_result'
        });
      }
    } catch (error) {
      errors.push(`Invalid N8N_WEBHOOK_URL format: ${error instanceof Error ? error.message : 'Invalid URL'}`);
    }
  }

  // Check optional but recommended environment variables
  const optionalEnvVars = [
    'PORT',
    'NODE_ENV',
    'BASE_MODEL_IMAGE_1',
    'BASE_MODEL_IMAGE_2'
  ];

  for (const envVar of optionalEnvVars) {
    if (!process.env[envVar]) {
      warnings.push(`Optional environment variable not set: ${envVar}`);
    }
  }

  // Log validation results
  if (errors.length > 0) {
    logger.error('Environment configuration validation failed', {
      correlationId: startupId,
      errors,
      warnings,
      type: 'startup_validation_failed'
    });

    console.error('❌ Environment Configuration Validation Failed:');
    errors.forEach(error => console.error(`  - ${error}`));
    process.exit(1);
  }

  if (warnings.length > 0) {
    logger.warn('Environment configuration validation completed with warnings', {
      correlationId: startupId,
      warnings,
      type: 'startup_validation_warnings'
    });

    console.warn('⚠️  Environment Configuration Warnings:');
    warnings.forEach(warning => console.warn(`  - ${warning}`));
  }

  logger.info('Environment configuration validation completed successfully', {
    correlationId: startupId,
    checkedVars: requiredEnvVars.length + optionalEnvVars.length,
    errors: errors.length,
    warnings: warnings.length,
    type: 'startup_validation_success'
  });

  console.log('✅ Environment configuration validation passed');
}

const app = express();
app.set('trust proxy', 1); // Trust first proxy for Replit
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

// Enhanced API Manager middleware stack
app.use(correlationMiddleware);           // Add correlation IDs to all requests
app.use(rateLimitMiddleware);            // Rate limiting protection
app.use(monitoringMiddleware);           // API monitoring and health tracking
app.use(performanceMiddleware);          // Performance metrics collection
app.use(alertingMiddleware);             // Error rate tracking and alerting
app.use(validationMiddleware);           // Request/response validation
app.use(idempotencyMiddleware);          // Idempotency protection

(async () => {
  // Validate environment configuration before starting
  await validateEnvironmentConfiguration();

  const server = await registerRoutes(app);

  // Enhanced error handling with observability
  app.use(errorHandler);

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();
