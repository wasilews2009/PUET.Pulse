/**
 * Content sniffing: the stored MIME type comes from the bytes, never from the
 * client's Content-Type or file name. Anything not on this allowlist is refused.
 */
export type SniffedType =
  | 'application/pdf'
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'text/plain'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const startsWith = (b: Buffer, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

export function sniffType(body: Buffer): SniffedType | null {
  if (body.length < 4) return null;
  if (body.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(body, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (startsWith(body, [0x50, 0x4b, 0x03, 0x04])) {
    // OOXML: ZIP entry names are stored in clear. Macro-enabled documents are refused.
    if (!body.includes('[Content_Types].xml') || body.includes('vbaProject.bin')) return null;
    if (body.includes('word/document.xml')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (body.includes('xl/workbook.xml')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (body.includes('ppt/presentation.xml')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    return null;
  }
  if (!body.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(body);
      return 'text/plain';
    } catch {
      return null;
    }
  }
  return null;
}

/** Types the built-in viewer renders inline. Everything else is download-only. */
export const VIEWABLE_TYPES: ReadonlySet<string> = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

/** A display name safe for storage and Content-Disposition: no paths, controls or bidi overrides. */
export function safeFileName(raw: string): string {
  const name = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return name || 'file';
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback. */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
