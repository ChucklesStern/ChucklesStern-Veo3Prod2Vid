import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import { randomUUID } from "crypto";
import { ObjectStorageService, ObjectNotFoundError, objectStorageClient, parseObjectPath } from "./objectStorage";
import { storage } from "./storage";
import { setupAuth, isAuthenticated } from "./replitAuth";
import {
  GenerationCreateRequestSchema,
  GenerationCallbackSchema,
  N8nWebhookPayloadSchema,
  UploadResponseSchema
} from "@shared/types";
import { z } from "zod";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PNG, JPG, WEBP, GIF allowed.'));
    }
  }
});

export async function registerRoutes(app: Express): Promise<Server> {
  const objectStorageService = new ObjectStorageService();

  // Setup Replit authentication
  await setupAuth(app);

  // CORS middleware
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (origin.includes('localhost') || origin.includes('replit'))) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ ok: true });
  });

  // Public object serving endpoint
  app.get("/public-objects/:filePath(*)", async (req, res) => {
    const filePath = req.params.filePath;
    try {
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        return res.status(404).json({ error: "File not found" });
      }
      await objectStorageService.downloadObject(file, res);
    } catch (error) {
      console.error("Error serving public object:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // Upload endpoint - requires authentication
  app.post("/api/upload", isAuthenticated, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file provided" });
      }

      // Create filename with extension
      const fileExtension = req.file.originalname.split('.').pop() || 'jpg';
      const filename = `${randomUUID()}.${fileExtension}`;

      // Get public upload URL
      const uploadURL = await objectStorageService.getPublicUploadURL(filename);
      
      // Upload file using the presigned URL
      const uploadResponse = await fetch(uploadURL, {
        method: 'PUT',
        body: req.file.buffer,
        headers: {
          'Content-Type': req.file.mimetype
        }
      });

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed: ${uploadResponse.statusText}`);
      }

      // Create public URL path
      const publicPath = `/public-objects/uploads/${filename}`;
      const mediaUrl = publicPath;

      const response = UploadResponseSchema.parse({
        objectPath: publicPath,
        mediaUrl
      });

      res.json(response);
    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Upload failed' });
    }
  });

  // Auth routes
  app.get('/api/auth/user', isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const user = await storage.getUser(userId);
      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });



  // List files in object storage
  app.get("/api/storage/list/:directory?", async (req, res) => {
    try {
      const { directory = "public" } = req.params;
      const objectStorageService = new ObjectStorageService();
      
      if (directory === "public") {
        const searchPaths = objectStorageService.getPublicObjectSearchPaths();
        const files = [];
        
        for (const searchPath of searchPaths) {
          const { bucketName, objectName } = parseObjectPath(searchPath);
          const bucket = objectStorageClient.bucket(bucketName);
          
          const [bucketFiles] = await bucket.getFiles({
            prefix: objectName + "/",
            delimiter: "/"
          });
          
          files.push(...bucketFiles.map(file => ({
            name: file.name,
            size: file.metadata.size,
            updated: file.metadata.updated,
            contentType: file.metadata.contentType
          })));
        }
        
        res.json({ files, directory: "public" });
      } else {
        res.status(400).json({ error: "Only public directory listing is supported" });
      }
    } catch (error) {
      console.error("Error listing storage files:", error);
      res.status(500).json({ error: "Failed to list files" });
    }
  });

  // Media serving endpoint
  app.get("/api/media/:key", async (req, res) => {
    try {
      const key = decodeURIComponent(req.params.key);
      const objectPath = `/objects/${key}`;
      
      const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
      await objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      console.error('Media serving error:', error);
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Media not found" });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Create video generation - requires authentication
  app.post("/api/generations", isAuthenticated, async (req, res) => {
    try {
      const validatedBody = GenerationCreateRequestSchema.parse(req.body);
      
      const taskId = randomUUID();
      const generation = await storage.createVideoGeneration({
        taskId,
        promptText: validatedBody.promptText,
        imageOriginalPath: validatedBody.imagePath || null,
        status: "pending" as const
      });

      // Send to n8n webhook
      const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;
      if (!n8nWebhookUrl) {
        throw new Error("N8N_WEBHOOK_URL not configured");
      }

      // Construct full public URL for the image
      let imageUrl = null;
      if (validatedBody.imagePath) {
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host;
        imageUrl = `${protocol}://${host}${validatedBody.imagePath}`;
      }

      const webhookPayload = N8nWebhookPayloadSchema.parse({
        taskId,
        promptText: validatedBody.promptText,
        imagePath: validatedBody.imagePath || null,
        Imageurl: imageUrl
      });

      const webhookResponse = await fetch(n8nWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookPayload)
      });

      if (!webhookResponse.ok) {
        const responseText = await webhookResponse.text();
        await storage.updateVideoGeneration(taskId, { 
          status: "failed", 
          errorMessage: `Webhook failed: ${webhookResponse.statusText}` 
        });
        throw new Error(`Webhook failed: ${webhookResponse.statusText}`);
      }

      // Update status to processing
      await storage.updateVideoGeneration(taskId, { status: "processing" });

      res.json({ id: generation.id, taskId: generation.taskId });
    } catch (error) {
      console.error('Generation creation error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Generation failed' });
    }
  });

  // n8n callback endpoint
  app.post("/api/generations/callback", async (req, res) => {
    try {
      const validatedBody = GenerationCallbackSchema.parse(req.body);
      
      const updated = await storage.updateVideoGeneration(validatedBody.taskId, {
        status: validatedBody.status,
        imageGenerationPath: validatedBody.imageGenerationPath || null,
        videoPath: validatedBody.videoPath || null,
        errorMessage: validatedBody.errorMessage || null
      });

      if (!updated) {
        return res.status(404).json({ error: "Generation not found" });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Callback error:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      res.status(500).json({ error: "Callback processing failed" });
    }
  });

  // Get completed generations - requires authentication
  app.get("/api/generations", isAuthenticated, async (req, res) => {
    try {
      const onlyCompleted = req.query.onlyCompleted === 'true';
      
      if (onlyCompleted) {
        const generations = await storage.getCompletedVideoGenerations(50);
        // Only return generations with video_path
        const completedWithVideos = generations.filter(g => g.videoPath);
        res.json(completedWithVideos);
      } else {
        // For now, only support completed filter as per requirements
        res.json([]);
      }
    } catch (error) {
      console.error('Get generations error:', error);
      res.status(500).json({ error: "Failed to fetch generations" });
    }
  });

  // Get single generation - requires authentication
  app.get("/api/generations/:id", isAuthenticated, async (req, res) => {
    try {
      const generation = await storage.getVideoGenerationById(req.params.id);
      if (!generation) {
        return res.status(404).json({ error: "Generation not found" });
      }
      res.json(generation);
    } catch (error) {
      console.error('Get generation error:', error);
      res.status(500).json({ error: "Failed to fetch generation" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
