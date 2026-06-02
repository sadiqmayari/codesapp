-- Per-conversation AI auto-pilot override.
-- NULL  = follow the workspace default (companies.ai_autoreply_enabled)
-- TRUE  = force auto-reply on this chat (overrides the assigned-human skip)
-- FALSE = mute auto-reply for this chat (also set on an AI handoff)
ALTER TABLE `conversations` ADD COLUMN `ai_autoreply` TINYINT(1) NULL;
