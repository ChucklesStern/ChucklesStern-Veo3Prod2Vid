CREATE TABLE "sessions" (
	"sid" text PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"name" text,
	"profile_image_url" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "video_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"prompt_text" text NOT NULL,
	"image_original_path" text,
	"image_generation_path" text,
	"video_path" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"error_details" jsonb,
	"error_type" text,
	"retry_count" text DEFAULT '0',
	"max_retries" text DEFAULT '3',
	"next_retry_at" timestamp,
	"webhook_response_status" text,
	"webhook_response_body" text,
	"last_attempt_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "video_generations_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");