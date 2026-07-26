-- Store the customer's shipping address on the CRM contact.
ALTER TABLE `contacts`
  ADD COLUMN `address` VARCHAR(500) NULL AFTER `email`,
  ADD COLUMN `city` VARCHAR(128) NULL AFTER `address`;
