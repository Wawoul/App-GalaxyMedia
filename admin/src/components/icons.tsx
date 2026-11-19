import type { SVGProps } from 'react';

/** Small inline icon set (24px grid, 1.8px stroke, inherits currentColor). No font or dependency. */
const paths = {
  screens: 'M3 5h18v11H3zM8 20h8M12 16v4',
  media: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M9 9.5h.01',
  playlists: 'M4 6h12M4 11h12M4 16h7M18 14v6l4-3z',
  layouts: 'M3 4h18v16H3zM3 10h18M10 10v10',
  schedule: 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4',
  reports: 'M5 20V10M12 20V4M19 20v-7',
  companies: 'M4 20V8l8-4 8 4v12M9 20v-6h6v6',
  users: 'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-3A3.5 3.5 0 0 0 6 17.5V19M11 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 19v-1a3 3 0 0 0-2-2.8',
  alerts: 'M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15zM10 21h4',
  system: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1c.6.5 1.3.9 2 1.2l.4 2.7h4l.4-2.7c.7-.3 1.4-.7 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  warn: 'M12 4l10 17H2zM12 10v5M12 18h.01',
  signout: 'M10 4H5v16h5M15 8l4 4-4 4M19 12H9',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  auto: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 3v18M12 3a9 9 0 0 1 0 18',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5',
  tv: 'M3 6h18v12H3zM8 21h8',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}
