import { createHash } from 'node:crypto';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { TextWriter } from '../files/fonts';
import { verifyDetachedCms } from './cms';

/**
 * PAdES (ETSI EN 319 142, baseline B-B) for the internal УЕП, in two steps:
 *
 *  1. `preparePades` copies the served (sanitized) PDF, draws a visible stamp
 *     with a QR code to the public verification page, and adds an empty
 *     signature field: a /Sig dictionary with SubFilter ETSI.CAdES.detached, a
 *     fixed-size /Contents placeholder and the /ByteRange that covers the whole
 *     file except that placeholder. It returns the SHA-256 of the byte ranges.
 *  2. The client signs that digest on the device (@puet/signing, CMS SignedData
 *     with signing-certificate-v2, no signing-time attribute), and
 *     `embedCms` writes the CMS into the placeholder.
 *
 * This is PDF structure only: hashing is Node SHA-256, the signature is made by
 * WebCrypto on the client and checked with PKI.js (`verifyDetachedCms`).
 */

/** Room for the CMS (DER bytes): signer certificate + signed attributes + ECDSA signature fit in far less. */
export const PADES_CONTENTS_BYTES = 16 * 1024;
const BYTE_RANGE_PLACEHOLDER = '**********';
const BYTE_RANGE_RE = /\/ByteRange\s*\[\s*0\s+\/\*{10}\s+\/\*{10}\s+\/\*{10}\s*\]/;

export interface PadesStamp {
  signerName: string;
  /** Position, department, or "Студент". */
  signerTitle: string | null;
  certificateSerial: string;
  signedAt: Date;
  verifyUrl: string | null;
}

export interface PreparedPades {
  pdf: Buffer;
  byteRange: [number, number, number, number];
  /** SHA-256 of the bytes covered by /ByteRange: the message digest the signer signs. */
  digest: Buffer;
}

export class PadesError extends Error {}

const NAVY = rgb(0x16 / 255, 0x3c / 255, 0x56 / 255);
const INK = rgb(0.1, 0.12, 0.14);
const MUTED = rgb(0.38, 0.42, 0.46);

const fmt = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

async function drawStamp(doc: PDFDocument, s: PadesStamp) {
  const page = doc.getPage(doc.getPageCount() - 1);
  const { width } = page.getSize();
  const w = TextWriter.attach(doc);
  const boxW = 250;
  const boxH = 78;
  const x = Math.max(12, width - boxW - 28);
  const y = 24;
  page.drawRectangle({ x, y, width: boxW, height: boxH, color: rgb(1, 1, 1), opacity: 0.92, borderColor: NAVY, borderWidth: 1 });
  page.drawRectangle({ x, y: y + boxH - 16, width: boxW, height: 16, color: NAVY });
  await w.draw(page, 'ПІДПИСАНО УЕП · ПУЕТ', { x: x + 8, y: y + boxH - 12, size: 7.5, color: rgb(1, 1, 1), weight: 600 });
  const textX = x + 8;
  await w.draw(page, s.signerName.slice(0, 48), { x: textX, y: y + boxH - 30, size: 8, color: INK, weight: 600 });
  if (s.signerTitle) await w.draw(page, s.signerTitle.slice(0, 52), { x: textX, y: y + boxH - 41, size: 6.5, color: MUTED });
  await w.draw(page, fmt(s.signedAt), { x: textX, y: y + 22, size: 6.5, color: INK });
  await w.draw(page, `Сертифікат ${s.certificateSerial.slice(0, 24)}`, { x: textX, y: y + 12, size: 6.5, color: MUTED });
  await w.draw(page, 'PAdES · Регламент ЕДО ПУЕТ', { x: textX, y: y + 3, size: 5.5, color: MUTED });

  if (s.verifyUrl) {
    const qr = QRCode.create(s.verifyUrl, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const size = 56;
    const cell = size / n;
    const qx = x + boxW - size - 6;
    const qy = y + 4;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.modules.get(r, c)) page.drawRectangle({ x: qx + c * cell, y: qy + (n - 1 - r) * cell, width: cell, height: cell, color: NAVY });
      }
    }
  }
  return page;
}

/** Builds the stamped copy with an empty signature field. The input is the served (sanitized) PDF. */
export async function preparePades(base: Buffer, stamp: PadesStamp): Promise<PreparedPades> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(base, { updateMetadata: false });
  } catch {
    throw new PadesError('The document cannot be stamped');
  }
  const page = await drawStamp(doc, stamp);
  const ctx = doc.context;
  const sig = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.CAdES.detached',
    ByteRange: ctx.obj([PDFNumber.of(0), PDFName.of(BYTE_RANGE_PLACEHOLDER), PDFName.of(BYTE_RANGE_PLACEHOLDER), PDFName.of(BYTE_RANGE_PLACEHOLDER)]),
    Contents: PDFHexString.of('0'.repeat(PADES_CONTENTS_BYTES * 2)),
    Name: PDFHexString.fromText(stamp.signerName),
    Reason: PDFHexString.fromText('Підписано УЕП (внутрішній ЦСК ПУЕТ)'),
    M: PDFString.fromDate(stamp.signedAt),
  });
  const sigRef = ctx.register(sig);
  // An invisible signature widget: the visible stamp is page content drawn above.
  const widget = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: [0, 0, 0, 0], V: sigRef, T: PDFString.of('PUET-UEP-1'), F: 132, P: page.ref }),
  );
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (annots) annots.push(widget);
  else page.node.set(PDFName.of('Annots'), ctx.obj([widget]));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ SigFlags: 3, Fields: [widget] }));

  const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  return withByteRange(bytes);
}

function withByteRange(pdf: Buffer): PreparedPades {
  const text = pdf.toString('latin1');
  const br = BYTE_RANGE_RE.exec(text);
  const placeholder = `<${'0'.repeat(PADES_CONTENTS_BYTES * 2)}>`;
  const contentsStart = text.indexOf(placeholder);
  if (!br || contentsStart < 0 || text.indexOf(placeholder, contentsStart + 1) >= 0) throw new PadesError('Signature placeholder not found');
  const contentsEnd = contentsStart + placeholder.length;
  const byteRange: [number, number, number, number] = [0, contentsStart, contentsEnd, pdf.length - contentsEnd];
  const written = `/ByteRange [${byteRange.join(' ')}]`;
  if (written.length > br[0].length) throw new PadesError('ByteRange does not fit');
  const out = Buffer.from(pdf);
  out.write(written.padEnd(br[0].length, ' '), br.index, 'latin1');
  return { pdf: out, byteRange, digest: rangeDigest(out, byteRange) };
}

export function signedContent(pdf: Buffer, [a, b, c, d]: readonly number[]): Buffer {
  return Buffer.concat([pdf.subarray(a!, a! + b!), pdf.subarray(c!, c! + d!)]);
}

function rangeDigest(pdf: Buffer, byteRange: readonly number[]) {
  return createHash('sha256').update(signedContent(pdf, byteRange)).digest();
}

/** Writes the CMS (DER) into the /Contents placeholder. The byte ranges are left untouched. */
export function embedCms(prepared: Buffer, cmsDer: Buffer): Buffer {
  const found = extractPades(prepared, { allowEmpty: true });
  if (cmsDer.length > PADES_CONTENTS_BYTES) throw new PadesError('Signature is too large');
  const out = Buffer.from(prepared);
  out.write(cmsDer.toString('hex').toUpperCase().padEnd(PADES_CONTENTS_BYTES * 2, '0'), found.byteRange[1] + 1, 'latin1');
  return out;
}

export interface ExtractedPades {
  byteRange: [number, number, number, number];
  /** DER of the CMS, without the zero padding. */
  cms: Buffer;
  /** The bytes the signature covers. */
  content: Buffer;
}

/**
 * Reads the single PAdES signature of a copy made by `preparePades`: the last
 * /ByteRange must start at 0, leave exactly one hex gap and end at the end of
 * the file, so nothing outside the signed ranges (except the CMS) exists.
 */
export function extractPades(pdf: Buffer, opts: { allowEmpty?: boolean } = {}): ExtractedPades {
  const text = pdf.toString('latin1');
  const matches = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  if (matches.length !== 1) throw new PadesError('Expected exactly one signature');
  const [a, b, c, d] = matches[0]!.slice(1, 5).map(Number) as [number, number, number, number];
  if (a !== 0 || b <= 0 || c <= b || c + d !== pdf.length) throw new PadesError('ByteRange does not cover the document');
  const gap = text.slice(b, c);
  if (!/^<[0-9A-Fa-f]+>$/.test(gap)) throw new PadesError('Signature contents are malformed');
  const raw = Buffer.from(gap.slice(1, -1), 'hex');
  const length = derLength(raw);
  if (length === null && !opts.allowEmpty) throw new PadesError('The document is not signed');
  // Only zero padding may follow the CMS.
  if (length !== null && raw.subarray(length).some((x) => x !== 0)) throw new PadesError('Signature contents are malformed');
  return { byteRange: [a, b, c, d], cms: length === null ? Buffer.alloc(0) : raw.subarray(0, length), content: signedContent(pdf, [a, b, c, d]) };
}

/** Total length of a DER SEQUENCE at the start of `buf`, or null when there is none. */
function derLength(buf: Buffer): number | null {
  if (buf.length < 2 || buf[0] !== 0x30) return null;
  const first = buf[1]!;
  if (first < 0x80) return first + 2 <= buf.length ? first + 2 : null;
  const n = first & 0x7f;
  if (n === 0 || n > 3 || buf.length < 2 + n) return null;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + buf[2 + i]!;
  return 2 + n + len <= buf.length ? 2 + n + len : null;
}

/** The signature field is still the one we made: catches a copy whose dictionary was swapped. */
export async function checkSignatureField(pdf: Buffer): Promise<boolean> {
  try {
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    const form = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    const fields = form?.lookupMaybe(PDFName.of('Fields'), PDFArray);
    if (!fields || fields.size() !== 1) return false;
    const widget = fields.lookup(0, PDFDict);
    const v = widget.lookup(PDFName.of('V'), PDFDict);
    return v.get(PDFName.of('SubFilter'))?.toString() === '/ETSI.CAdES.detached';
  } catch {
    return false;
  }
}

/**
 * Re-checks a stored PAdES copy: byte-identical to what was recorded, exactly
 * one signature covering the whole file, our signature field, a valid CMS.
 */
export async function verifyPadesCopy(copy: Buffer | null | undefined, expectedSha256: string | null): Promise<boolean> {
  if (!copy || !expectedSha256 || createHash('sha256').update(copy).digest('hex') !== expectedSha256) return false;
  try {
    const x = extractPades(copy);
    if (!(await checkSignatureField(copy))) return false;
    await verifyDetachedCms(x.cms, x.content);
    return true;
  } catch {
    return false;
  }
}
