export interface Me {
  id: string;
  email: string;
  displayName: string;
  level: 'msp' | 'company';
  role: 'admin' | 'editor' | 'viewer';
  companyId: string | null;
  companyAccess: string[];
}

export interface Company {
  id: string;
  name: string;
  screen_count: number;
  alert_emails: string;
  brand_name: string;
}

export interface Group {
  id: string;
  company_id: string;
  name: string;
  timezone: string;
  screen_count: number;
}

export interface Screen {
  id: string;
  company_id: string;
  company_name: string;
  name: string;
  paired: boolean;
  online: boolean;
  last_seen_at: string | null;
  app_version: string | null;
  current_item: string | null;
  storage_free_mb: number | null;
  group_ids: string[];
  playlist_name: string | null;
  screenshot_at: string | null;
  screenshot_url: string | null;
}

export interface MediaItem {
  id: string;
  kind: 'image' | 'video';
  original_name: string;
  mime: string;
  size_bytes: number;
  folder_id: string | null;
  created_at: string;
  url: string;
}

export interface Folder {
  id: string;
  parent_id: string | null;
  name: string;
}

export type LayoutPreset = 'main-side' | 'main-ticker' | 'main-side-ticker' | 'split-2' | 'custom';

export interface CustomZone {
  x: number;
  y: number;
  w: number;
  h: number;
  playlistId?: string | null;
  tickerTexts?: string[] | null;
}

export interface Layout {
  id: string;
  name: string;
  preset: LayoutPreset;
  zones: {
    main?: string | null;
    side?: string | null;
    ticker?: { texts: string[] } | null;
    custom?: CustomZone[] | null;
  };
}

export interface Playlist {
  id: string;
  name: string;
  item_count: number;
}

export interface PlaylistItem {
  id?: string;
  media_id: string | null;
  url: string | null;
  duration_ms: number | null;
  enabled: boolean;
  muted: boolean;
  original_name?: string | null;
  kind?: string | null;
}

export interface Assignment {
  id: string;
  playlist_id: string | null;
  layout_id: string | null; // playlist, layout, or neither (Black Screen)
  blackout: boolean;
  playlist_name: string; // playlist or layout name; 'Black Screen' for blackout
  screen_id: string | null;
  screen_name: string | null;
  group_id: string | null;
  group_name: string | null;
  priority: number;
  days_of_week: number[] | null;
  start_time: string | null;
  end_time: string | null;
  start_date: string | null;
  end_date: string | null;
  week_interval: number;
}

export interface User {
  id: string;
  email: string;
  display_name: string;
  level: 'msp' | 'company';
  role: 'admin' | 'editor' | 'viewer';
  company_id: string | null;
  totp_enabled: boolean;
  disabled: boolean;
  company_access: string[];
}
