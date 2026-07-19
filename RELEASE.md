# Release Process

This guide describes how to create a new release for **Scanner Reloaded** using GitHub Actions.

> **Important:** The entire `CHANGELOG.md` must be written in **English only** — all entries, templates, and notes.

## Prerequisites

- All changes for the new version are committed and pushed to `main`
- GitHub Actions workflow is configured (`.github/workflows/release.yml`)

## Step-by-step

### 1. Update CHANGELOG.md

Add a new section at the top of `CHANGELOG.md` (English only):

```markdown
## [0.3.0] - 2026-MM-DD

### Added
- New feature 1
- New feature 2

### Fixed
- Bug fix 1

### Changed
- Change description 1

[0.3.0]: https://github.com/Majrooo/scanner-reloaded/releases/tag/v0.3.0
```

### 2. Bump version (automatic)

Run the command that bumps the version in all 3 files, creates a commit and a tag:

```bash
npm run bump patch   # 0.1.0 → 0.1.1 (bug fixes)
npm run bump minor   # 0.1.0 → 0.2.0 (new features)
npm run bump major   # 0.1.0 → 1.0.0 (breaking changes)
```

This command:
- Bumps version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`
- Creates a git commit: `chore: bump version to 0.3.0`
- Creates a git tag: `v0.3.0`

### 3. Push changes

```bash
# Windows (PowerShell) — use semicolon instead of &&
git push origin main; git push origin v0.3.0

# Linux / macOS
git push origin main && git push origin v0.3.0
```

### 4. GitHub Actions runs the build automatically

After pushing the tag, the workflow `.github/workflows/release.yml` automatically:

1. Builds the application on **Windows**, **macOS** and **Linux**
2. Extracts release notes from `CHANGELOG.md` for the version
3. Runs `cargo build --release` so portable packaging can find the binary
4. Creates a **draft release** on GitHub
5. Attaches installer packages (MSI, NSIS, DMG, AppImage)
6. Attaches **portable versions**:
   - `scanner-reloaded_0.3.0_x64_portable.zip` (Windows)
   - `scanner-reloaded_0.3.0_x64_portable.tar.gz` (Linux)
   - `scanner-reloaded_0.3.0_x64_portable.zip` or `..._aarch64_portable.zip` (macOS)

### 5. Review and publish the release

1. Go to [github.com/Majrooo/scanner-reloaded/releases](https://github.com/Majrooo/scanner-reloaded/releases)
2. Find the draft release with the name `Release v0.3.0`
3. Review the release notes (automatically extracted from `CHANGELOG.md`)
4. Check the attached files (installers + portable)
5. Click **"Publish release"**

## Quick summary

```bash
# 1. Update CHANGELOG.md (manually, in English)

# 2. Bump version, commit and tag (automatic)
npm run bump minor

# 3. Push everything
git push origin main; git push origin v0.3.0

# 4. Done — GitHub Actions takes care of the rest
```

## Troubleshooting

### Workflow didn't start
- Check that the tag starts with `v` (e.g. `v0.3.0`, not `0.3.0`)
- Check that `.github/workflows/release.yml` exists in the `main` branch

### Build failed
- Go to [github.com/Majrooo/scanner-reloaded/actions](https://github.com/Majrooo/scanner-reloaded/actions)
- Click on the failed workflow run
- Check the logs to find the cause

### Release wasn't created
- Check that `GITHUB_TOKEN` has `contents: write` permissions
- Check that `tauri.conf.json` has `"bundle": { "active": true }`

### Portable files are missing from the release
- Check that the `cargo build --release` step ran before `tauri-action` in the workflow
- The workflow must build the Rust binary first so the packaging step can find it