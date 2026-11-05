import type { CSSProperties } from 'react';

const paths = {
  check: 'm5 12 4 4L19 6',
  fullscreen: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  minimize: 'M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 17v4h16v-4',
  back: 'm12 5-7 7 7 7M5 12h15',
  external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
  link: 'm10 13 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 3 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  pause: 'M8 5v14M16 5v14',
  terminal: 'm4 5 6 6-6 6m9 1h7',

  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h12v12H9V9ZM5 15H3V3h12v2',
  download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  wrap: 'M3 6h18M3 12h13a4 4 0 0 1 0 8h-4m3-3-3 3 3 3M3 18h3',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  search: 'm21 21-4.4-4.4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0',
  chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
  folder:
    'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  chevron: 'm9 5 7 7-7 7',
  history: 'M3 11a9 9 0 1 1 2.5 7M3 4v7h7m2-4v5l3 2',
  refresh: 'M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5m-3 9a9 9 0 0 0 15 2l3-3m0 5v-5h-5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  info: 'M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  close: 'm6 6 12 12M6 18 18 6',
  send: 'M12 19V5m-6 6 6-6 6 6',
  stop: 'M7 7h10v10H7Z',
  shield: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Zm-4 9 3 3 5-6',
  devices: 'M3 4h14v12H3V4Zm3 16h8m-4-4v4m10-11h3v12h-7v-3',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  power: 'M12 2v10M6 5a9 9 0 1 0 12 0',
  mail: 'M3 5h18v14H3V5Zm0 1 9 7 9-7',
  key: 'M14 6a5 5 0 1 1-3 9l-6 6H2v-3l6-6a5 5 0 0 1 6-6Z',
  settings: 'M4 7h16M4 17h16M9 4v6m6 4v6',
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 18,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      className="happier-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3.5 : 1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
