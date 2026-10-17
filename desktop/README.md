# Leafdesk desktop app

An Electron window on a Leafdesk server (see *Desktop app* in the main README for what it does).
It is its own pnpm project, outside the web app's TypeScript, ESLint, Vitest and Docker builds.

Requirements: Node.js 24 and pnpm 11.

```bash
pnpm install
pnpm start        # builds, then opens the app
pnpm typecheck
pnpm test         # node --test, no Electron needed
pnpm dist         # installers for this computer's system in release/, signed as in a release
```

For an unsigned macOS app to try out (in `release/mac-arm64/`):

```bash
pnpm build && CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir --arm64 -c.mac.notarize=false -c.mac.identity=null
```

To try it against a development server, start one (`pnpm dev` in the repository root) and enter
`localhost:3000` on the connect screen. Start Electron with `--user-data-dir=<folder>` to keep
another profile (server address, trusted certificates, cookies), and set
`LEAFDESK_DISABLE_UPDATES=1` to skip the update check.

| File | What it does |
| --- | --- |
| `src/main.ts` | Window, connecting to a server, the connect and problem pages, permissions |
| `src/navigation.ts` | Which links stay in the window, open in the browser or go nowhere |
| `src/certificates.ts` | Certificates the system doesn't trust: fingerprint, trusting one per host |
| `src/server-address.ts` | Turning what was typed into addresses to try |
| `src/strings.ts` | The app's own texts in the web app's 16 languages |
| `src/menu.ts`, `src/context-menu.ts` | Application and right-click menus |
| `src/updates.ts` | Updates from GitHub releases |
| `src/preload.cts` | The bridge the connect page uses (never given to server pages) |
| `src/pages/app.ts`, `pages/` | The connect, certificate and problem screens |

Releases are built by `.github/workflows/desktop.yml`.
