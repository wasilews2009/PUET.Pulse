import { PDFDocument, rgb } from 'pdf-lib';
import { TextWriter } from './fonts';

export interface WatermarkViewer {
  fullName: string;
  /** Corporate id shown in the mark (never a phone or e-mail). */
  marker: string;
  /** Client address as seen by the API behind the trusted proxy (TRUSTED_PROXIES). */
  ip?: string | null;
}

/** Only a well-formed IPv4 / IPv6 literal is printed; anything else is left out. */
export function printableIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v;
  if (/^[0-9a-f:]{2,39}$/i.test(v) && v.includes(':')) return v;
  return null;
}

/** PUET navy (#163C56) at low opacity: readable as a mark, never hides the content. */
const NAVY = rgb(0x16 / 255, 0x3c / 255, 0x56 / 255);

/**
 * Burns a per-viewer watermark into every page of a (sanitized) PDF: the viewer's
 * name, corporate id, IP address and the time, tiled diagonally. Used for confidential files,
 * which are view-only (CLAUDE.md §4: no download / print / copy, watermark).
 */
export async function watermarkPdf(sanitized: Buffer, viewer: WatermarkViewer, at: Date, label: string): Promise<Buffer> {
  const doc = await PDFDocument.load(sanitized, { updateMetadata: false });
  const writer = TextWriter.attach(doc);
  const ip = printableIp(viewer.ip);
  const stamp = `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC · ${viewer.marker}${ip ? ` · IP ${ip}` : ''}`;
  const lines = [`${label} · ${viewer.fullName}`, stamp];

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(10, Math.min(width, height) / 32);
    const stepX = size * 22;
    const stepY = size * 9;
    for (let y = -height; y < height * 1.5; y += stepY) {
      for (let x = -width / 2; x < width * 1.2; x += stepX) {
        for (const [i, line] of lines.entries()) {
          await writer.draw(page, line, { x, y: y - i * size * 1.4, size, color: NAVY, opacity: 0.14, rotate: 30 });
        }
      }
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
