import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Resource } from '@puet/policy-engine';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PDFDocument, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { TextWriter } from '../files/fonts';
import { FilesService } from '../files/files.service';
import { OBJECT_STORE, type ObjectStore } from '../files/object-store';
import { PrismaService } from '../prisma/prisma.service';
import { verifyDetachedCms } from './cms';
import { levelOf } from './signatures.service';

type Lang = 'uk' | 'en';

const T = {
  uk: {
    title: 'Протокол перевірки електронних підписів',
    document: 'Документ',
    digest: 'SHA-256',
    pages: 'Сторінок',
    integrity: 'Цілісність',
    intact: 'не змінено',
    modified: 'ЗМІНЕНО',
    signatures: 'Підписи',
    none: 'Підписів немає',
    valid: 'дійсний',
    invalid: 'НЕДІЙСНИЙ',
    signedAt: 'Час підпису (сервер)',
    tsp: 'Позначка часу (TSP)',
    certificate: 'Сертифікат',
    status: 'Статус сертифіката',
    route: 'Маршрут погодження',
    checkedAt: 'Перевірено',
    scan: 'Скануйте QR-код, щоб перевірити документ онлайн',
    uep: 'УЕП (внутрішній ЦСК ПУЕТ)',
    kep: 'КЕП (кваліфікований надавач)',
  },
  en: {
    title: 'Electronic signature verification report',
    document: 'Document',
    digest: 'SHA-256',
    pages: 'Pages',
    integrity: 'Integrity',
    intact: 'unchanged',
    modified: 'MODIFIED',
    signatures: 'Signatures',
    none: 'No signatures',
    valid: 'valid',
    invalid: 'INVALID',
    signedAt: 'Signed at (server)',
    tsp: 'Timestamp (TSP)',
    certificate: 'Certificate',
    status: 'Certificate status',
    route: 'Approval route',
    checkedAt: 'Checked at',
    scan: 'Scan the QR code to verify the document online',
    uep: 'Advanced e-signature (PUET internal CA)',
    kep: 'Qualified e-signature (QTSP)',
  },
} as const;

export interface SignatureCheck {
  id: string;
  signer: { fullName: string; title: string | null };
  level: 'УЕП' | 'КЕП';
  format: string;
  signedAt: string;
  claimedSigningTime: string | null;
  tspTime: string | null;
  certificate: { serialNumber: string; issuer: string; notAfter: string; status: string; revokedAt: string | null };
  digestMatches: boolean;
  /** Valid: the signed digest equals the document, the CMS verifies (УЕП) and the certificate was not revoked before signing. */
  valid: boolean;
}

export interface VerificationProtocol {
  document: { id: string; fileName?: string; sha256: string; sizeBytes: number; pages: number | null; integrity: 'intact' | 'modified' };
  signatures: SignatureCheck[];
  approval: { title?: string; status: string; steps: { position: number; approverName: string; status: string; decidedAt: string | null }[] } | null;
  checkedAt: string;
  verifyUrl?: string;
}

/**
 * Verification protocol of a signed document: integrity of the served bytes,
 * every signature re-checked, certificate status now and at signing time, the
 * approval route, and a QR code to an unguessable public verification link.
 */
@Injectable()
export class VerificationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  /** 128+ bit code derived with HMAC-SHA256: nothing to store, cannot be guessed or enumerated. */
  code(fileId: string): string {
    const secret = this.config.pki.verifyCodeSecret;
    if (!secret) throw new ServiceUnavailableException('Document verification is not configured');
    return createHmac('sha256', secret).update(`puet-verify.v1:${fileId}`).digest('base64url').slice(0, 26);
  }

  verifyUrl(fileId: string) {
    return `${this.config.webOrigin}/verify/${fileId}/${this.code(fileId)}`;
  }

  checkCode(fileId: string, code: string): boolean {
    if (!this.config.pki.verifyCodeSecret) return false;
    const expected = Buffer.from(this.code(fileId));
    const got = Buffer.from(code);
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  async protocol(file: Resource, mode: 'full' | 'public', now = new Date()): Promise<VerificationProtocol> {
    const { file: f, body } = await this.files.servedBytes(file);
    const digest = createHash('sha256').update(body).digest('hex');
    const rows = await this.prisma.documentSignature.findMany({
      where: { fileId: f.id },
      orderBy: { createdAt: 'asc' },
      include: {
        certificate: true,
        signer: { select: { fullNameUk: true, staffProfile: { select: { position: true } }, studentProfile: { select: { id: true } } } },
      },
    });
    const signatures: SignatureCheck[] = [];
    for (const r of rows) {
      const digestMatches = r.signedDigest === digest;
      let cmsOk = r.provider !== 'INTERNAL_PKI';
      if (r.provider === 'INTERNAL_PKI' && digestMatches) {
        const sig = await this.store.get('attachments', r.signatureKey);
        cmsOk = !!sig && (await verifyDetachedCms(sig, body).then(() => true, () => false));
      }
      const revokedBefore = r.certificate.revokedAt !== null && r.certificate.revokedAt <= r.createdAt;
      signatures.push({
        id: r.id,
        signer: { fullName: r.signer.fullNameUk, title: r.signer.staffProfile?.position ?? (r.signer.studentProfile ? 'Студент' : null) },
        level: levelOf(r.provider),
        format: r.format,
        signedAt: r.createdAt.toISOString(),
        claimedSigningTime: r.claimedSigningTime?.toISOString() ?? null,
        tspTime: r.tspTimestamp?.toISOString() ?? null,
        certificate: {
          serialNumber: r.certificate.serialNumber,
          issuer: r.certificate.issuerDn,
          notAfter: r.certificate.notAfter.toISOString(),
          status: r.certificate.status,
          revokedAt: r.certificate.revokedAt?.toISOString() ?? null,
        },
        digestMatches,
        valid: digestMatches && cmsOk && !revokedBefore,
      });
    }
    const route = await this.prisma.approvalRoute.findFirst({
      where: { fileId: f.id, status: { not: 'CANCELLED' } },
      orderBy: { createdAt: 'desc' },
      include: { steps: { orderBy: { position: 'asc' }, include: { approver: { select: { fullNameUk: true } } } } },
    });
    return {
      document: {
        id: f.id,
        ...(mode === 'full' ? { fileName: f.fileName } : {}),
        sha256: digest,
        sizeBytes: body.length,
        pages: f.pageCount,
        integrity: digest === f.servedSha256 ? 'intact' : 'modified',
      },
      signatures,
      approval: route
        ? {
            ...(mode === 'full' ? { title: route.title } : {}),
            status: route.status,
            steps: route.steps.map((s) => ({ position: s.position, approverName: s.approver.fullNameUk, status: s.status, decidedAt: s.decidedAt?.toISOString() ?? null })),
          }
        : null,
      checkedAt: now.toISOString(),
      ...(mode === 'full' && this.config.pki.verifyCodeSecret ? { verifyUrl: this.verifyUrl(f.id) } : {}),
    };
  }

  /** Public view behind the QR code. Unknown file, wrong code or no signatures: the same 404. */
  async publicProtocol(fileId: string, code: string, now = new Date()) {
    const file = this.checkCode(fileId, code) ? await this.prisma.fileObject.findUnique({ where: { id: fileId }, select: { id: true, tenantId: true, _count: { select: { signatures: true } } } }) : null;
    if (!file || file._count.signatures === 0) throw new NotFoundException('Not found');
    return this.protocol({ type: 'file', id: file.id, tenantId: file.tenantId }, 'public', now);
  }

  /** Lets a recipient check that their copy is byte-identical to the signed document. */
  async publicCheck(fileId: string, code: string, bytes: Buffer) {
    const p = await this.publicProtocol(fileId, code);
    return { matches: createHash('sha256').update(bytes).digest('hex') === p.document.sha256 };
  }

  async qrSvg(url: string): Promise<string> {
    return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#163C56', light: '#FFFFFF' } });
  }

  /** The protocol as a one-or-more page A4 PDF with a QR code (Inter, PUET navy). */
  async protocolPdf(p: VerificationProtocol, lang: Lang): Promise<Buffer> {
    const t = T[lang];
    const doc = await PDFDocument.create();
    doc.setTitle(t.title);
    doc.setProducer('PUET.Pulse');
    const w = TextWriter.attach(doc);
    const navy = rgb(0x16 / 255, 0x3c / 255, 0x56 / 255);
    const terracotta = rgb(0xdf / 255, 0x48 / 255, 0x27 / 255);
    const ink = rgb(0.1, 0.12, 0.14);
    const muted = rgb(0.38, 0.42, 0.46);
    let page = doc.addPage([595, 842]);
    let y = 790;
    const newPageIfNeeded = (need: number) => {
      if (y - need < 60) {
        page = doc.addPage([595, 842]);
        y = 790;
      }
    };
    const line = async (label: string, value: string, color = ink) => {
      newPageIfNeeded(16);
      await w.draw(page, label, { x: 48, y, size: 9, color: muted });
      await w.draw(page, value, { x: 190, y, size: 9, color });
      y -= 15;
    };

    page.drawRectangle({ x: 0, y: 812, width: 595, height: 30, color: navy });
    await w.draw(page, 'ПУЕТ · PUET.Pulse', { x: 48, y: 822, size: 10, color: rgb(1, 1, 1), weight: 600 });
    await w.draw(page, t.title, { x: 48, y, size: 16, color: navy, weight: 600 });
    y -= 30;

    await w.draw(page, t.document, { x: 48, y, size: 11, color: navy, weight: 600 });
    y -= 18;
    if (p.document.fileName) await line('', p.document.fileName);
    await line(t.digest, p.document.sha256.slice(0, 32));
    await line('', p.document.sha256.slice(32));
    if (p.document.pages) await line(t.pages, String(p.document.pages));
    await line(t.integrity, p.document.integrity === 'intact' ? t.intact : t.modified, p.document.integrity === 'intact' ? ink : terracotta);
    await line(t.checkedAt, p.checkedAt.replace('T', ' ').slice(0, 19) + ' UTC');
    y -= 10;

    await w.draw(page, t.signatures, { x: 48, y, size: 11, color: navy, weight: 600 });
    y -= 18;
    if (p.signatures.length === 0) await line('', t.none);
    for (const [i, s] of p.signatures.entries()) {
      newPageIfNeeded(110);
      await w.draw(page, `${i + 1}. ${s.signer.fullName}${s.signer.title ? `, ${s.signer.title}` : ''}`, { x: 48, y, size: 10, color: ink, weight: 600 });
      await w.draw(page, s.valid ? t.valid : t.invalid, { x: 470, y, size: 10, color: s.valid ? navy : terracotta, weight: 600 });
      y -= 16;
      await line('', s.level === 'КЕП' ? t.kep : t.uep);
      await line(t.signedAt, s.signedAt.replace('T', ' ').slice(0, 19) + ' UTC');
      if (s.tspTime) await line(t.tsp, s.tspTime.replace('T', ' ').slice(0, 19) + ' UTC');
      await line(t.certificate, s.certificate.serialNumber.slice(0, 40));
      await line(t.status, s.certificate.status + (s.certificate.revokedAt ? ` (${s.certificate.revokedAt.slice(0, 10)})` : ''));
      y -= 6;
    }

    if (p.approval) {
      newPageIfNeeded(40 + p.approval.steps.length * 15);
      y -= 4;
      await w.draw(page, `${t.route}: ${p.approval.status}`, { x: 48, y, size: 11, color: navy, weight: 600 });
      y -= 18;
      for (const s of p.approval.steps) await line(`${s.position}. ${s.approverName}`.slice(0, 30), `${s.status}${s.decidedAt ? ` · ${s.decidedAt.slice(0, 10)}` : ''}`);
    }

    if (p.verifyUrl) {
      const first = doc.getPage(0);
      const qr = QRCode.create(p.verifyUrl, { errorCorrectionLevel: 'M' });
      const n = qr.modules.size;
      const size = 96;
      const cell = size / n;
      const x0 = 595 - 48 - size;
      const y0 = 842 - 60 - size;
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.modules.get(r, c)) first.drawRectangle({ x: x0 + c * cell, y: y0 + (n - 1 - r) * cell, width: cell, height: cell, color: navy });
        }
      }
      await w.draw(first, t.scan, { x: x0 - 110, y: y0 - 14, size: 7, color: muted });
    }
    return Buffer.from(await doc.save());
  }
}
