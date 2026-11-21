# Phase 4 checkpoint (work in progress)

Saved 2026-11-21 so work can resume in a new session. Delete this file when Phase 4 is done.

## Done (tested)

- Policy engine: `FILE_ANNOTATE`, `APPROVAL_ROUTE_CREATE`; `Resource.isApprover`;
  approvers may view / sign / decide one file without channel membership;
  `DOCUMENT_APPROVE` only for route approvers; DLP still blocks downloads (57 tests).
- Migration `20261121030000_phase4_documents_pki`: scan / CDR / served-hash columns,
  annotation visibility, signer + revocation-check columns, route tenant, step
  `require_signature`; SQL guardrails (sanitized only when CLEAN, confidential = PDF,
  one active internal cert per user, immutable certificates, append-only signatures,
  one pending route per file, approved step needs a signature).
- `apps/api/src/files`: S3/MinIO + memory object store (SSE AES256), clamd INSTREAM
  scanner + fake, content sniffing allowlist, PDF CDR by rebuild (`pdf-sanitizer.ts`,
  verified on a weaponized PDF), per-viewer watermark with Inter fonts.
- `apps/api/src/pki`: `x509.ts` (root CA, CSR proof of possession, P-256 only,
  issuance from profile, CRL, OCSP responder), `cms.ts` (detached CAdES-BES verify),
  `signature-provider.ts` (`SignatureProvider`, `InternalPkiProvider`, `ExternalQesAdapter`
  for the EUSignCP gateway with mandatory OCSP + TSP).
- `packages/signing`: client key pair (non-extractable WebCrypto), CSR, `signDetached`,
  `signDigest`. `test/pki.test.ts` 10 tests.
- Config: S3_*, CLAMAV_*, FILE_MAX_MB, PKI_CA_*, PKI_PUBLIC_URL, PKI_CERT_DAYS,
  VERIFY_CODE_SECRET, QES_GATEWAY_URL / TOKEN.

## Next steps

1. `FilesService` + controller: raw upload `POST channels/:channelId/files`
   (`X-File-Name`, `?confidential`), refuse MANDATORY E2EE channels, sniff, quarantine,
   `process()` (claim by attempts, scan, CDR, move to attachments, `file.ready`),
   `GET files/:id`, `/view` (watermark if confidential, `no-store`, CSP sandbox),
   `/download`, channel file list. FILE resolver: compute `isApprover`.
2. Annotations CRUD (`files/:fileId/annotations`, private / shared, author only edits).
3. `PkiService`: CA loader (files, lazy), `POST/GET me/certificates`, self revoke,
   admin revoke (`admin/tenants/:tenantId/certificates/:id/revoke`), QES binding
   (HMAC challenge + name match), public `pki/ca.crt`, `pki/crl`, `pki/ocsp`, expiry job.
4. `SignaturesService`: `signing-info`, `POST files/:id/signatures` (provider verify,
   cert owned + ACTIVE, store `.p7s`), list.
5. `ApprovalsService`: create (approvers validated with policy + DM rule), inbox,
   decide (row lock, current step, signature required), cancel, realtime events.
6. Verification protocol: JSON + QR SVG, protocol PDF with QR, public
   `GET verify/:fileId/:code` (HMAC code) and `POST .../check`.
7. Jobs (scan sweeper, cert expiry), `scripts/init-ca.ts`, `.env.example`, seed.
8. Tests: clamd protocol, CDR, files/approvals/signatures end-to-end on PostgreSQL;
   CLAUDE.md / README; commit, PR #1 update, report to the owner.
