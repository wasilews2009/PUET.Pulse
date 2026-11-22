# PUET.Pulse

Корпоративний месенджер та платформа оперативної комунікації
**Полтавського університету економіки і торгівлі (ПУЕТ)**.
On-premise, zero-trust, multi-tenant.

<img src="assets/brand/logo-puet-full-horizontal-en.png" alt="Poltava University of Economics and Trade" width="420">

> Правила архітектури та безпеки: [CLAUDE.md](CLAUDE.md).

## Стан: Фази 1–6 виконано

| Що | Де |
|---|---|
| Монорепо pnpm + Turborepo | `package.json`, `turbo.json`, `pnpm-workspace.yaml` |
| Інфраструктура: PostgreSQL 16, Redis 7, MinIO (SSE AES-256), ClamAV | `docker-compose.yml`, `infra/` |
| Схема БД: 5 тенантів, 7 ННІ, 17 кафедр, підрозділи, гуртожитки № 1–4, курси, канали, PKI, аудит | `packages/database/prisma/schema.prisma` |
| Захисні обмеження в БД: незмінний журнал аудиту, E2EE без відкритого тексту, TTL повідомлень | `packages/database/prisma/migrations/*_db_guardrails` |
| Policy engine RBAC + ABAC (IDOR, неповнолітні, приватність, гості, DLP) | `packages/policy-engine` |
| NestJS guards для HTTP і WebSocket, журнал аудиту з hash-ланцюгом | `apps/api/src/auth`, `apps/api/src/authz`, `apps/api/src/audit` |
| Дизайн-скіли для GUI | `.claude/skills/` |
| **Фаза 2.** Вхід через OIDC / SSO (PKCE, state, nonce), MFA від IdP зі step-up, без самореєстрації | `apps/api/src/auth` |
| Сесії в Redis (лише SHA-256 токена), `__Host-` cookie, тайм-аути, CSRF за `Origin`, відкликання через `session_epoch` | `apps/api/src/session` |
| Підписані вебхуки ЄДЕБО / HR / ERP (HMAC-SHA256, 5 хв, `Idempotency-Key`), офбординг | `apps/api/src/integrations` |
| API No-Code адмін-панелі: структура, переведення груп, випуск в alumni, ролі, матриця дозволів, ABAC-політики, симулятор, журнал аудиту та перевірка ланцюга | `apps/api/src/admin` |
| **Фаза 3.** Обмін повідомленнями в реальному часі: Socket.io `/ws` (перевірка `Origin` і сесії), розсилка через Redis pub/sub | `apps/api/src/realtime` |
| Канали, гілки, особисті чати й групи, прочитання, mute, статуси «На парі» / «Не турбувати», TTL-повідомлення | `apps/api/src/messaging` |
| Автостворення каналів груп, курсів, кафедр, ННІ, гуртожитків, підрозділів і ЦЗ після кожної синхронізації; архівація курсів | `apps/api/src/provisioning` |
| «Тихі години» з ранковим дайджестом у Redis; тривоги ЦЗ обходять усі обмеження | `apps/api/src/notifications` |
| E2EE: каталог ключів (сумісний з Matrix), to-device, резервна копія ключів | `apps/api/src/e2ee` |
| Клієнтський шар E2EE на vodozemac (Olm / Megolm), відновлення за майстер-паролем, верифікація пристроїв за QR | `packages/e2ee` |
| **Фаза 4.** Файли: карантин, перевірка ClamAV, дозволені типи за вмістом, MinIO з SSE | `apps/api/src/files` |
| Санітизація PDF (CDR), водяні знаки для конфіденційних документів, JSON-анотації | `apps/api/src/files` |
| Внутрішній ЦСК (УЕП): сертифікат з CSR, CRL, OCSP; адаптер КЕП через шлюз ІІТ з обов'язковими OCSP і TSP | `apps/api/src/pki` |
| Клієнтський підпис: ключ не покидає пристрій, CSR, CAdES-BES | `packages/signing` |
| Маршрути погодження, протокол перевірки підписів з QR-кодом і PDF | `apps/api/src/approvals`, `apps/api/src/pki` |
| **Фаза 5.** Веб-клієнт (PWA): кольори та шрифти ПУЕТ, світла й темна теми, українська та англійська | `apps/web` |
| Чати, гілки, особисті повідомлення, статуси, E2EE у браузері, файли, захищений переглядач PDF з нотатками | `apps/web/src/features/chat`, `apps/web/src/features/files` |
| Підпис УЕП (ключ лише на пристрої) і КЕП (.p7s), маршрути погодження, публічна сторінка перевірки | `apps/web/src/features/signatures`, `apps/web/src/features/approvals` |
| Візуальна адмін-панель: структура, ролі, матриця, політики, симулятор, журнал аудиту | `apps/web/src/features/admin` |
| Довідник і картки людей з фільтром видимості для кожного рядка | `apps/api/src/directory` |
| Приклад nginx: TLS 1.3, HSTS, суворий CSP, проксі `/api` і `/api/ws` | `infra/nginx/pulse.conf` |
| **Фаза 6.** Голосування Вченої ради, Ректорату, НМР: таємне й відкрите, кворум, протокол PDF для Вченого секретаря | `apps/api/src/polls` |
| Опитування в каналах, директиви з підтвердженням «Ознайомлений» | `apps/api/src/polls`, `apps/api/src/messaging` |
| Код із підсвіткою синтаксису та формули LaTeX у повідомленнях | `apps/web/src/features/chat` |
| **Фаза 7.** Відеодзвінки й консультації на LiveKit (WebRTC) з демонстрацією екрана, у каналах і особистих чатах | `apps/api/src/calls`, `apps/web/src/features/calls` |
| Графік консультацій викладачів: слоти (онлайн / в аудиторії), повторення, запис студентів з темою, скасування | `apps/api/src/consultations`, `apps/web/src/features/consultations` |

## Швидкий старт

```bash
cp .env.example .env          # замініть усі CHANGE_ME
pnpm install
pnpm infra:up                 # PostgreSQL, Redis, MinIO, ClamAV
pnpm db:deploy                # міграції
pnpm db:seed                  # тенанти та структура ПУЕТ
pnpm build && pnpm test
node apps/api/dist/main.js    # GET /health -> 200
pnpm --filter @puet/web dev   # веб-клієнт на http://localhost:5173 (проксі /api -> :3000)
```

У продакшені `apps/web/dist` віддає reverse proxy з того ж домену, що й API
(приклад: `infra/nginx/pulse.conf`); `WEB_ORIGIN` має збігатися з цим доменом.

Вхід: `GET /auth/login` перенаправляє на IdP (Keycloak), `GET /auth/callback`
створює сесію лише для користувача, який уже є в БД (синхронізація ЄДЕБО / HR).
Обхідного «dev-входу» немає навмисно. Налаштування IdP і клієнтів інтеграцій
описано в `.env.example` (`OIDC_*`, `SESSION_*`, `INTEGRATION_CLIENTS`).
Нові змінні Фази 3:
`E2EE_SERVER_NAME`, `JOBS_ENABLED`; Фази 4: `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`FILE_MAX_MB`, `PKI_CA_*`, `PKI_PUBLIC_URL`, `VERIFY_CODE_SECRET`, `QES_GATEWAY_*`;
Фази 7: `LIVEKIT_URL`, `LIVEKIT_PUBLIC_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
(порожній `LIVEKIT_URL` вимикає дзвінки; вебхук LiveKit налаштуйте на `https://<хост>/api/calls/livekit/webhook`)
(див. `.env.example`). Після оновлення запустіть `pnpm db:deploy && pnpm db:seed` (Фаза 6 додає нові
дозволи `poll.create`, `poll.manage`, `message.ack`; Фаза 7: `call.*`, `consultation.*`).

Внутрішній ЦСК створюється один раз, ключі зберігаються поза репозиторієм:

```bash
pnpm --filter @puet/api pki:init-ca /etc/puet/ca
```

## Тести

```bash
pnpm test
```

- `packages/policy-engine`: 57 тестів правил (IDOR, ізоляція тенантів, неповнолітні,
  заборона DM до ректорату, приховані телефони й кімнати, гості, DLP, конфігуровані
  політики, машинні принципали інтеграцій, власні пристрої й акаунт, підписи й погодження).
- `packages/e2ee`: 8 тестів справжнього vodozemac (шифрування, чужий не прочитає,
  ротація ключів після виключення, підробка шифротексту, відновлення з копії, QR).
- `apps/api`: 79 модульних тестів (guard-и HTTP і WebSocket, hash-ланцюг аудиту, MFA,
  open redirect, HMAC, вік неповнолітніх, сесії, конфігурація, «Тихі години», DST,
  CDR шкідливого PDF, ClamAV, ЦСК: CSR, підробка підпису, CRL, OCSP, адаптер КЕП)
  і 54 наскрізні тести на PostgreSQL: 18 Фази 2 (вхід, CSRF, вебхуки, офбординг,
  адмін-панель), 15 Фази 3 (автоканали, гілки, IDOR, режими E2EE, DM, неповнолітні,
  TTL, «Тихі години», CSWSH, доставка через WebSocket, E2EE через API, офбординг)
  і 13 Фази 4 (карантин і CDR, вірус EICAR, недоступний сканер, IDOR файлів, DLP і
  водяний знак, анотації, сертифікати, підписи УЕП і КЕП, маршрути погодження,
  протокол перевірки з QR), 8 Фази 5 (ізоляція неповнолітніх у довіднику й картках,
  приховані телефони, IDOR анотацій, рішень погодження й сертифікатів, повтор підпису
  на іншому документі, змінений біт, підміна файла в сховищі, незмінність підписів).
- `apps/web`: 11 тестів (XSS у повідомленнях, CSS-ін'єкція через white-label,
  open redirect після входу, правила публікації в каналах, однакові ключі UA / EN):

```bash
RUN_DB_TESTS=1 DATABASE_URL=postgresql://... pnpm test
```

## Що потрібно перевірити замовнику

- Перелік 17 кафедр у `packages/database/prisma/seed-data.ts` звірено з офіційним переліком ПУЕТ.
- Логотипи `assets/brand/*.svg` сконвертовано з офіційного векторного файла
  `assets/brand/source/logo-puet-vector.ai`.
