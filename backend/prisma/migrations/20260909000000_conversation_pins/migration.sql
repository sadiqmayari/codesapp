-- Per-user conversation pins (max 3 per user, enforced in InboxService.setPinned),
-- replacing the company-wide conversations.pinned_at (now retired).

CREATE TABLE `conversation_pins` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `conversation_id` INTEGER NOT NULL,
  `user_id` INTEGER NOT NULL,
  `pinned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `conversation_pins_user_id_conversation_id_key`(`user_id`, `conversation_id`),
  INDEX `conversation_pins_company_id_user_id_idx`(`company_id`, `user_id`),
  INDEX `conversation_pins_conversation_id_idx`(`conversation_id`),
  PRIMARY KEY (`id`),
  CONSTRAINT `conversation_pins_conversation_id_fkey`
    FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Migrate existing company-wide pins to each company's owner, newest 3 only.
INSERT INTO `conversation_pins` (`company_id`, `conversation_id`, `user_id`, `pinned_at`)
SELECT p.company_id, p.id, o.owner_id, p.pinned_at
FROM (
  SELECT c.company_id, c.id, c.pinned_at,
         ROW_NUMBER() OVER (
           PARTITION BY c.company_id ORDER BY c.pinned_at DESC, c.id DESC
         ) AS rn
  FROM conversations c
  WHERE c.pinned_at IS NOT NULL AND c.deleted_at IS NULL
) p
JOIN (
  SELECT company_id, MIN(id) AS owner_id
  FROM users
  WHERE role = 'owner' AND company_id IS NOT NULL
  GROUP BY company_id
) o ON o.company_id = p.company_id
WHERE p.rn <= 3;
