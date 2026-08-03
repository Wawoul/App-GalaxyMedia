-- totp_last_used remembers only the most recent code, so an attacker who
-- observed code N could still replay it once the legitimate user logged in with
-- N+1 - the stored hash has moved on, while N is inside its ~90s validity.
-- Recording when the last code was accepted lets the check also reject any code
-- older than that moment, closing the window regardless of which code it was.
ALTER TABLE users ADD COLUMN totp_last_used_at timestamptz;
