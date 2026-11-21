# PUET.Pulse

Корпоративний месенджер та платформа оперативної комунікації
**Полтавського університету економіки і торгівлі (ПУЕТ)**.
On-premise, zero-trust, multi-tenant.

<img src="assets/brand/logo-puet-full-horizontal-en.png" alt="Poltava University of Economics and Trade" width="420">

> Правила архітектури та безпеки: [CLAUDE.md](CLAUDE.md).

## Стан: Фаза 1

| Що | Де |
|---|---|
| Монорепо pnpm + Turborepo | `package.json`, `turbo.json`, `pnpm-workspace.yaml` |
| Інфраструктура: PostgreSQL 16, Redis 7, MinIO (SSE AES-256), ClamAV | `docker-compose.yml`, `infra/` |
| Схема БД: 5 тенантів, 7 ННІ, 17 кафедр, підрозділи, гуртожитки № 1–4, курси, канали, PKI, аудит | `packages/database/prisma/schema.prisma` |
| Захисні обмеження в БД: незмінний журнал аудиту, E2EE без відкритого тексту, TTL повідомлень | `packages/database/prisma/migrations/*_db_guardrails` |
| Policy engine RBAC + ABAC (IDOR, неповнолітні, приватність, гості, DLP) | `packages/policy-engine` |
| NestJS guards для HTTP і WebSocket, журнал аудиту з hash-ланцюгом | `apps/api/src/auth`, `apps/api/src/authz`, `apps/api/src/audit` |
| Дизайн-скіли для GUI | `.claude/skills/` |

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

Усі маршрути, крім `/health`, повертають `401`, доки у Фазі 2 не підключено OIDC/SSO.
Обхідного «dev-входу» немає навмисно.

## Тести

```bash
pnpm test
```

- `packages/policy-engine`: 43 тести правил (IDOR, ізоляція тенантів, неповнолітні,
  заборона DM до ректорату, приховані телефони й кімнати, гості, DLP, конфігуровані політики).
- `apps/api`: 22 тести guard-ів (HTTP і WebSocket, fail-closed, аудит) і hash-ланцюга аудиту.

## Що потрібно перевірити замовнику

- Перелік 17 кафедр у `packages/database/prisma/seed-data.ts` звірено з офіційним переліком ПУЕТ.
- `assets/brand/*.svg` поки що обгортки над растровими логотипами. Потрібні офіційні
  векторні файли з брендбуку.
