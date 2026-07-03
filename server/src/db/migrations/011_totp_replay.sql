-- Anti-replay for TOTP: remember the last accepted code (hashed) so a code
-- observed once can't open a second session within its ~90s validity window.
ALTER TABLE users ADD COLUMN totp_last_used text;
