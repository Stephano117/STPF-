// Contrôle des fichiers : le type annoncé par le navigateur n'est jamais cru.
// Le type réel est déduit des premiers octets (signature) et de l'extension.

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  dwg: 'image/vnd.dwg',
  psd: 'image/vnd.adobe.photoshop',
};

/** Extensions exécutables ou de script : refusées à l'import. */
const BLOCKED_EXT = new Set([
  'exe', 'dll', 'com', 'scr', 'msi', 'msp', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'hta', 'jar', 'lnk', 'pif', 'cpl', 'reg', 'sh', 'app', 'apk', 'deb', 'rpm', 'dmg', 'iso',
]);

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  return sig.every((b, i) => bytes[offset + i] === b);
}

function ascii(bytes: Uint8Array, start: number, len: number): string {
  return String.fromCharCode(...bytes.slice(start, start + len));
}

type Sniffed = { kind: 'executable' } | { kind: 'known'; mime: string; family: string } | { kind: 'unknown' };

export function sniff(bytes: Uint8Array): Sniffed {
  if (startsWith(bytes, [0x4d, 0x5a])) return { kind: 'executable' }; // PE (Windows)
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return { kind: 'executable' }; // ELF
  if (
    startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(bytes, [0xce, 0xfa, 0xed, 0xfe]) || startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe])
  ) return { kind: 'executable' }; // Mach-O
  if (startsWith(bytes, [0x23, 0x21])) return { kind: 'executable' }; // script « #! »

  const known = (mime: string, family: string): Sniffed => ({ kind: 'known', mime, family });
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return known('application/pdf', 'pdf');
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return known('image/png', 'png');
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return known('image/jpeg', 'jpeg');
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return known('image/gif', 'gif');
  if (startsWith(bytes, [0x42, 0x4d])) return known('image/bmp', 'bmp');
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return known('image/webp', 'webp');
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return known('audio/wav', 'wav');
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'AVI ') return known('video/x-msvideo', 'avi');
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]))
    return known('application/zip', 'zip'); // zip, docx, xlsx, pptx, odt…
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return known('application/x-ole-storage', 'ole'); // doc, xls, ppt
  if (startsWith(bytes, [0x52, 0x61, 0x72, 0x21])) return known('application/vnd.rar', 'rar');
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf])) return known('application/x-7z-compressed', '7z');
  if (startsWith(bytes, [0x1f, 0x8b])) return known('application/gzip', 'gz');
  if (ascii(bytes, 4, 4) === 'ftyp') return known('video/mp4', 'mp4'); // mp4, mov, m4a
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return known('video/webm', 'webm'); // webm, mkv
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return known('audio/mpeg', 'mp3');
  if (ascii(bytes, 0, 4) === 'OggS') return known('audio/ogg', 'ogg');
  return { kind: 'unknown' };
}

/** Extensions dont le contenu doit correspondre à une famille de signature précise. */
const EXT_FAMILY: Record<string, string[]> = {
  pdf: ['pdf'],
  png: ['png'],
  jpg: ['jpeg'],
  jpeg: ['jpeg'],
  gif: ['gif'],
  webp: ['webp'],
  bmp: ['bmp'],
  docx: ['zip'],
  xlsx: ['zip'],
  pptx: ['zip'],
  odt: ['zip'],
  ods: ['zip'],
  odp: ['zip'],
  zip: ['zip'],
  doc: ['ole'],
  xls: ['ole'],
  ppt: ['ole'],
  rar: ['rar'],
  '7z': ['7z'],
  gz: ['gz'],
  mp4: ['mp4'],
  mov: ['mp4'],
  m4a: ['mp4'],
  webm: ['webm'],
  mkv: ['webm'],
  wav: ['wav'],
  avi: ['avi'],
  ogg: ['ogg'],
};

export function isBlockedName(name: string): boolean {
  return BLOCKED_EXT.has(extensionOf(name));
}

export type MimeVerdict = { ok: true; mime: string } | { ok: false; reason: string };

/** Décide du type réel d'un fichier à partir de son nom et de ses premiers octets. */
export function inspectFile(name: string, head: Uint8Array): MimeVerdict {
  const ext = extensionOf(name);
  if (BLOCKED_EXT.has(ext)) return { ok: false, reason: `Les fichiers .${ext} ne sont pas acceptés.` };
  const sniffed = sniff(head);
  if (sniffed.kind === 'executable') return { ok: false, reason: 'Les fichiers exécutables ne sont pas acceptés.' };
  const expected = EXT_FAMILY[ext];
  if (expected && head.length > 0) {
    if (sniffed.kind !== 'known' || !expected.includes(sniffed.family)) {
      return { ok: false, reason: `Le contenu du fichier ne correspond pas à son extension .${ext}.` };
    }
  }
  if (EXT_MIME[ext]) return { ok: true, mime: EXT_MIME[ext] };
  if (sniffed.kind === 'known') return { ok: true, mime: sniffed.mime };
  return { ok: true, mime: 'application/octet-stream' };
}

/** Types que le navigateur peut afficher sans risque depuis une URL signée. */
export function isInlineSafe(mime: string): boolean {
  return (
    mime === 'application/pdf' ||
    mime === 'text/plain' ||
    mime === 'text/csv' ||
    mime === 'application/json' ||
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(mime) ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/')
  );
}

export function categoryOf(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (/zip|rar|7z|gzip|tar/.test(mime)) return 'archive';
  if (/word|excel|powerpoint|opendocument|officedocument|rtf|^text\/|json|xml/.test(mime)) return 'document';
  return 'other';
}

/** Filtre SQL (LIKE) par catégorie, miroir de categoryOf. */
export const CATEGORY_PATTERNS: Record<string, string[]> = {
  image: ['image/%'],
  video: ['video/%'],
  audio: ['audio/%'],
  pdf: ['application/pdf'],
  archive: ['%zip%', '%rar%', '%7z%', '%tar%'],
  document: ['%word%', '%excel%', '%powerpoint%', '%opendocument%', '%officedocument%', '%rtf%', 'text/%', '%json%', '%xml%'],
};
