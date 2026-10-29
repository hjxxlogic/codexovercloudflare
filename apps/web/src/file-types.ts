export type FileKind =
  'markdown' | 'text' | 'image' | 'audio' | 'video' | 'download';
const media: Record<string, [FileKind, string]> = {
  png: ['image', 'image/png'],
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'],
  avif: ['image', 'image/avif'],
  bmp: ['image', 'image/bmp'],
  ico: ['image', 'image/x-icon'],
  svg: ['image', 'image/svg+xml'],
  mp3: ['audio', 'audio/mpeg'],
  wav: ['audio', 'audio/wav'],
  ogg: ['audio', 'audio/ogg'],
  oga: ['audio', 'audio/ogg'],
  flac: ['audio', 'audio/flac'],
  m4a: ['audio', 'audio/mp4'],
  aac: ['audio', 'audio/aac'],
  opus: ['audio', 'audio/ogg'],
  mp4: ['video', 'video/mp4'],
  webm: ['video', 'video/webm'],
  ogv: ['video', 'video/ogg'],
  mov: ['video', 'video/quicktime'],
};
const text = new Set(
  'txt log json jsonl yaml yml toml ini conf cfg csv tsv xml html htm css scss js jsx ts tsx mjs cjs py rb go rs c cpp cc cxx h hpp cs java kt sh bash zsh sql diff patch tex rst adoc env gitignore dockerignore'.split(
    ' ',
  ),
);
export function fileType(path: string): { kind: FileKind; mime: string } {
  const name = path.split('/').pop()!.toLowerCase();
  const extension = name.split('.').pop()!;
  if (['md', 'markdown', 'mdown', 'mkd'].includes(extension))
    return { kind: 'markdown', mime: 'text/markdown' };
  if (media[extension])
    return { kind: media[extension][0], mime: media[extension][1] };
  if (
    text.has(extension) ||
    ['readme', 'license', 'makefile', 'dockerfile', '.env'].includes(name)
  )
    return { kind: 'text', mime: 'text/plain' };
  return { kind: 'download', mime: 'application/octet-stream' };
}
export function filePreviewUrl(host: string, project: string, path: string) {
  const url = new URL(
    typeof location === 'undefined' ? '/' : location.pathname,
    typeof location === 'undefined'
      ? 'https://preview.invalid'
      : location.origin,
  );
  url.hash = new URLSearchParams({
    preview: 'file',
    host,
    project,
    path,
  }).toString();
  return url.href;
}
