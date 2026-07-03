-- Global (MSP-level) settings, one JSONB document per key.
-- Secrets inside values are AES-256-GCM encrypted by the application layer.
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
