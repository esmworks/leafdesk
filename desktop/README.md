# Leafdesk desktop app

An Electron window on a Leafdesk server (see *Desktop app* in the main README for what it does).
It is its own pnpm project, outside the web app's TypeScript, ESLint, Vitest and Docker builds.

Requirements: Node.js 24 and pnpm 11.

```bash
pnpm install
pnpm start        # builds, then opens the app
pnpm typecheck
pnpm test         # node --test, no Electron needed
pnpm dist         # installers for this computer's system in release/; needs a release's signing variables
```

For an unsigned macOS app to try out (in `release/mac-arm64/`):

```bash
pnpm build && CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir --arm64 -c.mac.notarize=false -c.mac.identity=null
```

To try it against a development server, start one (`pnpm dev` in the repository root) and enter
`localhost:3000` on the connect screen. Started from the source, the app keeps its profile (server
address, trusted certificates, cookies, Leafdesk on this computer) in a `Leafdesk Dev` folder next
to an installed app's; start Electron with `--user-data-dir=<folder>` to keep another one, and set
`LEAFDESK_DISABLE_UPDATES=1` to skip the update check.

**On this computer** (local mode) runs Leafdesk inside the app: a PostgreSQL 18 of its own
(`src/local-db.ts`) and the repository's server (`server.ts`, in development mode, run by Electron's
Node), on 127.0.0.1 with a port kept from one start to the next. The first start makes the
computer's one account (`scripts/desktop-setup.ts`, which also applies the migrations); the app
signs in to it, so there is no sign-in page. Everything lives in `<profile>/Local`: the database,
uploaded files, the secrets and `server.log`. It needs the repository's packages (`pnpm install` at
the root), and its tests start the server, so `pnpm test` does too. Packaged apps don't carry the
server yet, so they still show the mode as coming soon.

| File | What it does |
| --- | --- |
| `src/main.ts` | Window, connecting to a server or starting local mode, the app's pages, permissions |
| `src/local-db.ts` | Local mode's PostgreSQL: made, started on a free port, stopped, recovered |
| `src/local-server.ts` | Local mode's server: setup, start, signing in to the computer's account, stop |
| `src/navigation.ts` | Which links stay in the window, open in the browser or go nowhere |
| `src/certificates.ts` | Certificates the system doesn't trust: fingerprint, trusting one per host |
| `src/server-address.ts` | Turning what was typed into addresses to try |
| `src/strings.ts` | The app's own texts in the web app's 16 languages |
| `src/menu.ts`, `src/context-menu.ts` | Application and right-click menus |
| `src/updates.ts` | Updates from GitHub releases |
| `src/preload.cts` | The bridge the connect page uses (never given to server pages) |
| `src/pages/app.ts`, `pages/` | The connect, certificate, starting and problem screens |

Releases are built by `.github/workflows/desktop.yml`.
