-- CodesApp — Phase 2 migration
-- Run ONCE on Hostinger via phpMyAdmin → Import (prisma migrate is unavailable on Hostinger).
-- This file is additive: it creates three new tables and adds new columns/indexes
-- to `messages` and `conversations`. It must not be re-run because MySQL's
-- `ALTER TABLE ADD COLUMN` does not support `IF NOT EXISTS` on MySQL 8.

-- ─── New table: conversation_labels ──────────────────────────────────────────
CREATE TABLE `conversation_labels` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `conversation_id` INTEGER NOT NULL,
    `label` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `conversation_labels_company_id_conversation_id_idx`(`company_id`, `conversation_id`),
    UNIQUE INDEX `conversation_labels_conversation_id_label_key`(`conversation_id`, `label`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `conversation_labels` ADD CONSTRAINT `conversation_labels_conversation_id_fkey`
    FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── New table: conversation_notes ───────────────────────────────────────────
CREATE TABLE `conversation_notes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `conversation_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,
    `body` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `conversation_notes_company_id_conversation_id_idx`(`company_id`, `conversation_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `conversation_notes` ADD CONSTRAINT `conversation_notes_conversation_id_fkey`
    FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── New table: segments ─────────────────────────────────────────────────────
CREATE TABLE `segments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `filter` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `segments_company_id_idx`(`company_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ─── Alter: conversations.unread_count ───────────────────────────────────────
ALTER TABLE `conversations` ADD COLUMN `unread_count` INTEGER NOT NULL DEFAULT 0;

-- ─── Alter: messages.read_at, read_by_user_id, broadcast_id + indexes ───────
ALTER TABLE `messages` ADD COLUMN `read_at` DATETIME(3) NULL;
ALTER TABLE `messages` ADD COLUMN `read_by_user_id` INTEGER NULL;
ALTER TABLE `messages` ADD COLUMN `broadcast_id` INTEGER NULL;

CREATE INDEX `messages_conversation_id_direction_status_idx`
    ON `messages`(`conversation_id`, `direction`, `status`);
CREATE INDEX `messages_broadcast_id_idx`
    ON `messages`(`broadcast_id`);

-- ─── Alter: broadcasts.status enum — add 'cancelled' ────────────────────────
ALTER TABLE `broadcasts`
    MODIFY COLUMN `status` ENUM('draft', 'scheduled', 'sending', 'completed', 'failed', 'cancelled')
    NOT NULL DEFAULT 'draft';
