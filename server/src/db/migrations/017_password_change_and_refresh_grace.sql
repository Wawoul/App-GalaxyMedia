-- Self-service password change, and a grace window for concurrent refreshes.

-- Set when someone ELSE chose this user's password (an admin created the account
-- or reset the password): the user must replace it before doing anything else.
-- Without it a temporary password given out over chat stays valid forever, and
-- there was previously no way for a user to change their own password at all.
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- When a refresh token was rotated (as opposed to revoked for another reason).
-- Two browser tabs restoring a session at once present the same token; the loser
-- used to look like theft and got EVERY session for that user revoked. A token
-- rotated seconds ago is now just refused, while a replay long after rotation -
-- or any token revoked for another reason (logout, disable, password change) -
-- still counts as theft.
ALTER TABLE refresh_tokens ADD COLUMN revoked_at timestamptz;
