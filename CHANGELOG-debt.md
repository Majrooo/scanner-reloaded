# CHANGELOG-debt

Decision log of known technical debt. Each entry: **what / why / when to resolve**.
This file is committed to the repository (team-visible) — unlike `memory-bank/` (private AI context).

## Open debt

### §10 Auto-updater (large)
- **What:** No auto-update mechanism; distribution only via GitHub releases. Code signing not verified.
- **Why:** Users must manually download new versions; no update notifications.
- **When:** Requires `tauri-plugin-updater` + CI signing + changes to `tauri.conf.json` (needs explicit confirmation). Separate session.

### §3 StorageService refactor (medium)
- **What:** Direct `localStorage` usage in `scanner.js` / `themes.js` / `i18n.js` without a `StorageService` abstraction.
- **Why:** Scattered storage access makes migrations and testing harder.
- **When:** Introduce `src/lib/storage.js` and route all storage access through it. Separate session.

### §11 Backend error codes (medium)
- **What:** Backend returns localized English strings; frontend cannot translate them.
- **Why:** Better i18n — return error codes (e.g. `ERR_PATH_NOT_FOUND`) and translate in the frontend.
- **When:** Refactor `lib.rs` error returns to codes + frontend mapping. Separate session.

### §6 Crash reporting — Sentry/telemetry (medium)
- **What:** Local `error.log` + rotation exists; no cloud crash reporting.
- **Why:** Cannot see crashes from real users.
- **When:** Optional Sentry integration (new dependency + DSN config). Local panic hook + `log_frontend_error` already implemented (see below).

### §13 Frontend e2e tests (medium)
- **What:** Unit tests for pure frontend logic exist (Vitest); no e2e tests.
- **Why:** Full user flows (scan → navigate → delete) not covered.
- **When:** Consider Playwright/WebdriverIO against a Tauri dev build. Separate session.

### §2 Binary format magic byte + version (small)
- **What:** `serialize_to_binary` / `deserializeBinaryTree` have no magic byte/version.
- **Why:** A Rust format change silently breaks the frontend.
- **When:** Add magic byte + version on both sides. Small change.

### §12 Accessibility (small)
- **What:** Some interactive elements lack labels; contrast/touch targets not verified.
- **Why:** Improve screen-reader and keyboard support.
- **When:** Add `aria-label` to icon buttons, `aria-current` to breadcrumbs. Small change.

### §14 Duplicate `isWindows` detection (small)
- **What:** `isWindows` duplicated in `menu.js` and `scanner.js`.
- **Why:** Single source of truth.
- **When:** Share from `lib/utils.js`. Small change.

### §5 Centralized timeouts (small)
- **What:** `invokeWithTimeout(..., 5000/10000/15000)` scattered in `menu.js` / `scanner.js`.
- **Why:** Consistent defaults, easier tuning.
- **When:** Central constants in `lib/utils.js`. Small change.

## Platform / release

### macOS/Linux builds not tested on hardware
- **What:** CI builds for macOS/Linux, but no real-hardware testing.
- **Why:** Platform-specific code (trash, file manager, properties) may have untested paths.
- **When:** Needs testers on real macOS/Linux machines.

### Windows/Linux portable assets missing from v0.3.0
- **What:** Portable assets not attached to v0.3.0 release; fix already in `main`.
- **Why:** Users on Windows/Linux cannot download portable builds.
- **When:** Next release will attach them.

## Git state

### Unpushed commits on `main`
- **What:** `4499340`, `b025e98`, `b1cce1d` are 3 commits ahead of `origin/main` (`fcdf320`).
- **Why:** Not yet pushed to GitHub.
- **When:** Push after this debt session + release prep.