export function relayPath(path: string) {
  const pathname = globalThis.location?.pathname || '/';
  const guest = pathname === '/guest' || pathname.startsWith('/guest/');
  return (guest ? '/guest' : '') + path;
}
