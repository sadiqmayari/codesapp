-- AI conversation closing: when the customer ends the chat (thanks / nothing
-- more needed) the AI sends one sign-off, resolves the conversation, and stamps
-- ai_closed_at. While set, further acknowledgements get no reply (anti-loop);
-- it's cleared when the customer makes a real new request.
ALTER TABLE `conversations`
  ADD COLUMN `ai_closed_at` DATETIME(3) NULL;
