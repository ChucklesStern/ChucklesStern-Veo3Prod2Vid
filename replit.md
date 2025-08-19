# Video Generation Portal

## Overview

This is a full-stack TypeScript monorepo application that serves as a video generation submission portal. Users can submit text prompts with optional images to generate videos through an external n8n webhook service. The application features a real-time two-panel dashboard where users can submit requests on the left and view completed videos on the right. The system handles file uploads to cloud storage, tracks processing status in a PostgreSQL database, and provides live updates through polling.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript and Vite as the build tool
- **Routing**: Wouter for lightweight client-side routing
- **State Management**: @tanstack/react-query for server state management with 5-second polling intervals
- **UI Components**: shadcn/ui components built on Radix UI primitives with Tailwind CSS styling
- **Form Handling**: React Hook Form with Zod validation for type-safe form management
- **File Uploads**: Uppy library for robust file upload handling with progress tracking

### Backend Architecture
- **Runtime**: Node.js with ES modules and Express.js framework
- **Development**: tsx for TypeScript execution in development, esbuild for production builds
- **Database ORM**: Drizzle ORM with PostgreSQL dialect for type-safe database operations
- **File Processing**: Multer middleware for handling multipart form data uploads
- **API Design**: RESTful endpoints with comprehensive error handling and CORS support

### Data Storage Solutions
- **Primary Database**: PostgreSQL via Neon serverless with connection pooling
- **Object Storage**: Google Cloud Storage integration for file storage with ACL policies
- **Database Schema**: Single table design for video generations with status tracking
- **Migrations**: Drizzle Kit for database schema management and migrations

### File Upload and Storage Strategy
- **Upload Flow**: Client uploads to server, server processes and stores in Google Cloud Storage
- **File Validation**: Strict MIME type checking (PNG, JPG, WEBP, GIF) with 10MB size limit
- **Storage Architecture**: Object storage service with configurable ACL policies for access control
- **Error Handling**: Comprehensive upload error handling with user feedback

### External Service Integration
- **n8n Webhook**: External video generation service integration via HTTP webhooks
- **Callback System**: Webhook callbacks to update generation status and provide result URLs
- **Status Tracking**: Real-time status updates through database polling mechanism

### Authentication and Authorization
- **Replit Auth**: Integrated Replit OpenID Connect authentication for secure user sessions
- **Protected Routes**: All video generation and file upload endpoints require authentication
- **Session Management**: PostgreSQL-backed session storage with 7-day TTL
- **User Management**: Automatic user creation and profile management through Replit OAuth claims

## External Dependencies

### Core Framework Dependencies
- **React Ecosystem**: React 18, React DOM, React Hook Form for frontend functionality
- **Build Tools**: Vite with React plugin, TypeScript compiler, esbuild for production builds
- **Development Tools**: tsx for development server, Replit-specific plugins for enhanced development experience

### Database and ORM
- **Database**: @neondatabase/serverless for PostgreSQL connectivity
- **ORM**: drizzle-orm with drizzle-kit for migrations and schema management
- **Validation**: drizzle-zod for schema validation integration

### Cloud Storage
- **Storage Provider**: @google-cloud/storage for Google Cloud Storage integration
- **Upload Handling**: @uppy/* packages for file upload UI and AWS S3 compatibility layer
- **File Processing**: multer for server-side multipart form handling

### UI and Styling
- **UI Framework**: @radix-ui/* components for accessible UI primitives
- **Styling**: Tailwind CSS with PostCSS for utility-first styling
- **Icons**: lucide-react for consistent iconography

### State Management and API
- **Server State**: @tanstack/react-query for caching, synchronization, and background updates
- **Client Routing**: wouter for lightweight routing without full React Router overhead
- **Validation**: zod for runtime type validation and schema definition

### Development and Build Tools
- **TypeScript**: Full TypeScript support with strict mode enabled
- **Linting and Formatting**: Standard TypeScript configuration with path aliases
- **Replit Integration**: @replit/* packages for development environment integration