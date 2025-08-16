# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential Commands

### Development
- `npm run dev` - Start development server with hot reload
- `npm run build` - Build both client and server for production
- `npm start` - Start production server
- `npm run check` - TypeScript type checking

### Database
- `npm run db:push` - Push schema changes to database (Drizzle Kit)

## Architecture Overview

This is a full-stack TypeScript monorepo for a video generation portal that integrates with an external n8n webhook service. The application uses a real-time two-panel dashboard where users submit requests on the left and view completed videos on the right.

### Project Structure

- `client/` - React frontend built with Vite
- `server/` - Express.js backend with Node.js
- `shared/` - Shared types and database schema
- `migrations/` - Database migration files (generated)

### Key Architecture Decisions

**Frontend Stack:**
- React 18 + TypeScript with Vite build tool
- Wouter for lightweight routing (not React Router)
- @tanstack/react-query for server state with 5-second polling
- shadcn/ui components on Radix UI primitives
- React Hook Form + Zod for form validation
- Uppy library for file uploads

**Backend Stack:**
- Express.js with ES modules (not CommonJS)
- Development: tsx for TypeScript execution
- Production: esbuild for bundling
- Drizzle ORM with PostgreSQL
- Multer for file upload handling

**Storage Architecture:**
- PostgreSQL via Neon serverless (primary database)
- Google Cloud Storage for file storage
- Single table design for video generations: `video_generations`
- Object storage with configurable ACL policies

**External Integration:**
- n8n webhook for video generation service
- No authentication system (deliberately public)
- Webhook callbacks update generation status

### Database Schema

Primary table: `videoGenerations` in `shared/schema.ts`
- Uses UUIDs for primary keys
- Status tracking: pending → processing → completed/failed
- Stores paths to original images, generated images, and videos

### File Upload Flow

1. Client uploads to `/api/upload` (10MB limit, PNG/JPG/WEBP/GIF only)
2. Server processes with Multer and stores in Google Cloud Storage
3. Returns public URL path for immediate access
4. Files served via `/public-objects/:filePath` endpoint

### API Endpoints

- `GET /api/health` - Health check
- `POST /api/upload` - File upload
- `GET /public-objects/:filePath(*)` - Public file serving
- `POST /api/generations` - Create video generation request
- `POST /api/generations/callback` - n8n webhook callback
- `GET /api/generations` - Get completed generations (with ?onlyCompleted=true)
- `GET /api/generations/:id` - Get single generation

### Environment Requirements

- `DATABASE_URL` - PostgreSQL connection string (required)
- `N8N_WEBHOOK_URL` - External webhook endpoint (required)
- `PORT` - Server port (defaults to 5000)

### Development Notes

- Uses path aliases: `@/*` for client/src, `@shared/*` for shared
- CORS configured for localhost and replit domains
- Request logging middleware for API endpoints
- Type-safe with strict TypeScript configuration
- No tests currently configured

### Critical Patterns

1. **Shared Types**: All API schemas defined in `shared/types.ts` using Zod
2. **Error Handling**: Comprehensive validation with Zod schemas
3. **Real-time Updates**: Client polls every 5 seconds for status updates
4. **File Access**: Public files served directly without authentication
5. **Status Tracking**: Database-driven status workflow for video generation

### Replit-Specific

- Uses @replit/vite-plugin-cartographer and runtime-error-modal
- Configured for Replit's hosting environment
- Single port (5000) serves both API and client