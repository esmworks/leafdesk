# Leafdesk desktop app

An Electron window on a Leafdesk server (see *Desktop app* in the main README for what it does).
It is its own pnpm project, outside the web app's TypeScript, ESLint, Vitest and Docker builds.

Requirements: Node.js 24 and pnpm 11.

```bash
pnpm install
pnpm start        # builds, then opens the app
pnpm typecheck
pnpm test         # node --test, no Electron needed
pnpm server       # builds the server local mode runs into server/ (scripts/bundle-server.ts)
pnpm dist         # installers for this computer's system in release/; needs a release's signing variables
```

For an unsigned macOS app to try out (in `release/mac-arm64/`), after `pnpm install` at the
repository root:

```bash
pnpm build && pnpm server && CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac --arm64 --dir -c.mac.notarize=false -c.mac.identity=null
```

To try it against a development server, start one (`pnpm dev` in the repository root) and enter
`localhost:3000` on the connect screen. Started from the source, the app keeps its profile (server
address, trusted certificates, cookies, Leafdesk on this computer) in a `Leafdesk Dev` folder next
to an installed app's; start Electron with `--user-data-dir=<folder>` to keep another one, and set
`LEAFDESK_DISABLE_UPDATES=1` to skip the update check.

A system-wide shortcut (⇧⌘J on macOS, Ctrl+Shift+J elsewhere; Go → *Ask AI Shortcut* picks
another or none) brings the app forward from any other app on the server's `/ai`, which opens AI
chat in the window's workspace, or a quick note where AI is off. The choice is `globalShortcut` in
the profile's `settings.json`; keys another app already holds are marked in that menu.

**On this computer** (local mode) runs Leafdesk inside the app: a PostgreSQL 18 of its own
(`src/local-db.ts`) and the Leafdesk server (run by Electron's Node), on 127.0.0.1 with a port kept
from one start to the next. The first start makes the computer's one account
(`scripts/desktop-setup.ts`, which also applies the migrations); the app signs in to it, so there is
no sign-in page. Everything lives in `<profile>/Local`: the database,
uploaded files, the secrets and `server.log`. The server backs the account's workspaces up into
the backup folder (`src/server/local-backups.ts` at the root, `Documents/Leafdesk Backups` unless
the File menu picked another), and answers the app's *Back Up Now* over its IPC channel.

Started from the source, the app runs the repository's `server.ts` in development mode, so it needs
the repository's packages (`pnpm install` at the root); its tests start the server, so `pnpm test`
does too. A packaged app runs the server `pnpm server` built: Next's standalone build of the
repository (the compiled pages and the packages they load, laid out without links) with
`server.ts` and the setup bundled beside it, about 185 MB. `scripts/after-pack.ts` puts it in the
app's resources and keeps only the app's own platform's PostgreSQL. `src/local-server.test.ts`
runs either one: `LEAFDESK_TEST_SERVER_DIR=server` for the built server with this Node, or
`LEAFDESK_TEST_APP_RESOURCES` and `LEAFDESK_TEST_APP_EXECUTABLE` for a packaged app, as CI does on
each platform.

| File | What it does |
| --- | --- |
| `src/main.ts` | Windows, connecting to a server or starting local mode, the app's pages, permissions, `leafdesk://open` links |
| `src/windows.ts` | A window and its tabs: one `WebContentsView` per tab under the tab strip, which is the window's own page |
| `src/tabs.ts` | Tab order, closed tabs, tab keys and saved tabs, without Electron (tested) |
| `src/local-db.ts` | Local mode's PostgreSQL: made, started on a free port, stopped, recovered |
| `src/local-server.ts` | Local mode's server: setup, start, signing in to the computer's account, stop |
| `src/navigation.ts` | Which links stay in the window, open a tab, open in the browser or go nowhere; checking `leafdesk://open` links |
| `src/last-page.ts` | The page the window opens on at start: the last one shown, on the same server only |
| `src/certificates.ts` | Certificates the system doesn't trust: fingerprint, trusting one per host |
| `src/server-address.ts` | Turning what was typed into addresses to try |
| `src/strings.ts` | The app's own texts in the web app's 24 languages |
| `src/menu.ts`, `src/context-menu.ts` | Application and right-click menus |
| `src/global-shortcut.ts` | The system-wide shortcut to AI chat (Go → Ask AI Shortcut): its choices, labels and the server's `/ai` address |
| `src/updates.ts` | Updates from GitHub releases |
| `src/preload.cts` | The bridges the connect page and the tab strip use (never given to server pages); marks server pages with `data-desktop-app` and passes their `data-page-icon` to the tab |
| `src/pages/app.ts`, `pages/` | The connect, certificate, starting and problem screens |
| `src/pages/tabs.ts`, `pages/tabs.*` | The tab strip: tabs, dragging to reorder, the new tab button |
| `scripts/bundle-server.ts` | Builds the server packaged apps run (`pnpm server`) |
| `scripts/after-pack.ts` | Puts that server and the platform's PostgreSQL into the packaged app |

Driving the app over CDP while testing: keys sent with `Input.dispatchKeyEvent` never reach
`before-input-event`, so tab keys need real input (CGEvent on macOS); the tab strip refuses
navigation, so reload it with `Page.reload`, not `location.reload()`.

Releases are built by `.github/workflows/desktop.yml`.
