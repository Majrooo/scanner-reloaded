# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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