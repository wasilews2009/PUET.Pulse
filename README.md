# PUET.Pulse

Корпоративний месенджер та платформа оперативної комунікації
**Полтавського університету економіки і торгівлі (ПУЕТ)**.
On-premise, zero-trust, multi-tenant.

<img src="assets/brand/logo-puet-full-horizontal-en.png" alt="Poltava University of Economics and Trade" width="420">

> Правила архітектури та безпеки: [CLAUDE.md](CLAUDE.md).

## Стан: Фази 1–2 виконано

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
Візуальна адмін-панель з'явиться у Фазі 5; зараз це API `/admin/*`.

## Тести

```bash
pnpm test
```

- `packages/policy-engine`: 46 тестів правил (IDOR, ізоляція тенантів, неповнолітні,
  заборона DM до ректорату, приховані телефони й кімнати, гості, DLP, конфігуровані
  політики, машинні принципали інтеграцій).
- `apps/api`: 37 модульних тестів (guard-и HTTP і WebSocket, hash-ланцюг аудиту, MFA,
  open redirect, HMAC, вік неповнолітніх, сесії, конфігурація) і 18 наскрізних тестів
  через HTTP на PostgreSQL (вхід, CSRF, вебхуки, офбординг, адмін-панель):

```bash
RUN_DB_TESTS=1 DATABASE_URL=postgresql://... pnpm test
```

## Що потрібно перевірити замовнику

- Перелік 17 кафедр у `packages/database/prisma/seed-data.ts` звірено з офіційним переліком ПУЕТ.
- Логотипи `assets/brand/*.svg` сконвертовано з офіційного векторного файла
  `assets/brand/source/logo-puet-vector.ai`.
