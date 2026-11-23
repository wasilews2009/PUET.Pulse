import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { PDFDocument, PDFName } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDisposition, safeFileName, sniffType } from '../src/files/file-types';
import { ClamdScanner, parseClamdReply } from '../src/files/malware-scanner';
import { parseRange } from '../src/files/files.controller';
import { ServedBytesCache } from '../src/files/files.service';
import { findActiveContent, PdfRejectedError, sanitizePdf } from '../src/files/pdf-sanitizer';
import { printableIp, watermarkPdf } from '../src/files/watermark';
import { maliciousPdf, outlinedPdf, plainPdf } from './fixtures/pdfs';

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

describe('Secure Viewer navigation (Phase 9)', () => {
  it('outline survives CDR as plain data only: titles and pages, no actions, no outline in the served PDF', async () => {
    const clean = await sanitizePdf(await outlinedPdf());
    expect(clean.outline).toEqual([
      { title: 'Розділ 1. Загальні положення', page: 1, level: 0 },
      { title: '1.1 Scope', page: 2, level: 1 },
      // Bidi override and control characters are neutralized (no "exe.pdf" spoofing in the UI).
      { title: 'Budget exe.pdf', page: 3, level: 0 },
      { title: 'Annex', page: 3, level: 0 },
    ]);
    const served = await PDFDocument.load(clean.bytes);
    expect(findActiveContent(served)).toEqual([]);
    expect(served.catalog.get(PDFName.of('Outlines'))).toBeUndefined();
    expect(clean.bytes.toString('latin1')).not.toContain('app.alert');
  });

  it('a PDF without an outline gives an empty table of contents', async () => {
    expect((await sanitizePdf(await plainPdf())).outline).toEqual([]);
  });

  it('range requests: single ranges only, bounded to the file', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    for (const bad of ['bytes=100-', 'bytes=5-1', 'bytes=0-1,5-9', 'items=0-1', 'bytes=-', 'bytes=-0']) expect(parseRange(bad, 100)).toBe('invalid');
  });

  it('the verified-bytes cache is bounded by size and age', () => {
    const cache = new ServedBytesCache(100, 1000);
    cache.set('a', Buffer.alloc(20), 0);
    cache.set('b', Buffer.alloc(20), 0);
    cache.set('big', Buffer.alloc(60), 0); // over a quarter of the budget: never cached
    expect(cache.get('big', 0)).toBeUndefined();
    expect(cache.get('a', 500)?.length).toBe(20);
    expect(cache.get('a', 1500)).toBeUndefined();
    for (const k of ['c', 'd', 'e', 'f', 'g']) cache.set(k, Buffer.alloc(20), 0);
    expect(cache.get('b', 0)).toBeUndefined(); // evicted, oldest first
    expect(cache.get('g', 0)?.length).toBe(20);
  });

  it('watermark IP: only a real IPv4 / IPv6 literal is printed', async () => {
    expect(printableIp('10.1.2.3')).toBe('10.1.2.3');
    expect(printableIp('::ffff:192.168.0.7')).toBe('192.168.0.7');
    expect(printableIp('2001:db8::1')).toBe('2001:db8::1');
    for (const bad of [null, undefined, '', 'evil<script>', '1.2.3.4 · Approved', 'localhost']) expect(printableIp(bad)).toBeNull();
    const clean = await sanitizePdf(await plainPdf());
    const marked = await watermarkPdf(clean.bytes, { fullName: 'Олена Коваль', marker: 'EMP-0042', ip: '10.1.2.3' }, new Date('2026-11-23T10:00:00Z'), 'ПУЕТ');
    const plain = await watermarkPdf(clean.bytes, { fullName: 'Олена Коваль', marker: 'EMP-0042' }, new Date('2026-11-23T10:00:00Z'), 'ПУЕТ');
    expect(marked.length).toBeGreaterThan(plain.length);
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
