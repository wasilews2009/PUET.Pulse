import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDisposition, safeFileName, sniffType } from '../src/files/file-types';
import { ClamdScanner, parseClamdReply } from '../src/files/malware-scanner';
import { findActiveContent, PdfRejectedError, sanitizePdf } from '../src/files/pdf-sanitizer';
import { watermarkPdf } from '../src/files/watermark';
import { maliciousPdf, plainPdf } from './fixtures/pdfs';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe('PDF CDR (Content Disarm & Reconstruction)', () => {
  it('weaponized PDF: strips JavaScript, OpenAction, launch actions, external links, embedded files and XFA', async () => {
    const bad = await maliciousPdf();
    expect(findActiveContent(await PDFDocument.load(bad))).toEqual(
      expect.arrayContaining(['/JavaScript', '/OpenAction', '/S /Launch', '/S /URI', '/EmbeddedFiles', '/XFA', '/AA']),
    );
    const clean = await sanitizePdf(bad);
    expect(clean.pageCount).toBe(1);
    expect(findActiveContent(await PDFDocument.load(clean.bytes))).toEqual([]);
    const raw = clean.bytes.toString('latin1');
    for (const needle of ['app.alert', 'cmd.exe', 'evil.example', 'payload.exe', '<xdp:xdp']) expect(raw).not.toContain(needle);
  });

  it('keeps the visible page content', async () => {
    const clean = await sanitizePdf(await plainPdf('Order', 3));
    expect(clean.pageCount).toBe(3);
    const doc = await PDFDocument.load(clean.bytes);
    expect(doc.getPage(0).getSize()).toEqual({ width: 595, height: 842 });
  });

  it('refuses encrypted or malformed PDFs instead of serving them', async () => {
    await expect(sanitizePdf(Buffer.from('%PDF-1.7\nnot really a pdf'))).rejects.toBeInstanceOf(PdfRejectedError);
    const doc = await PDFDocument.load(await plainPdf());
    const plain = Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');
    expect(plain).toContain('trailer');
    const enc = Buffer.from(plain.replace(/trailer\s*<</, 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>'), 'latin1');
    await expect(sanitizePdf(enc)).rejects.toBeInstanceOf(PdfRejectedError);
  });

  it('DLP: a confidential view is watermarked per viewer and stays free of active content', async () => {
    const clean = await sanitizePdf(await plainPdf());
    const marked = await watermarkPdf(clean.bytes, { fullName: "Мар'яна Іваненко", marker: 'EMP-0042' }, new Date('2026-11-23T10:00:00Z'), 'ПУЕТ · Конфіденційно');
    expect(marked.length).toBeGreaterThan(clean.bytes.length);
    expect(findActiveContent(await PDFDocument.load(marked))).toEqual([]);
  });
});

describe('content sniffing and names', () => {
  it('types come from the bytes, not from the client', async () => {
    expect(sniffType(await plainPdf())).toBe('application/pdf');
    expect(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png');
    expect(sniffType(Buffer.from('Розклад занять\n'))).toBe('text/plain');
    expect(sniffType(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBeNull(); // PE executable
    const docm = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml word/document.xml word/vbaProject.bin')]);
    expect(sniffType(docm)).toBeNull(); // macro-enabled Office
  });

  it('file names cannot carry paths, control or bidi-override characters', () => {
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('invoice‮fdp.exe')).toBe('invoicefdp.exe');
    expect(contentDisposition('attachment', 'Наказ "№1".pdf')).toBe(
      `attachment; filename="_____ __1_.pdf"; filename*=UTF-8''${encodeURIComponent('Наказ "№1".pdf')}`,
    );
  });
});

describe('ClamAV (clamd INSTREAM)', () => {
  let server: Server;
  let port: number;
  let received = Buffer.alloc(0);

  beforeAll(async () => {
    server = createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!buf.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return;
        // Parse length-prefixed chunks until the zero-length terminator.
        let off = 10;
        const parts: Buffer[] = [];
        while (off + 4 <= buf.length) {
          const len = buf.readUInt32BE(off);
          if (len === 0) {
            received = Buffer.concat(parts);
            socket.end(received.includes('EICAR-STANDARD') ? 'stream: Eicar-Signature FOUND\0' : 'stream: OK\0');
            return;
          }
          if (off + 4 + len > buf.length) return;
          parts.push(buf.subarray(off + 4, off + 4 + len));
          off += 4 + len;
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it('streams the file in chunks and reports a clean file', async () => {
    const body = Buffer.alloc(200_000, 7);
    await expect(new ClamdScanner('127.0.0.1', port).scan(body)).resolves.toEqual({ clean: true });
    expect(received.equals(body)).toBe(true);
  });

  it('malware upload: detects the EICAR test file', async () => {
    await expect(new ClamdScanner('127.0.0.1', port).scan(Buffer.from(EICAR))).resolves.toEqual({ clean: false, signature: 'Eicar-Signature' });
  });

  it('fails closed: errors and an unreachable scanner never count as clean', async () => {
    expect(() => parseClamdReply('INSTREAM size limit exceeded. ERROR')).toThrow();
    await expect(new ClamdScanner('127.0.0.1', 1, 2000).scan(Buffer.from('x'))).rejects.toThrow();
  });
});
