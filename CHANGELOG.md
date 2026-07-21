# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### Granular Error Logging
- **`LogCategory` enum**: `Permission` (WalkDir/metadata errors) and `Internal` (stack, lock, emit failures)
- **`LoggingConfig` struct** with per-category boolean flags (both default `true`), persisted in Rust config
- **`log_error()`** function respects per-category settings; uses ISO 8601 timestamps, 1 MB log rotation
- **App Settings modal** (⚙️ on menu screen): two checkboxes instead of single toggle, each with ⓘ info tooltip
- New Tauri commands `get_logging_config` / `set_logging_config` replacing the old single toggle
- 5 new translation keys for SK + EN

#### Permission / Access Denied Handling
- Replaced `WalkDir::into_iter().filter_map(\|e\| e.ok())` — errors (including `AccessDenied`) are no longer silently skipped
- `HashSet<String>` collects unique denied paths during scanning
- WalkDir `Err` and `entry.metadata()` `Err` paths logged via `log_error()` and added to `denied_paths`
- New `AccessDeniedPayload` struct and `scan-access-denied` event emitted before `scan-finished`
- Frontend listener in `scanner.js` shows localized toast with count of skipped folders
- New translation keys `scanScreen.accessDenied` for SK + EN
- `unlistenAccessDenied` added to all cleanup paths (`scan-finished`, `scan-failed`, `goBackToMenu`)
- `scan_directory()` signature extended with `denied_paths: &mut HashSet<String>`

#### IPC Timeout Wrapper
- **`invokeWithTimeout(command, args, timeoutMs)`** in `utils.js` — `Promise.race` with `setTimeout`
- New translation key `toast.ipcTimeout` (SK + EN)
- **scanner.js**: 9 invocations replaced (cancel, clear, thresholds, file ops)
- **menu.js**: 7 invocations replaced (disks, directory validation, system utilities, config)
- Timeouts: 5s (config/settings), 10s (file operations), 15s (trash/delete)
- Explicitly excluded: `get_binary_tree` and `start_async_scan` (event-driven)

#### Central Error Handler
- Global `window.onerror` and `unhandledrejection` handler in `src/main.js`
- Handler shows localized toast via `Utils.showToast()` + `I18n.getText()`
- `isHandlingError` guard prevents recursive error handling loops
- `main.js` loaded in both `index.html` and `scanner.html`
- New translation key `errors.unexpected` (SK + EN)

#### Consistent Toast Messages
- All `showToast()` calls unified to use localized keys via `getText()`
- Added `extractErrorMessage()` helper in `utils.js` — extracts human-readable error from various types (string, Error, Tauri error)
- 5 new translation keys: `folderNotFound`, `treeLoadFailed`, `tcLaunchFailed`, `trashFailed`, `deleteFailed` (SK + EN)
- Replaced 6 hardcoded strings/raw error objects in `scanner.js`

#### Filter Disable Warning
- **`countNodesWithoutFilter(p)`** function in `scanner.js` — counts visible descendant nodes without the performance filter
- When disabling the filter and node count exceeds `filterDisableWarningThreshold` (default 2000), shows a `showConfirm` warning before potential freezing
- New setting `filter-warning-threshold` in settings modal (Performance & Filtering section)
- New translation keys `scanScreen.filterWarning.*` and `settingsModal.performance.filterDisableWarningThreshold` and `settingsModal.info.filterDisableWarningThreshold` for SK and EN
- Setting persisted in localStorage via `APP_CONFIG`, loaded and reset together with other settings

#### Help Modals
- **Menu help modal** (`?` button in menu screen header): 7 items explaining disk selection, folder scanning, drag & drop, refresh, system utilities, language, and about
- **Scan help modal** (`?` button in scan screen header): 7 items including chart navigation, breadcrumbs, context menu, fast filter, segment colors with real color swatches, info panel, and settings
- **Color swatches** in scan help modal dynamically render from `APP_CONFIG.colors` — always reflects actual chart colors
- New translation keys `helpModalMenu.*` and `helpModalScan.*` for SK and EN
- CSS styles for `.help-modal-content`, `.help-item`, `.color-swatch`, `.help-colors-row`

#### Color Configuration
- **`APP_CONFIG.colors`**: sunburst chart colors moved from hardcoded `getFillColor()` to config (`dirShallow`, `dirDeep`, `file`, `others`, `superSmall`)
- `getFillColor()` now reads from `APP_CONFIG.colors` — single source of truth, persistable via localStorage

### Changed

#### Rust Backend — `unwrap()` Removal
- 8× `unwrap()` in `scan_directory()` DFS stack logic replaced with `let-else`
- All `let-else` branches use graceful degradation (`break` / `continue`) instead of panicking
- Added `chrono` dependency for ISO 8601 timestamps in error logging

#### File Size Formatting (Human-Readable)
- `formatBytes()` in `src/lib/utils.js`: intelligent decimal places, `'Bytes'` → `'B'`, added `PB` support, protection against `NaN`/`Infinity`/negative values
- Removed duplicate `formatBytes()` from `src/scanner.js` — all calls now use `Utils.formatBytes`
- Always uses 2 decimal places with `parseFloat` stripping trailing zeros (e.g. `"1.53 GB"`, `"12.5 GB"`, `"523.39 GB"`)

#### IPC Event Throttling
- Backend `scan-live-folder` emit throttle increased from 50ms to 100ms — max 10 events/sec instead of 20
- Matched with frontend UI throttle (100ms) — fewer JSON serializations and IPC transfers

#### Descriptive Error Messages
- 7 backend error messages unified to Slovak (matching UI language) with added context (path)
- Examples: `"Failed to save scan state"` → `"Nepodarilo sa uložiť výsledky skenovania pre: C:\..."`

#### Platform-Specific Code Abstraction
- 3 Tauri commands refactored into `platform_*` helper functions:
  - `show_in_file_manager` → `platform_show_in_file_manager()` (win/mac/linux)
  - `show_file_properties` → `platform_show_file_properties()` (win/mac/linux)
  - `move_to_trash` → `platform_move_to_trash()` (win/mac/linux)
- Command handlers now thin wrappers with path validation + platform dispatch

#### Header Layout
- `?` and `⚙️` buttons wrapped in `.header-right-actions` container for proper grid alignment (3-column header grid preserved)
- **Removed redundant `cancel-scan-btn`** (HTML, JS, CSS) — `back-btn` already serves as cancel button during scans
- Unified button dimensions: `#back-to-disks-btn` padding `8px` → `10px`, `.icon-btn` added `min-width: 44px`, `text-align: center`, `line-height: 1.2`

### Removed

- Dead code `as_str()` method from `LogCategory` enum

### Fixed

- **About modal version**: app version now loaded dynamically from Tauri API (`getVersion()`) instead of hardcoded `0.1.0`
- **Info-toggle buttons (`ⓘ`) in settings modal** stopped working after help modal was added — `document.querySelector('.modal-body')` was hitting the wrong modal. Fixed by scoping to `settingsModal.querySelector('.modal-body')`

## [0.2.0] - 2026-07-19

### Added

#### Backend Merge of Small Files
- **Rust backend merge**: `merge_small_files(node, threshold)` recursively merges files smaller than a configurable threshold into a single `__super_small_files__` node per directory
- **AppConfig**: extended with `backend_merge_threshold_kb: Option<u64>`, new Tauri commands `get_backend_merge_threshold` / `set_backend_merge_threshold`
- **Frontend support**: global `backendMergeThresholdKb` variable, `countFileNodes()`, improved `logFileSizeStats()`
- **Settings slider**: backend merge threshold (0-1024 KB, step 32) with info card
- **Result**: 1.34M → 240k FileNode objects (82% fewer), ~500 MB RAM instead of 3-4 GB

#### Stats Bar — Direct/Total Counts
- **`getDirectStats(node)`** in scanner.js — counts direct children (non-recursive), skips recursive `size` of directories
- `#scan-stats-bar` split into `#stats-bar-direct` and `#stats-bar-total` (both 14px)

#### Tooltip / Info Cards in Settings
- 8 `ⓘ` buttons in the settings modal — click to show a brief explanation (SK/EN)
- CSS styles for `.info-toggle-btn` (blue, hover enlarge, active gold) and `.setting-info-card`
- i18n section `settingsModal.info` with detailed explanations

#### Hover Panel Reposition
- `#hover-panel` moved from inside `#chart-layout` to between `#scan-stats-bar` and `#empty-folder-message`
- Fixed 85px height preserved — information panels side by side, no eye travel across the chart

#### Window Flash Fix
- `"visible": false` in `tauri.conf.json` — window created invisible
- `.setup()` hook with 50ms delay via `std::thread::spawn` calls `window.show()`
- `tauri-plugin-window-state` applies saved position/size before the window becomes visible

#### Release Infrastructure
- **GitHub Actions release workflow** (`.github/workflows/release.yml`) — build on Windows/macOS/Linux, changelog extraction, draft release with installers and portable packages
- **Portable versions**: `_portable.zip` (Windows), `_portable.tar.gz` (Linux), `_portable.zip` (macOS) with arch-aware naming
- **Automatic version bump script** (`bump-version.cjs`) — bumps version in `package.json`, `Cargo.toml`, `tauri.conf.json`, creates commit and tag
- **RELEASE.md** — release process documentation
- **README.md** — download instructions and platform details

### Changed
- **Hover panel position**: moved above filter controls, below stats bar
- **Stats bar**: split into direct and total counts, both rows equally sized (14px)
- **Translations**: `scanScreen.statsBar` → object with `direct`/`total`, new key `scanScreen.stats.mergedFiles`
- **Backend merge colors**: `__super_small_files__` → `#b33a4d` (wine red), `__others__` → `#585b70` (warm neutral)

### Removed
- **`count_file_nodes()`** in Rust (dead code — removed 2026-07-19)
- Debug prints from `start_async_scan()` after backend merge testing

### Fixed
- **Window flash at startup**: window no longer appears at wrong position before saved state is applied
- **translations.json**: overwritten with original texts from `git show HEAD`, only new keys added (original translations preserved)
- **`__others__` color**: changed from `#000000` to `#585b70` — warm neutral, better visual harmony

[0.2.0]: https://github.com/Majrooo/scanner-reloaded/releases/tag/v0.2.0

## [0.1.0] - 2026-07-17

### Added

#### Core Features
- **Disk scanning**: Fast, multi-threaded directory traversal using Rust and WalkDir
- **Interactive Sunburst chart**: D3.js-based visualization of file system hierarchy
- **File operations**: Delete files/folders, move to trash, open in file manager (Explorer/Finder)
- **Drag & drop**: Drop folders onto the app to scan them directly
- **Scan cancellation**: Cancel active scans at any time with visual feedback

#### Performance
- **In-place tree building**: O(n) tree construction during DFS traversal — eliminates HashMap and sort overhead
- **GZip + Base64 binary transfer**: Compressed IPC payload reduces transfer size from ~200MB to ~30MB
- **FxHashMap**: Faster hash map implementation for ~10-15% speed improvement
- **Arc\<str\>**: Memory-efficient string sharing reduces RAM usage by ~30% for 100k+ files
- **Collapsed view cache**: Pre-built D3 hierarchies cached per path for instant re-navigation
- **O(1) path lookup**: Path-to-node index map eliminates recursive searches
- **Performance filter**: Auto-toggle for filtering out microscopic files during zoom (based on item count or directory size)
- **Minimum angle setting**: Configurable minimum arc angle to control chart detail level

#### User Interface
- **Responsive layout**: Flexbox-based full-window design with ResizeObserver for dynamic chart redraw
- **Fixed-height hover panel**: 85px panel prevents layout shift when hover details change
- **Skeleton loaders**: Shimmer animation placeholders while disk list loads
- **Breadcrumb navigation**: Clickable path navigation with overflow truncation
- **Hover highlighting**: Highlight hovered segment and its ancestors in the chart
- **Zoom animations**: Smooth arc transitions with inner/outer radius interpolation (spiral, sequential, staggered intro animations)
- **Settings modal**: User preferences for performance filters, animation duration, and minimum angle
- **Reset settings**: One-click restore of default settings
- **Toast notifications**: Non-blocking feedback for actions
- **Accessibility**: `:focus-visible` styles, `prefers-reduced-motion` support

#### Internationalization
- **Multi-language support**: English and Slovak translations
- **Dynamic i18n**: Translations applied via `data-i18n` and `data-i18n-title` attributes
- **Language selector**: Dropdown in the menu screen with persisted preference

#### System Integration
- **Total Commander integration**: Configurable external tool launcher for Windows
- **System utilities section**: Windows-specific system tools access
- **Drag & drop validation**: Ensures only valid directories are accepted

#### Technical
- **Shared modules**: `src/lib/i18n.js` and `src/lib/utils.js` for code reuse
- **Native `<dialog>` API**: Modern modal implementation with fallback support
- **Binary tree serialization**: Efficient data transfer between Rust backend and JS frontend
- **Memory optimization**: `structuredClone` replaces `JSON.parse(JSON.stringify(...))` for deep cloning
- **WebView memory cleanup**: `optimize_webview_memory` command on menu navigation

### Fixed

- **Zoom animation smoothness**: ArcTween now interpolates inner/outer radii — no more jumpy transitions
- **ResizeObserver interference**: Flag blocking during zoom animations prevents chart redraw conflicts
- **Hover panel layout shift**: Fixed `min-height` → `height` to prevent content reflow
- **Production build crash**: Input type normalization for binary data transfer in Tauri v2 production builds
- **Breadcrumb overflow**: Proper text truncation with real overflow detection (`scrollWidth > clientWidth`)
- **Back button behavior**: Doubles as cancel button during active scan with visual (red) feedback
- **Memory tree state**: `memoryTree` initialization changed from `{}` to `null` for consistent truthy/falsy behavior
- **Drag & drop events**: Updated event type handling for Tauri v2 compatibility
- **CSS cleanup**: Removed duplicate modal styles between `styles.css` and `scanner-settings.css`
- **Color contrast**: Lightened empty state color for better readability

### Changed

- **Code architecture**: Extracted shared i18n and utility modules; scanner.js retains local copies to avoid declaration conflicts
- **Scan progress UI**: Removed live ticker, streamlined scan completion handling
- **Chart rendering**: Partition layout computed once in `drawSunburst` — removed redundant `gPartition` from `zoomTo`
- **Animation system**: Extracted into `src/animations.js` with configurable intro animation types
- **Settings persistence**: Performance filter settings persisted and applied on scan
- **Button styling**: Consistent padding and min-height across action buttons

### Removed

- `fxhash` dependency (replaced by in-place tree building)
- `FxHashMap` import and usage from Rust backend
- Unused `_start_time` variable in `src-tauri/src/lib.rs`
- Redundant `gPartition` computation in `zoomTo`
- Duplicate CSS rules for modal dialogs

### Security

- HTML escaping via `String.fromCharCode(38)` concatenation to prevent XSS in tooltips
- Input validation for drag-and-drop directory paths

[0.1.0]: https://github.com/Majrooo/scanner-reloaded/releases/tag/v0.1.0