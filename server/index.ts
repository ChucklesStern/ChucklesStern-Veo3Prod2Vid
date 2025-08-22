import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { logger, correlationMiddleware } from "./lib/logger";
import { monitoringMiddleware, apiMonitor } from "./lib/monitoring";
import { errorHandler } from "./lib/errorHandler";
import { performanceMiddleware, metricsCollector } from "./lib/metrics";
import { alertingMiddleware, alertingSystem } from "./lib/alerting";
import { rateLimitMiddleware } from "./lib/rateLimiting";
import { validationMiddleware } from "./lib/validation";
import { idempotencyMiddleware } from "./lib/idempotency";
import { rawBodyMiddleware, webhookSecurityMiddleware } from "./lib/webhookSecurity";

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
