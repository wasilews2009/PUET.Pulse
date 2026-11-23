# PUET.Pulse desktop

A hardened Electron window around the PUET.Pulse web client of one server
(Phase 9). The page runs exactly as in a browser: no Node.js, context
isolation, the OS sandbox, an empty preload, and the server's own CSP.

- Navigation: only the configured server and the sign-in hosts open in the
  window; other https links open in the system browser; `file:`,
  `javascript:`, `data:` and custom schemes are refused (`src/policy.ts`).
- Permissions: camera, microphone and screen (calls) and notifications, for
  the server's origin only. Certificate errors are never overridden.
- Sessions stay in the server's HttpOnly cookie; E2EE and signing keys stay in
  the page's IndexedDB, as in a browser.

```bash
PULSE_URL=https://pulse.puet.edu.ua PULSE_SSO_HOSTS=sso.puet.edu.ua pnpm --filter @puet/desktop start
```

The Electron binary is not downloaded by `pnpm install` (build scripts are
not allowed in this workspace); run `pnpm approve-builds` or
`node node_modules/electron/install.js` once on a developer machine.

## Інсталятори (Windows, а також macOS / Linux)

Збірка: `electron-builder.yml`, CI: `.github/workflows/clients.yml` (job
«Windows installer»). Результат:

| Файл | Для кого |
|---|---|
| `PUET.Pulse-X.Y.Z-x64.exe`, `…-arm64.exe` (NSIS) | Користувачі: майстер українською / англійською, за замовчуванням встановлення для поточного користувача без прав адміністратора, ярлики на робочому столі й у «Пуск» |
| `PUET.Pulse-X.Y.Z-x64.msi` | ІТ-центр: тихе встановлення на всі комп'ютери через GPO / Intune / SCCM: `msiexec /i PUET.Pulse-X.Y.Z-x64.msi /qn` |

**Адреса сервера вшивається в інсталятор** (`scripts/write-config.mjs` пише
`dist/pulse.json` всередину `app.asar`, цілісність якого перевіряє Electron).
Встановлена програма ігнорує змінні середовища і відмовляється від http, тож
її не можна непомітно перенаправити на інший сервер. Electron fuses вимикають
`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect` і завантаження коду поза
`app.asar`; cookies шифруються засобами ОС.

Локально (на Windows):

```powershell
$env:PULSE_URL = "https://pulse.puet.edu.ua"; $env:PULSE_SSO_HOSTS = "sso.puet.edu.ua"
pnpm install; pnpm --filter @puet/desktop dist:win     # -> apps/desktop/release/
```

### Підпис коду

Без підпису Windows SmartScreen показує «Невідомий видавець». Підпис
вмикається в CI без змін у коді:

- сертифікат у файлі `.pfx`: секрети `WIN_CSC_LINK` (base64 файлу) і
  `WIN_CSC_KEY_PASSWORD`;
- або Azure Trusted Signing (сертифікат у хмарному HSM): змінні
  `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`,
  `AZURE_SIGN_PUBLISHER` і секрети `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
  `AZURE_CLIENT_SECRET`.

Підпис SHA-256 з міткою часу RFC 3161; CI перевіряє його
(`Get-AuthenticodeSignature`) і пише `SHA256SUMS-windows.txt`. Сертифікат і
пароль ніколи не потрапляють у репозиторій (`.gitignore` блокує `*.pfx`).
