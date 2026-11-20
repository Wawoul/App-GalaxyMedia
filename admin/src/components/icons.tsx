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
  // slide designer
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  shapes: 'M4 20h7v-7H4zM17.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM14 21l3.5-6 3.5 6z',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  unlock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 7.5-2',
  back: 'M19 12H5M11 6l-6 6 6 6',
  save: 'M5 4h12l3 3v13H5zM8 4v5h8V4M8 20v-6h8v6',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  bold: 'M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z',
  italic: 'M10 4h8M6 20h8M15 4L9 20',
  underline: 'M7 4v7a5 5 0 0 0 10 0V4M5 21h14',
  alignL: 'M4 6h16M4 10h10M4 14h16M4 18h10',
  alignC: 'M4 6h16M7 10h10M4 14h16M7 18h10',
  alignR: 'M4 6h16M10 10h10M4 14h16M10 18h10',
  alignJ: 'M4 6h16M4 10h16M4 14h16M4 18h16',
  toFront: 'M7 9l5-5 5 5M5 14h14M5 19h14',
  toBack: 'M7 15l5 5 5-5M5 10h14M5 5h14',
  forward: 'M12 19V5M6 11l6-6 6 6',
  backward: 'M12 5v14M6 13l6 6 6-6',
  rect: 'M4 6h16v12H4z',
  ellipse: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z',
  line: 'M4 18L20 6',
  template: 'M4 4h16v6H4zM4 14h7v6H4zM15 14h5v6h-5z',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  minus: 'M5 12h14',
  palette: 'M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2s0-2 1.5-2h2A4 4 0 0 0 21 11a9 9 0 0 0-9-8zM7.5 11h.01M10 7.5h.01M14 7.5h.01',
  edgeL: 'M4 4v16M8 7h12v4H8zM8 13h7v4H8z',
  edgeCH: 'M12 4v16M6 7h12v4H6zM8 13h8v4H8z',
  edgeR: 'M20 4v16M4 7h12v4H4zM9 13h7v4H9z',
  edgeT: 'M4 4h16M7 8v12h4V8zM13 8v7h4V8z',
  edgeCV: 'M4 12h16M7 6v12h4V6zM13 8v8h4V8z',
  edgeB: 'M4 20h16M7 4v12h4V4zM13 9v7h4V9z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  cloud: 'M7 18a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17.4 9 4.5 4.5 0 0 1 17 18z',
  play: 'M7 4.5v15l12-7.5z',
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
  portrait: 'M7 3h10v18H7z',
  landscape: 'M3 7h18v10H3z',
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
