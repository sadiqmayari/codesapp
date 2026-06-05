-- Store embeddings as base64 TEXT instead of LONGBLOB: passing a raw Buffer to
-- a Prisma Bytes field tripped "unexpected end of hex escape" in the query
-- protocol. The table holds no usable rows yet (sync failed), so a straight
-- column type change is safe.
ALTER TABLE `ai_knowledge_chunks` MODIFY COLUMN `embedding` LONGTEXT NOT NULL;
