-- Extensions that need superuser are created by install.sh / a superuser.
-- citext is required for case-insensitive emails.
CREATE EXTENSION IF NOT EXISTS citext;
