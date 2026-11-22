# CLAUDE.md: PUET.Pulse

On-premise corporate messenger and operational communication platform of
**Poltava University of Economics and Trade (ПУЕТ / PUET)**.

Source of truth for requirements: the technical specification (ТЗ)
«Корпоративний месенджер та платформа оперативної комунікації ПУЕТ». This file
turns it into rules for anyone (human or AI) changing this repository. Read it
before writing code. When a rule here conflicts with convenience, the rule wins.

---

## 1. Security and cryptography guardrails (strictly enforced)

1. **No custom cryptography.** Never write your own encryption, hashing, key
   derivation, signature, random number or padding scheme. Use only audited
   libraries: `vodozemac` (via `@matrix-org/matrix-sdk-crypto-wasm`), WebCrypto,
   Node `crypto` primitives (SHA-256 / HMAC / CSPRNG only), PKI.js / node-forge
   for X.509 encoding, certified Ukrainian providers for КЕП.
2. **E2EE messaging.** vodozemac everywhere (owner decision, Phase 3): Olm
   (Double Ratchet) between devices and Megolm for room messages, 1-on-1 and
   groups alike, through `packages/e2ee` (`PulseCrypto`, wrapping the official
   `@matrix-org/matrix-sdk-crypto-wasm` OlmMachine). libsignal was dropped
   because it has no browser build. Device verification by QR (cross-signing),
   key backup (`m.megolm_backup.v1`) whose key is wrapped under a master
   passphrase with WebCrypto PBKDF2-SHA-256 (600k) + AES-256-GCM. The server
   stores only ciphertext (`messages.ciphertext`) and public keys. DB triggers:
   `MANDATORY` channels reject plaintext, `DISABLED` channels reject ciphertext.
3. **Ukrainian QES (КЕП) and internal PKI.** Never validate ДСТУ 4145-2002 /
   ДСТУ 7564:2014 / CAdES-X Long with raw OpenSSL or Node `crypto`. All signing
   goes through the `SignatureProvider` interface (Phase 4):
   - `ExternalQESAdapter`: wrapper for certified libraries (IIT `euscp.js` /
     EUSignCP server gateway). OCSP and TSP validation are mandatory.
   - `InternalUniversityPKI`: internal CA. Key pairs are generated **strictly
     client-side** (WebCrypto / PKCS#12 `.pfx` under a user passphrase, or
     WebAuthn). Private keys **never** leave the device. The client sends only a
     CSR; the CA issues a 1-year X.509 certificate bound to profile attributes,
     with CRL/OCSP revocation (`user_certificates.status`). Revoke on dismissal
     or expulsion. Internal signatures have УЕП status, not КЕП (Регламент ЕДО ПУЕТ).
4. **Zero-trust access control.** Every HTTP endpoint, WebSocket event and file
   download is authorized by RBAC (role) **and** ABAC (tenant, institute,
   department, dormitory, age / minor status). See section 4.
5. **PDF sanitization (CDR).** Every PDF is sanitized server-side before it
   reaches the built-in viewer: strip embedded JavaScript, active XFA/AcroForm
   actions, launch actions and external links. Serve only `sanitized_key`.
6. **Files.** Uploads land in the quarantine bucket, are scanned by ClamAV, and
   only `CLEAN` files are released. Buckets use SSE (AES-256), no anonymous access.
7. **Secrets.** Never commit `.env`, keys, `.pem`, `.p12`, `.pfx`. Never log
   tokens, message bodies, passphrases or personal phone numbers.
8. **Transport.** TLS 1.3 at the reverse proxy; HSTS; strict CSP. Infrastructure
   ports bind to `127.0.0.1` only.
9. **Authentication.** OIDC / SAML 2.0 via Keycloak / AD / LDAP sync. TOTP or
   WebAuthn is mandatory for `SUPER_ADMIN`, `RECTORATE`, `INSTITUTE_DIRECTOR`,
   `ADMIN_STAFF` (finance, HR), `TRUST_SERVICE_OFFICER` (`MFA_REQUIRED_ROLES`).
   Offboarding bumps `users.session_epoch`, which revokes every session at once.
   There is **no** development auth bypass; tests inject principals directly.
   MFA is enforced by the IdP; the API trusts only the `acr` / `amr` claims of the
   ID token validated by `openid-client` and never stores TOTP secrets.
10. **Sessions.** Opaque 256-bit tokens in an HttpOnly `__Host-` cookie
    (SameSite=Lax); Redis stores only their SHA-256. Absolute and idle timeouts.
    Every cookie-authenticated state-changing request must carry the web
    `Origin` (CSRF). Login redirects accept only same-site relative paths.
11. **Integrations.** ЄДЕБО / HR / ERP webhooks are authenticated by
    HMAC-SHA256 over the raw body (`X-PUET-Signature: t=..,v1=..`, 5-minute
    window), bound to one tenant and a list of allowed kinds, and require an
    `Idempotency-Key`. They act as a `SERVICE_BOT` principal that can only
    `sync.ingest`. No account is ever created at login (no self-registration).

## 2. Tech stack

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Backend | Node.js 22, NestJS 11, TypeScript (strict) |
| Data | PostgreSQL 16 (Prisma 6), Redis 7, MinIO (S3, SSE), ClamAV |
| Real-time | WebSockets (Socket.io, Redis pub/sub fan-out), WebRTC (LiveKit / mediasoup) |
| Frontend | React 19, TypeScript, Tailwind CSS, PDF.js Secure Viewer, PWA + desktop wrapper |
| Auth | OIDC / SAML 2.0 (Keycloak, AD, LDAP), TOTP / WebAuthn |
| Tests | Vitest |

## 3. Repository layout

```
apps/
  api/                 NestJS API
    src/auth/          OIDC login, MFA rules, principal factory, guards
    src/session/       Redis session store, cookie middleware (CSRF)
    src/authz/         PolicyGuard, @Authorize, resource resolvers
    src/integrations/  HMAC webhooks, zod schemas, sync + offboarding
    src/admin/         No-Code Admin Panel API
    src/audit/         hash-chained audit log
    src/messaging/     channels, messages, threads, DMs, presence, Quiet Hours API
    src/realtime/      Socket.io gateway (/ws) and Redis realtime bus
    src/notifications/ Quiet Hours decisions, Redis digest store
    src/provisioning/  channel auto-provisioning, background jobs
    src/e2ee/          Matrix-compatible key directory, to-device, key backup
    src/files/         quarantine, ClamAV, PDF CDR, watermark, viewer, annotations
    src/pki/           internal CA (CSR, CRL, OCSP), SignatureProvider, QES adapter,
                       signatures, verification protocol + QR
    src/approvals/     multi-step approval routes
    src/directory/     profile cards, directory search (canSeeInDirectory per row)
    src/polls/         polls, formal votes of collegial bodies, vote protocol PDF
    src/calls/         LiveKit calls: join tokens, webhook, revalidation (MediaServer)
    src/consultations/ lecturers' consultation slots and bookings
    src/bots/          corporate bots: inboxes, deanery, schedule, service desk,
                       chancellery, signed outbox, admissions consultant (RAG)
    src/trust/         anonymous appeals to trust services (pseudonyms, persona header)
    scripts/init-ca.ts one-time creation of the internal CA (keys outside the repo)
    scripts/grant-super-admin.ts  first SUPER_ADMIN from the console (once, audited)
    scripts/demo-data.ts          fictional people via signed sync webhooks (never in production)
    scripts/send-sync.ts          one signed sync batch from a JSON file (pilot before HR / ЄДЕБО)
  web/                 React 19 + Vite PWA client (served next to the API, /api prefix)
    src/api/           fetch client, DTO types, React Query hooks, batched cards
    src/features/      shell, chat, files (PDF.js viewer), signatures, approvals,
                       settings, admin
    src/i18n/          uk (default) and en dictionaries, same keys
    src/theme/         PUET tokens, Light / Dark, sanitized white-label overrides
  desktop/             Hardened Electron wrapper around the web client of one server
packages/
  shared/              Domain vocabulary: tenants, roles, actions, channel types,
                       content filter for minors (used by API and web)
  policy-engine/       Pure RBAC + ABAC policy decision point (no I/O)
  e2ee/                Client E2EE layer (vodozemac Olm/Megolm, backup, QR)
  signing/             Client УЕП: non-extractable WebCrypto keys, CSR, CAdES-BES (PKI.js)
  database/            Prisma schema, migrations, seed (PUET structure)
infra/                 Postgres init, MinIO bucket bootstrap + API account, nginx example (TLS 1.3, CSP),
                       demo Keycloak realm (trial only) + production realm script, systemd unit,
                       LiveKit config, demo.env.example, single-server/ (compose additions, env
                       generator, nginx for sso / meet, nightly backup)
docs/                  DEPLOYMENT.md (trial, tests, university rollout), SERVER_SETUP.md
                       (one-server pilot, step by step), USER_GUIDE.md
scripts/with-env.mjs   loads ./.env (or PULSE_ENV_FILE) for root scripts; existing env wins
assets/brand/          PUET logos (official SVG vectors, .ai source, raster originals)
.claude/skills/        Design skills used for GUI work (Phase 5)
docker-compose.yml     PostgreSQL, Redis, MinIO (+ init), ClamAV
```

Commands: `pnpm install`, `pnpm build`, `pnpm test`, `pnpm typecheck`,
`pnpm infra:up`, `pnpm db:deploy`, `pnpm db:seed`, `pnpm start:api`,
`pnpm demo:data` (trial only), `pnpm admin:bootstrap <corporate id>`. End-to-end tests against
PostgreSQL run with `RUN_DB_TESTS=1 DATABASE_URL=... pnpm test` (CI does this).

## 4. Access control rules (RBAC + ABAC)

The policy engine (`packages/policy-engine`) is the **only** place that decides
access. It is pure and synchronous, so HTTP, WebSocket and background jobs use
the same rules. Evaluation order, first deny wins, default deny:

1. account status (`ACTIVE` only) and grant expiry (guest TTL);
2. MFA for privileged roles;
3. admin-configured **DENY** policies (JSON DSL, `abac_policies`);
4. RBAC: permission matrix (`role_permissions`, default in `matrix.ts`) plus
   tenant coverage and, for administrative actions, scope coverage. An admin
   **ALLOW** policy may add a permission, but never skips step 5;
5. **hard guardrails** (not configurable):
   - membership / ownership on every channel, message and file (IDOR);
   - private rooms (`DIRECT`, `PRIVATE_GROUP`, `TRUST_ROOM`), confidential and
     `MANDATORY` E2EE channels are invisible to administrators. `SUPER_ADMIN`
     can read room metadata only with a recorded commission decision, and never
     messages;
   - students cannot DM the Rectorate; students DM lecturers only with a shared
     course offering in the current semester; trust services stay reachable;
   - minors (`PUET_LYCEUM`, age < 18): contact and directory visibility only
     inside their own tenant, with staff or with members of a shared group;
   - personal phones hidden (self and HR only); dormitory rooms visible only to
     the commandant of that dormitory;
   - guests: TTL grants, `GUEST_SPACE` channels only, no directory, no DMs;
   - archived course channels are read-only; announcement and emergency
     channels accept posts only from moderators;
   - confidential files are view-only (no download / print / copy, watermark).

**Rules for API code**

- Global guards: `AuthenticationGuard`, then `PolicyGuard`. Every handler must
  have `@Authorize(action, { type, idField })` or `@Public()`. An unannotated
  handler is denied (fail-closed). Do not disable or reorder these guards.
- Global `APP_GUARD`s do **not** run for WebSocket gateways. Every gateway must
  carry `@UseGuards(AuthenticationGuard, PolicyGuard)` and every
  `@SubscribeMessage` handler an `@Authorize` (a test checks this). The WS
  handshake checks `Origin` (CSWSH) and the session cookie; sessions are
  re-validated every 60 s and offboarding disconnects sockets.
- Realtime events are addressed per user and recipients are re-resolved from
  current memberships for every event; payloads carry ids and ciphertext only.
- Resource ids come from route params / query (HTTP) or the event payload (WS),
  are validated as UUIDs, and are resolved server-side by a `ResourceResolver`
  that computes membership for the caller. Never trust tenant, owner or
  membership fields sent by the client.
- Handlers read `req.authz.resource` and scope every query by its `tenantId`.
  Every Prisma query on tenant-owned data filters by `tenant_id`.
- Directory and list endpoints filter each row with `canSeeInDirectory()` or an
  equivalent SQL predicate; never return rows first and filter in the client.
- Denials return a uniform `403 Access denied` (no hint that an id exists).
- Every denial and every sensitive allow is written to the audit log. A
  sensitive action is refused if the audit write fails.
- Request bodies are validated with zod (`common/validation.ts`); validation
  errors list field paths, never the submitted values.
- Admin services re-check that every referenced id (institute, department,
  org unit, dormitory, group, role assignment) belongs to the authorized tenant.

**Sync and admin rules (Phase 2)**

- The sync owns only `role_assignments.source = SYNC` grants and may grant only
  `SYNC_ASSIGNABLE_ROLES`. `RECTORATE` and `SUPER_ADMIN` come only from the admin
  panel. Sync-owned grants cannot be revoked in the panel (fix them at the source).
- An offboarded person is never reactivated by a sync. Offboarding: status
  `OFFBOARDED`, `session_epoch + 1`, all sessions purged, internal certificates
  revoked (`AFFILIATION_CHANGED`), sync grants removed, archives kept.
- Separation of duties: nobody changes their own roles; cross-tenant grants only
  for `SUPER_ADMIN` / `RECTORATE`; guest grants must expire; the last
  `SUPER_ADMIN` cannot be removed; `SUPER_ADMIN` always keeps
  `SUPER_ADMIN_LOCKED` actions in the matrix.
- ABAC policies are validated with `validateCondition()` before saving; every
  matrix or policy change invalidates the policy cache and is audited with
  before/after values.
- After deploying a version that adds actions, run `pnpm db:seed` (idempotent):
  it adds the new default permissions to `role_permissions`.

**Messaging rules (Phase 3)**

- Provisioning (`provisionKey` channels for groups, courses, departments,
  institutes, dormitories, org units, emergency) owns only `AUTO` memberships
  and never touches `MANUAL` ones. It runs per tenant under an advisory lock
  after every sync batch. E2EE mode may only be raised to `MANDATORY`.
- Course channels require threads (only owners / moderators post top-level) and
  archive at semester end.
- Notifications obey Quiet Hours, Do Not Disturb, «На парі» and mute; Civil
  Protection / `EMERGENCY` messages bypass all of them. Held notifications go
  to a Redis morning digest; jobs run on one leader (Redis lock).
- Key directory zero trust: a user sees keys of self and of active users who
  share a non-`DISABLED` channel; everything else is silently dropped. Keys of
  a device never change once uploaded; removing a member rotates room keys.

**Documents and signature rules (Phase 4)**

- Upload → quarantine bucket → ClamAV (clamd INSTREAM) → release. Fail closed:
  a scanner error keeps the file in quarantine (job retries, then `FAILED`).
  The type is sniffed from the bytes against an allowlist (PDF, PNG, JPEG, WebP,
  text, OOXML without macros); the client's type and name are never trusted.
- PDFs are rebuilt by CDR (`files/pdf-sanitizer.ts`): only page content is copied
  into a new document; then the result is re-parsed and must contain no active
  construct. Encrypted or unparsable PDFs are refused. Only `sanitized_key` is
  ever served, viewed or signed (`served_sha256`).
- Confidential files must be PDFs: view-only, every view watermarked with the
  viewer's name, corporate id and time; download denied by the policy engine.
  Served files carry `Cache-Control: no-store`, `nosniff` and a sandbox CSP.
- Plaintext attachments are refused in `MANDATORY` E2EE channels (the server
  cannot scan client-encrypted bytes); those rooms use encrypted blobs (Phase 9).
- Approvers of a route may view and sign that one file without membership
  (`Resource.isApprover`, computed by the resolver); only they decide
  (`document.approve`). Steps are decided in order; approving a step that
  requires it needs the approver's own signature on the file. Routes respect
  DM rules (a student cannot route to the Rectorate).
- Internal CA: the CSR contributes only its ECDSA P-256 public key (proof of
  possession checked); the subject comes from the profile. One active internal
  certificate per person; a new one supersedes the old. CRL `GET /pki/crl`,
  OCSP `POST /pki/ocsp`, CA `GET /pki/ca.crt` are public for relying parties.
- A signature is accepted only through a `SignatureProvider`, with a
  certificate that belongs to the caller and is `ACTIVE`. КЕП certificates are
  bound first: a qualified signature over a server HMAC challenge whose holder
  name equals the profile name. `document_signatures` is append-only (trigger).
- Public verification `GET /verify/:fileId/:code`: the code is an HMAC of the
  file id (`VERIFY_CODE_SECRET`), wrong codes look like missing files, and the
  public view omits the file name. A signature stays valid if its certificate
  was revoked after signing.

**Web client rules (Phase 5)**

- The client is never a security boundary: it mirrors server rules only to
  hide controls that would be refused anyway. Every decision stays in the API.
- Same origin as the API (`/api`, Socket.io at `/api/ws`). Fetches use
  `credentials: 'same-origin'`; no tokens in JS, storage or URLs.
- CSP-compatible: no inline scripts or `<style>` blocks, no `eval`, no
  `dangerouslySetInnerHTML`. Message bodies render as text. SVG from the API
  (QR) is shown only as an `<img>` data URL. Only `'wasm-unsafe-eval'` is
  allowed, for vodozemac. Example proxy: `infra/nginx/pulse.conf`.
- Plaintext of E2EE messages stays in memory (React Query cache); file bytes are
  not cached (`gcTime 0`). The service worker caches only the app shell, never
  `/api` or `/verify`.
- PDF.js runs with `isEvalSupported: false`, `enableXfa: false`, no annotation
  or text layer (canvas only). Confidential files are view-only: no download,
  copy or print in the UI, plus the server watermark.
- Signing keys are non-extractable WebCrypto keys in IndexedDB; only the CSR and
  CMS signatures leave the device.
- White-label overrides apply only the six brand variables with `#RRGGBB`
  values (`theme/overrides.ts`). Login `returnTo` is a same-site relative path.
- Directory cards never include phones or email; the phone has its own endpoint
  (self and HR only). Hidden people are simply missing from card batches.

**Polls, votes and directives (Phase 6)**

- Polls live in E2EE-`DISABLED` channels only (the server stores the question and
  choices). In governance, announcement and emergency channels only moderators
  open them (`poll.create`); every member who is not read-only votes
  (`vote.cast`); the author or a moderator closes early (`poll.manage`).
- Formal votes (`formal`) are for `GOVERNANCE` channels: answers FOR / AGAINST /
  ABSTAIN, the eligible list is frozen when the vote opens (`poll_eligible`),
  quorum defaults to more than half, the result is frozen at close and a PDF
  protocol with a SHA-256 of the result is issued for the Academic Secretary.
- `SECRET` mode writes only anonymous per-option counters (`poll_tallies`), never
  a ballot linked to a voter; results of a secret formal vote stay hidden until
  it closes. This is server-side anonymity: a database administrator with access
  to WAL or dead tuples could still correlate the last vote. A cryptographic
  ballot needs an audited library and is future work.
- DB guardrails: votes only while open and before `closes_at`, one per person
  (primary key), tallies grow by exactly one, closed polls and poll definitions
  are immutable, votes / eligibility / acknowledgements are append-only. The
  audit log records participation in formal votes, never the choice.
- Directives (`messages.requires_ack`) may be issued only by those allowed
  `channel.moderate`; members confirm once (`message.ack`); only the author and
  moderators see who has and has not confirmed.
- Message formatting (code blocks, LaTeX) is rendered on the client only:
  lowlight's tree is rebuilt as React spans, KaTeX runs with `trust: false` and
  builds DOM nodes. Both load lazily.

**Calls and consultations (Phase 7)**

- Media runs on LiveKit through the `MediaServer` interface (`calls/media-server.ts`);
  the API never relays media. Join tokens live 5 minutes, carry only the user id
  (no name, no metadata), cannot publish data or change metadata, and allow only
  camera, microphone and screen share sources. `READ_ONLY` members join without
  publishing. Every join is authorized (`call.join`) and re-checked server-side.
- The LiveKit webhook (`POST /calls/livekit/webhook`) is public but verified by the
  SDK (signed JWT with the body's SHA-256); entrants are checked by the policy
  engine again. A job every 60 s removes participants who lost access and ends
  stale rooms, so offboarding or removal takes effect within a minute.
- No calls in `MANDATORY` E2EE channels until media E2EE is designed; calls in
  `OPTIONAL` channels show a notice that media is not end-to-end encrypted. In
  announcement, emergency, governance and course channels only moderators start
  calls. One live call per channel and per slot (partial unique indexes).
- Consultation slots: only staff with `consultation.host` publish them; booking
  follows the DM rules toward the host (minors, Rectorate, shared course) plus an
  optional course restriction; the host cannot book their own slot; capacity and
  state are enforced by DB triggers under a row lock. Topics are visible only to
  the host. The room opens 10 minutes before the slot and closes 15 minutes after.
- Realtime events `call.updated` and `consultation.updated` carry ids only.

**Corporate bots (Phase 8)**

- Bots are server-side services, not user accounts: each person has a private
  inbox per bot (`bot_messages`) with structured cards rendered as text. Who may
  use which bot is decided by the policy engine (`bot.use` on a `bot` resource:
  deanery for students, chancellery for staff, admissions for everyone). Bot
  routes take a closed slug (`idPattern`), never a free-form id.
- University systems talk to the bots only through signed webhooks
  (`integrations/deanery`, `/schedule`, `/edo`, kinds `DEANERY`, `SCHEDULE`,
  `EDO`) and the signed outbox (`integration_outbox`, same HMAC scheme,
  Idempotency-Key = event id, retries with backoff, 20 attempts). Outbound
  payloads carry ids (ЄДЕБО id, request id, file SHA-256), never names.
- Certificate requests: one open request per type and student; the life cycle
  (REQUESTED → IN_PROGRESS / READY → ISSUED, or REJECTED / CANCELLED) is a DB
  trigger. Only the student cancels, and only while REQUESTED.
- Schedule links must be https to an allowlisted host (`SCHEDULE_LINK_HOSTS`);
  schedule changes are append-only and announced once per `externalId` to the
  current students and lecturers of the group / course.
- Service desk: tickets go to the IT center, АГР (and its sub-units) or the
  commandant of the requester's dormitory; the room comes from the profile and
  is shown only to the resident and that commandant. Handlers are decided by
  the resolver (`isHandler`) and the engine; core ticket fields are immutable,
  the life cycle and the events log are enforced in the DB.
- ЕДО: approvers are told when it is their turn; an approved route is sent to the
  ЕДО with the served SHA-256; the registration number is set once (trigger).
- Admissions consultant: PostgreSQL full-text search over the active version of
  the rules (one active document per tenant), queries built from letters and
  digits only. Default answers quote the rules (nothing leaves the server). The
  Claude adapter is opt-in (`ADMISSIONS_ANSWERS=anthropic`), sends only the
  question and excerpts, and falls back to quoting on refusal, error or an
  answer without citations. Rate limit per person per hour; questions and
  answers expire after 30 days and are purged. Only staff of the Admissions
  Office upload or activate the rules (`admissions.kb.manage`).

**Viewer, PAdES, trust intake, minors, DLP, E2EE content, desktop (Phase 9)**

- Viewer: the outline is read during CDR as plain data (explicit destinations
  only, capped); byte ranges only for non-confidential PDFs; confidential views
  are served whole with a watermark naming the viewer, corporate id, IP and
  time, and their search shows no snippets. The served-bytes cache is reused
  only by ranged viewer reads; signing, verification and downloads re-hash.
- PAdES (`pki/pades.ts`): stamp + empty signature field over the served PDF,
  the client signs the byte-range digest (CMS without signing-time), the CMS
  is checked through the `SignatureProvider`; exactly one ByteRange covering
  the whole file. Confidential documents get detached CAdES only.
- Anonymous appeals (`src/trust`): one PSEUDONYM user per appeal
  (`ANONYMOUS_REQUESTER`), member only of its MANDATORY trust room with the
  service's officers; the client acts as it via `X-Pulse-Persona`, checked
  against HMAC(`TRUST_INTAKE_SECRET`, user id). The link is never stored in
  plain form or audited; the audit names the pseudonym. Pseudonyms are
  confined by the engine (`pseudonym.scope`) and DB triggers, have their own
  E2EE device, and are revoked when the person is offboarded.
- Minors: plaintext written by a minor or into a channel with a minor must
  pass `minorContentFlags` (obscene vocabulary, links outside puet.edu.ua and
  `MINOR_LINK_HOSTS`; staff may post links); denials are audited with the
  rule, never the text. In E2EE chats the minor's own client applies it.
- Forwarding (`file.forward`): evaluated on the target channel with
  server-computed `forwardSource`; confidential files never move, units with
  `forbid_external_forward` keep files in their own channels, no forwarding
  into MANDATORY rooms. Only the served bytes are copied.
- E2EE rooms: attachments are AES-256-GCM per file on the device (key in the
  Megolm message, ciphertext in `encrypted_blobs`, immutable, E2EE channels
  only); receivers verify the hash, sniff the bytes against the allowlist and
  show files only in sandboxed viewers, since the server cannot scan them.
  Polls are Megolm events tallied on each device (votes visible to members);
  formal votes stay in DISABLED governance channels.
- Desktop (`apps/desktop`): no Node in the page, context isolation, sandbox,
  empty preload, navigation allowlist, permissions only for calls and
  notifications of the configured origin.

## 5. Organizational topology and data model

- **Tenants:** `PUET_MAIN`, `PUET_LYCEUM` (strict minor protection),
  `COLLEGE_POLTAVA`, `COLLEGE_CHERKASY`, `COLLEGE_BILHOROD`.
- **Administrative vertical:** 7 institutes (ННІ): Daytime, Extramural &
  Distance, International (bilingual UA/EN UI by default), Leadership, Projects &
  Qualification, Social & Labor Relations, Innovative Management Technologies.
- **Academic vertical:** 17 cross-institute departments (кафедри). A lecturer of
  one department can teach groups of several institutes.
- **CourseOffering** = 1 department + N lecturers + N academic groups + 1
  semester, synced from ЄДЕБО / ERP teaching load. It owns one `COURSE` channel
  that auto-archives to read-only at semester end.
- **Org units:** governance (Rectorate, Academic Council with secret/open quorum
  voting, Scientific & Methodological Council), admin services (Chancellery, HR,
  Finance, Legal, Admissions, QA, IT Center, ЄДЕБО office), centers (STEAM-HUB,
  Interlingua), trust services (Ombudsman, Psychological Service, Military
  Registration: mandatory E2EE, anonymous intake), Civil Protection (alerts bypass
  Do Not Disturb and Quiet Hours), АГР facilities, Student Campus with
  Dormitories № 1–4 (floors, rooms), community and external units.
- **E2EE modes:** `MANDATORY` (Ombudsman, Psychological Service, Rectorate
  closed rooms, Military), `OPTIONAL` (user private chats, TTL 1h / 24h / 7d),
  `DISABLED` (official academic channels: searchable, archivable, safe for minors).
- **Audit log** (`audit_logs`): append-only (trigger blocks UPDATE / DELETE /
  TRUNCATE), SHA-256 hash chain, SIEM-compatible fields.
- Schema changes go through Prisma migrations. Constraints that Prisma cannot
  express live in hand-written SQL migrations (see `*_db_guardrails`). Never
  edit an applied migration; add a new one.

## 6. UI / UX design system and branding (Phase 5)

Design tokens as CSS variables, configurable through Admin white-label settings
(`tenants.theme_overrides`), Light and Dark themes:

| Token | Value | Use |
|---|---|---|
| `--puet-navy-primary` | `#163C56` (accent `#1C4966`) | Sidebar, headers, active tabs, official Rectorate / Academic Council badges, EP stamps |
| `--puet-terracotta-accent` | `#DF4827` (gradient `#C83D1E`) | Unread badges, primary / send buttons, «Підписати ЕП», Civil Protection alerts, «На парі / Зайнятий» |
| `--puet-ice-surface` | `#EFF4F7` (shadow `#D9E2E8`) | Light chat canvas, incoming bubbles, dividers |
| `--puet-obsidian-dark` | `#080808` (surfaces `#121619`) | Dark background, PDF viewer backdrop |
| `--puet-pure-white` | `#FFFFFF` | Text on dark / navy, light cards |

- Typography: **Montserrat** for headings, **Inter** for body and messages.
- Logos (official vectors converted from `assets/brand/source/logo-puet-vector.ai`):
  `logo-puet-full.svg` (horizontal mark + "POLTAVA UNIVERSITY OF ECONOMICS AND
  TRADE", splash / SSO), `logo-puet-full-stacked.svg` (stacked variant),
  `logo-puet-mark.svg` (round 3D "P" mark with white outline: header, app icon,
  favicon). The vector has no Ukrainian line, so the splash screen sets
  «Полтавський університет економіки і торгівлі» as live Montserrat text under
  the logo. Clear space ≥ 15% of the mark diameter. Never change proportions or
  segment colors of the mark.
- Full Ukrainian and English localization (i18n); Ukrainian is the default.
- Badge «Підписано ЕП» in navy / green opens the verification modal.

**Design skills.** `.claude/skills/landing-page-design` and
`.claude/skills/figma-designer` (from `elayadesign/ai-design-skills`, MIT) guide
GUI work: spacing scale, radius, states, motion, accessibility, content realism.
**PUET branding overrides the skill** where they conflict: keep Montserrat +
Inter and the PUET palette even though the skill forbids Inter and two-font
pairings. The landing-page strategy part (Part A) and its mandatory tagline
section apply only to marketing pages, not to the messenger app.

## 7. Execution plan

- **Phase 1 (done):** CLAUDE.md, monorepo, Docker Compose, Prisma schema for
  the multi-tenant + matrix structure, RBAC/ABAC engine and guards.
- **Phase 2 (done):** OIDC / SSO with PKCE, IdP-enforced MFA with step-up,
  Redis sessions, signed sync webhooks (ЄДЕБО students, HR staff, ERP teaching
  load, offboarding), No-Code Admin Panel API (structure, bulk promotion,
  graduation to alumni, roles, permission matrix, ABAC policies, simulator,
  audit log and chain verification). The visual panel came in Phase 5.
- **Phase 3 (done):** real-time messaging (Socket.io + Redis), channel
  auto-provisioning, threads, DMs and groups, presence, Quiet Hours with
  morning digest (Redis), TTL purge, E2EE key directory and the vodozemac
  client layer (Olm/Megolm, key backup, QR verification).
- **Phase 4 (done):** files with quarantine + ClamAV, PDF CDR, Secure Viewer API
  (watermarks, view-only DLP, JSON annotations), internal CA (CSR, CRL, OCSP) and
  `packages/signing`, `SignatureProvider` with the QES gateway adapter (OCSP +
  TSP), multi-step approval routes, verification protocol with QR and PDF.
- **Phase 5 (done):** React frontend with PUET tokens, Light / Dark, UA / EN
  (chats, threads, files, Secure PDF viewer with annotations, УЕП / КЕП signing,
  approvals, verification page, settings, visual admin panel), directory API,
  plus security tests (IDOR, minor isolation, signature tampering, XSS, CSS
  injection, open redirect).
- **Phase 6 (done):** formal votes of collegial bodies (secret / open, quorum,
  protocol PDF), polls in channels, directives with acknowledgement, code
  highlighting and LaTeX in messages.
- **Phase 7 (done):** WebRTC calls and consultations (LiveKit) with screen
  sharing, lecturers' consultation schedule with booking.
- **Phase 8 (done):** corporate bots over REST / webhooks: ЄДЕБО / Деканат, Розклад ПУЕТ,
  Service desk АГР та ІТ (dormitory repair tickets), ЕДО та Канцелярія, admissions
  AI consultant (RAG over the admission rules).
- **Phase 9 (done):** viewer thumbnails, bookmarks and full-text search, IP in the
  watermark, PAdES with a visual QR stamp, anonymous intake for trust services,
  content filters for minors, no forwarding of files outside, desktop wrapper,
  polls and attachments in encrypted rooms.

Do one phase at a time and stop for the owner's confirmation between phases.

## 8. Engineering conventions

- TypeScript strict everywhere; no `any` in security code.
- Tests are required for every policy rule and guard change. Security tests name
  the attack they prevent (e.g. "IDOR: ...", "minor isolation: ...").
- Keep the policy engine free of I/O and framework imports.
- Personal data: collect the minimum, never in logs, never in URLs.
- Commit messages and code comments in English; user-facing strings via i18n
  (uk default, en).
