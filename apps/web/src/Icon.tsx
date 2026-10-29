// The few line icons the app uses (Tabler outline paths, MIT), so no icon package.
const paths = {
  back: 'M5 12h14M5 12l6 6M5 12l6-6',
  send: 'M12 5v14M18 11l-6-6M6 11l6-6',
  settings: 'M10.3 4.3c.4-1.8 3-1.8 3.4 0a1.7 1.7 0 0 0 2.6 1.1c1.5-.9 3.3.8 2.4 2.4a1.7 1.7 0 0 0 1 2.5c1.8.4 1.8 3 0 3.4a1.7 1.7 0 0 0-1 2.6c.9 1.5-.9 3.3-2.4 2.4a1.7 1.7 0 0 0-2.6 1c-.4 1.8-3 1.8-3.4 0a1.7 1.7 0 0 0-2.6-1c-1.5.9-3.3-.9-2.4-2.4a1.7 1.7 0 0 0-1-2.6c-1.8-.4-1.8-3 0-3.4a1.7 1.7 0 0 0 1-2.5c-.9-1.6.9-3.3 2.4-2.4 1 .6 2.3.1 2.6-1.1M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  user: 'M8 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2',
  play: 'M7 4v16l13-8z',
  stop: 'M6 6h12v12H6z',
  x: 'M18 6L6 18M6 6l12 12',
  down: 'M6 9l6 6 6-6',
  up: 'M6 15l6-6 6 6',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l5 5L20 7',
  map: 'M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3zM9 4v13M15 7v13',
  locate: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 2v3M12 19v3M2 12h3M19 12h3',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
}

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>
}
