-- Media library folders (nested via parent_id, tenant-scoped)
CREATE TABLE media_folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES media_folders(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_folders_company ON media_folders(company_id);

ALTER TABLE media ADD COLUMN folder_id uuid REFERENCES media_folders(id) ON DELETE SET NULL;
