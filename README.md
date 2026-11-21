# PUET.Pulse

Корпоративний месенджер та платформа оперативної комунікації
**Полтавського університету економіки і торгівлі (ПУЕТ)**.
On-premise, zero-trust, multi-tenant.

<img src="assets/brand/logo-puet-full-horizontal-en.png" alt="Poltava University of Economics and Trade" width="420">

> Правила архітектури та безпеки: [CLAUDE.md](CLAUDE.md).

## Стан: Фази 1–3 виконано

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

## Швидкий старт

```bash
cp .env.example .env          # замініть усі CHANGE_ME
pnpm install
pnpm infra:up                 # PostgreSQL, Redis, MinIO, ClamAV
pnpm db:deploy                # міграції
pnpm db:seed                  # тенанти та структура ПУЕТ
pnpm build && pnpm test
node apps/api/dist/main.js    # GET /health -> 200
```

Вхід: `GET /auth/login` перенаправляє на IdP (Keycloak), `GET /auth/callback`
створює сесію лише для користувача, який уже є в БД (синхронізація ЄДЕБО / HR).
Обхідного «dev-входу» немає навмисно. Налаштування IdP і клієнтів інтеграцій
описано в `.env.example` (`OIDC_*`, `SESSION_*`, `INTEGRATION_CLIENTS`).
Візуальна адмін-панель і месенджер з'являться у Фазі 5; зараз це API `/admin/*`,
REST-маршрути месенджера, `/e2ee/*` і WebSocket `/ws`. Нові змінні Фази 3:
`E2EE_SERVER_NAME`, `JOBS_ENABLED` (див. `.env.example`). Після оновлення
запустіть `pnpm db:deploy && pnpm db:seed`.

## Тести

```bash
pnpm test
```

- `packages/policy-engine`: 50 тестів правил (IDOR, ізоляція тенантів, неповнолітні,
  заборона DM до ректорату, приховані телефони й кімнати, гості, DLP, конфігуровані
  політики, машинні принципали інтеграцій, власні пристрої й акаунт).
- `packages/e2ee`: 8 тестів справжнього vodozemac (шифрування, чужий не прочитає,
  ротація ключів після виключення, підробка шифротексту, відновлення з копії, QR).
- `apps/api`: 49 модульних тестів (guard-и HTTP і WebSocket, hash-ланцюг аудиту, MFA,
  open redirect, HMAC, вік неповнолітніх, сесії, конфігурація, «Тихі години», DST)
  і 33 наскрізні тести на PostgreSQL: 18 Фази 2 (вхід, CSRF, вебхуки, офбординг,
  адмін-панель) і 15 Фази 3 (автоканали, гілки, IDOR, режими E2EE, DM, неповнолітні,
  TTL, «Тихі години», CSWSH, доставка через WebSocket, E2EE через API, офбординг):

```bash
RUN_DB_TESTS=1 DATABASE_URL=postgresql://... pnpm test
```

## Що потрібно перевірити замовнику

- Перелік 17 кафедр у `packages/database/prisma/seed-data.ts` звірено з офіційним переліком ПУЕТ.
- Логотипи `assets/brand/*.svg` сконвертовано з офіційного векторного файла
  `assets/brand/source/logo-puet-vector.ai`.
