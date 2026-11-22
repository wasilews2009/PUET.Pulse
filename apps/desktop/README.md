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
Installers (MSI / DMG / AppImage) and code signing with the university's
certificate are configured at release time with electron-builder.
