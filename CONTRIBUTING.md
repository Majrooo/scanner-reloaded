# Contributing to Scanner Reloaded

First off, thank you for considering contributing! 🎉

Scanner Reloaded is a hobby project built with AI assistance, and all contributions — bug reports, feature ideas, code, or testing on Linux/macOS — are very welcome.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How to Report a Bug](#how-to-report-a-bug)
- [How to Request a Feature](#how-to-request-a-feature)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Commit Conventions](#commit-conventions)
- [Pull Request Process](#pull-request-process)

## Code of Conduct

Please read and follow our [Code of Conduct](.github/CODE_OF_CONDUCT.md).

## How to Report a Bug

Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md) when opening an issue.

Please include:

- **Environment**: OS (Windows/macOS/Linux + distro/version), app version, installation type (installer/portable)
- **File system** (NTFS, ext4, btrfs, APFS, ...) — important for performance/edge-case bugs
- **Steps to reproduce** and expected vs. actual behavior
- **Screenshots** or a short video if it helps
- The **error log** if available (Settings → error log, or the `error.log` file)

## How to Request a Feature

Use the [Feature Request template](.github/ISSUE_TEMPLATE/feature_request.md).

Explain the problem you're trying to solve and a concrete idea for the solution. The more context (screenshots, mockups, links to similar tools), the better.

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS)
- [Rust & Cargo](https://www.rust-lang.org/)
- System dependencies for Tauri v2 (see the [Tauri Prerequisites Guide](https://tauri.app/v2/guides/prerequisites/))

### Run in development

```bash
npm install
npm run tauri dev
```

### Run the tests

```bash
cd src-tauri
cargo test
```

Runs the backend unit tests for the core functions (`serialize_to_binary`, `build_dir_node`, `merge_small_files`, `normalize_paths`, `is_protected_path`, config defaults).

### Build a release bundle

```bash
npm run tauri build
```

The installer package will be generated in `src-tauri/target/release/bundle/`.

## Project Structure

- **`src/`** — frontend (HTML, CSS, vanilla JS, D3.js)
  - `main.js` — menu screen logic
  - `scanner.js` — scan/chart screen logic
  - `lib/` — shared modules (`utils.js`, `i18n.js`)
  - `translations.json` — EN + SK strings
- **`src-tauri/`** — Rust backend
  - `src/lib.rs` — Tauri commands, platform abstractions, scanning logic
  - `tauri.conf.json` — app configuration

## Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature
fix: correct a bug
docs: update documentation
refactor: improve code without changing behavior
chore: housekeeping (deps, tooling, git)
perf: improve performance
```

Scope is optional but nice, e.g. `feat(scanner): ...` or `fix(settings): ...`.

## Pull Request Process

1. Fork the repository and create a branch from `main` with a descriptive name (e.g. `fix/trash-linux`, `feat/folder-size-tooltip`).
2. Make your changes. Keep them focused and scoped — avoid unrelated refactoring.
3. **Update documentation** if you change behavior (README, CHANGELOG).
4. Run the backend tests and a quick build check: `cargo test` and `npm run tauri build` (or at least `cargo build` in `src-tauri/`).
5. Open a PR using the [Pull Request template](.github/PULL_REQUEST_TEMPLATE.md).
6. Reference any related issue in the PR description (e.g. `Closes #12`).

> **Note:** The backend has unit tests (`cargo test` in `src-tauri/`). If your change touches risky backend logic (scanning, deletion, trash), also describe in the PR how you tested it and on which OS/file system.
</｜｜DSML｜｜>
</｜｜DSML｜｜>
</write_to_file>