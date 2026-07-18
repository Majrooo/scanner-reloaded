# Release Process

Tento návod popisuje, ako vytvoriť nový release pre **Scanner Reloaded** pomocou GitHub Actions.

## Predpoklady

- Všetky zmeny pre novú verziu sú commitnuté a pushnuté do `main`
- GitHub Actions workflow je nastavený (`.github/workflows/release.yml`)

## Postup krok za krokom

### 1. Aktualizuj CHANGELOG.md

Pridaj novú sekciu na začiatok `CHANGELOG.md`:

```markdown
## [0.2.0] - 2026-MM-DD

### Added
- Nová feature 1
- Nová feature 2

### Fixed
- Opravený bug 1

### Changed
- Zmena 1

[0.2.0]: https://github.com/Majrooo/scanner-reloaded/releases/tag/v0.2.0
```

### 2. Zvýš verziu (automaticky)

Spusti príkaz, ktorý zvýši verziu vo všetkých 3 súboroch naraz, vytvorí commit a tag:

```bash
npm run bump patch   # 0.1.0 → 0.1.1 (opravy)
npm run bump minor   # 0.1.0 → 0.2.0 (nové funkcie)
npm run bump major   # 0.1.0 → 1.0.0 (nekompatibilné zmeny)
```

Tento príkaz:
- Zvýši verziu v `package.json`, `src-tauri/Cargo.toml` aj `src-tauri/tauri.conf.json`
- Vytvorí git commit: `chore: bump version to 0.2.0`
- Vytvorí git tag: `v0.2.0`

### 3. Pushni zmeny

```bash
git push origin main && git push origin v0.2.0
```

### 5. GitHub Actions spustí automatický build

Po pushnutí tagu sa automaticky spustí workflow `.github/workflows/release.yml`, ktorý:

1. Vybuildí aplikáciu na **Windows**, **macOS** a **Linux**
2. Extrahuje release notes z `CHANGELOG.md` pre danú verziu
3. Vytvorí **draft release** na GitHub
4. Priloží inštalačné balíčky (MSI, NSIS, DMG, AppImage)
5. Priloží **portable verzie**:
   - `scanner-reloaded_0.2.0_x64_portable.zip` (Windows)
   - `scanner-reloaded_0.2.0_x64_portable.tar.gz` (Linux)
   - `scanner-reloaded_0.2.0_x64_portable.zip` alebo `..._aarch64_portable.zip` (macOS)

### 6. Skontroluj a publikuj release

1. Choď na [github.com/Majrooo/scanner-reloaded/releases](https://github.com/Majrooo/scanner-reloaded/releases)
2. Nájdi draft release s názvom `Release v0.2.0`
3. Skontroluj release notes (automaticky extrahované z `CHANGELOG.md`)
4. Skontroluj priložené súbory (inštalátory + portable)
5. Klikni **"Publish release"**

## Zhrnutie (príkazový riadok)

```bash
# 1. Aktualizuj CHANGELOG.md (ručne)

# 2. Zvýš verziu, commit a tag (automaticky)
npm run bump minor

# 3. Pushni všetko
git push origin main && git push origin v0.2.0

# 4. Hotovo — GitHub Actions spraví zvyšok
```

## Riešenie problémov

### Workflow sa nespustil
- Skontroluj, či tag začína na `v` (napr. `v0.2.0`, nie `0.2.0`)
- Skontroluj, či je `.github/workflows/release.yml` v `main` vetve

### Build zlyhal
- Choď na [github.com/Majrooo/scanner-reloaded/actions](https://github.com/Majrooo/scanner-reloaded/actions)
- Klikni na neúspešný workflow run
- Pozri si logy a zistí príčinu zlyhania

### Release sa nevytvoril
- Skontroluj, či `GITHUB_TOKEN` má `contents: write` permisie
- Skontroluj, či `tauri.conf.json` má `"bundle": { "active": true }`