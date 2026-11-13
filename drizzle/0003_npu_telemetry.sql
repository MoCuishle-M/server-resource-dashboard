CREATE TABLE `npu_days` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`day` text NOT NULL,
	`expected` integer NOT NULL,
	`samples` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `npu_latest` (
	`resource_id` text PRIMARY KEY NOT NULL,
	`expected` integer NOT NULL,
	`sampled_at` integer NOT NULL,
	`cards` text NOT NULL
);
