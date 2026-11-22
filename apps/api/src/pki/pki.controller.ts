import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/principal';
import { Public } from '../auth/public.decorator';
import { Authorize } from '../authz/authorize.decorator';
import { binary } from '../common/binary';
import { parse } from '../common/validation';
import { readRawBody } from '../files/files.service';
import { PkiService } from './pki.service';
import { SignaturesService, signInput } from './signatures.service';
import { VerificationService } from './verification.service';

const FILE = { type: ResourceType.FILE, idField: 'fileId' } as const;
const SELF = { type: ResourceType.SELF } as const;
const uuid = z.string().uuid();
const b64 = z.string().min(16).max(200_000).regex(/^[A-Za-z0-9+/=]+$/);
const certificateRequest = z.object({ csr: b64 }).strict();
const ownRevoke = z.object({ reason: z.enum(['KEY_COMPROMISE', 'UNSPECIFIED']).default('UNSPECIFIED') }).strict();
const adminRevoke = z
  .object({ reason: z.enum(['UNSPECIFIED', 'KEY_COMPROMISE', 'AFFILIATION_CHANGED', 'SUPERSEDED', 'CESSATION_OF_OPERATION']) })
  .strict();
const qesBind = z.object({ challenge: z.string().min(10).max(300), signature: b64 }).strict();
const code = z.string().regex(/^[A-Za-z0-9_-]{26}$/);

/** Certificates (УЕП / КЕП), document signatures, verification protocol and the public PKI endpoints. */
@Controller()
export class PkiController {
  constructor(
    @Inject(PkiService) private readonly pki: PkiService,
    @Inject(SignaturesService) private readonly signatures: SignaturesService,
    @Inject(VerificationService) private readonly verification: VerificationService,
  ) {}

  // ── Own certificates ──

  @Post('me/certificates')
  @Authorize(Action.CERTIFICATE_REQUEST, SELF)
  request(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.pki.requestCertificate(req.principal!, parse(certificateRequest, body).csr);
  }

  @Get('me/certificates')
  @Authorize(Action.CERTIFICATE_REQUEST, SELF)
  mine(@Req() req: AuthenticatedRequest) {
    return this.pki.myCertificates(req.principal!);
  }

  @Post('me/certificates/:certificateId/revoke')
  @Authorize(Action.CERTIFICATE_REQUEST, SELF)
  revokeOwn(@Req() req: AuthenticatedRequest, @Param('certificateId') id: string, @Body() body: unknown) {
    return this.pki.revokeOwn(req.principal!, parse(uuid, id), parse(ownRevoke, body ?? {}).reason);
  }

  @Get('me/certificates/qes/challenge')
  @Authorize(Action.CERTIFICATE_REQUEST, SELF)
  qesChallenge(@Req() req: AuthenticatedRequest) {
    return this.pki.qesChallenge(req.principal!);
  }

  @Post('me/certificates/qes')
  @Authorize(Action.CERTIFICATE_REQUEST, SELF)
  qesBind(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(qesBind, body);
    return this.pki.bindQes(req.principal!, input.challenge, input.signature);
  }

  @Post('admin/tenants/:tenantId/certificates/:certificateId/revoke')
  @Authorize(Action.CERTIFICATE_REVOKE, { type: ResourceType.CERTIFICATE, idField: 'tenantId' })
  adminRevoke(@Req() req: AuthenticatedRequest, @Param('certificateId') id: string, @Body() body: unknown) {
    return this.pki.revokeInTenant(req.principal!, req.authz!.resource, parse(uuid, id), parse(adminRevoke, body).reason);
  }

  // ── Signatures ──

  @Get('files/:fileId/signing-info')
  @Authorize(Action.DOCUMENT_SIGN, FILE)
  signingInfo(@Req() req: AuthenticatedRequest) {
    return this.signatures.signingInfo(req.authz!.resource);
  }

  @Post('files/:fileId/signatures')
  @Authorize(Action.DOCUMENT_SIGN, FILE)
  sign(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.signatures.sign(req.principal!, req.authz!.resource, parse(signInput, body));
  }

  @Get('files/:fileId/signatures')
  @Authorize(Action.FILE_VIEW, FILE)
  list(@Req() req: AuthenticatedRequest) {
    return this.signatures.list(req.authz!.resource);
  }

  // ── Verification protocol ──

  @Get('files/:fileId/verification')
  @Authorize(Action.FILE_VIEW, FILE)
  async protocol(@Req() req: AuthenticatedRequest) {
    const p = await this.verification.protocol(req.authz!.resource, 'full');
    return { ...p, ...(p.verifyUrl ? { qrSvg: await this.verification.qrSvg(p.verifyUrl) } : {}) };
  }

  @Get('files/:fileId/verification.pdf')
  @Authorize(Action.FILE_VIEW, FILE)
  async protocolPdf(@Req() req: AuthenticatedRequest, @Query('lang') lang: string | undefined, @Res() res: Response) {
    const p = await this.verification.protocol(req.authz!.resource, 'full');
    res.setHeader('Content-Disposition', 'inline; filename="verification.pdf"');
    binary(res, 'application/pdf', await this.verification.protocolPdf(p, lang === 'en' ? 'en' : 'uk'));
  }

  /** Behind the QR code: the unguessable code is the capability; minimal data, no file name. */
  @Public()
  @Get('verify/:fileId/:code')
  publicVerify(@Param('fileId') fileId: string, @Param('code') c: string) {
    return this.verification.publicProtocol(parse(uuid, fileId), parse(code, c));
  }

  @Public()
  @Post('verify/:fileId/:code/check')
  @HttpCode(200)
  async publicCheck(@Param('fileId') fileId: string, @Param('code') c: string, @Req() req: AuthenticatedRequest) {
    const body = await readRawBody(req as never, 100 * 1024 * 1024);
    return this.verification.publicCheck(parse(uuid, fileId), parse(code, c), body);
  }

  // ── Public PKI endpoints for relying parties ──

  @Public()
  @Get('pki/ca.crt')
  async caCert(@Res() res: Response) {
    binary(res, 'application/pkix-cert', await this.pki.caCertificate(), 'public, max-age=86400');
  }

  @Public()
  @Get('pki/crl')
  async crl(@Res() res: Response) {
    binary(res, 'application/pkix-crl', await this.pki.crl(), 'public, max-age=300');
  }

  @Public()
  @Post('pki/ocsp')
  @HttpCode(200)
  async ocsp(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const body = await readRawBody(req as never, 64 * 1024);
    binary(res, 'application/ocsp-response', await this.pki.ocsp(body));
  }
}
