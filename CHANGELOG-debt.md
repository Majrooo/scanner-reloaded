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
- **When:** Optional Sentry integration (new dependency + DSN config). Local panic hook + `log_frontend_error` already implemented.

### §13 Frontend e2e tests (medium)
- **What:** Unit tests for pure frontend logic exist (Vitest); no e2e tests.
- **Why:** Full user flows (scan → navigate → delete) not covered.
- **When:** Consider Playwright/WebdriverIO against a Tauri dev build. Separate session.

### §12 Accessibility — contrast/touch targets (small)
- **What:** Breadcrumb `aria-current` added; contrast and touch-target sizes not yet verified.
- **Why:** Improve screen-reader and keyboard support.
- **When:** Verify contrast ratios and touch-target sizes. Small change.

## Resolved debt

### §2 Binary format magic byte + version — DONE
- **What:** `get_binary_tree` now writes a `SRBT` magic + version header; `deserializeBinaryTree` validates it and fails loudly on mismatch.
- **When:** Resolved in this session.

### §5 Centralized timeouts — DONE
- **What:** `IPC_TIMEOUT_DEFAULT_MS` (10s) + `IPC_TIMEOUT_SCAN_MS` (60s) in `lib/utils.js`; `invokeWithTimeout` defaults to the central constant; remaining raw `invoke` calls converted.
- **When:** Resolved in `42c4c45`.

### §14 Duplicate `isWindows` detection — DONE
- **What:** Shared `Utils.isWindows` in `lib/utils.js`; removed duplicates from `menu.js` and `scanner.js`.
- **When:** Resolved in `42c4c45`.

### §12 Accessibility — breadcrumb labels — DONE
- **What:** `aria-current="page"` on the active breadcrumb item.
- **When:** Resolved in `42c4c45`.

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
- **What:** `42c4c45` (debt round) is on top of `b1cce1d`, `4499340`, `b025e98` — 4 commits ahead of `origin/main` (`fcdf320`).
- **Why:** Not yet pushed to GitHub.
- **When:** Push after the current session + release prep.
