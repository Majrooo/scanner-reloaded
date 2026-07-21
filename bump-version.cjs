const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── Parse argument ─────────────────────────────────────────────────────────
const bumpType = process.argv[2]; // 'patch', 'minor', 'major'

if (!bumpType || !['patch', 'minor', 'major'].includes(bumpType)) {
  console.error('❌ Použitie: node bump-version.js <patch|minor|major>');
  console.error('   Príklad: node bump-version.js patch');
  process.exit(1);
}

// ─── Cesty k súborom ────────────────────────────────────────────────────────
const paths = {
  packageJson: path.join(__dirname, 'package.json'),
  tauriConf: path.join(__dirname, 'src-tauri', 'tauri.conf.json'),
  cargoToml: path.join(__dirname, 'src-tauri', 'Cargo.toml'),
  cargoLock: path.join(__dirname, 'src-tauri', 'Cargo.lock'),
};

try {
  // ─── Načítaj aktuálnu verziu z package.json ─────────────────────────────
  const pkg = JSON.parse(fs.readFileSync(paths.packageJson, 'utf8'));
  const currentVersion = pkg.version;

  if (!/^\d+\.\d+\.\d+$/.test(currentVersion)) {
    console.error(`❌ Aktuálna verzia "${currentVersion}" nie je platná (očakáva sa X.Y.Z)`);
    process.exit(1);
  }

  // ─── Vypočítaj novú verziu ──────────────────────────────────────────────
  const parts = currentVersion.split('.').map(Number);
  let [major, minor, patch] = parts;

  switch (bumpType) {
    case 'major':
      major += 1;
      minor = 0;
      patch = 0;
      break;
    case 'minor':
      minor += 1;
      patch = 0;
      break;
    case 'patch':
      patch += 1;
      break;
  }

  const newVersion = `${major}.${minor}.${patch}`;

  // ─── 1. Aktualizácia package.json ───────────────────────────────────────
  pkg.version = newVersion;
  fs.writeFileSync(paths.packageJson, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ✓ package.json → ${newVersion}`);

  // ─── 2. Aktualizácia tauri.conf.json ────────────────────────────────────
  const tauri = JSON.parse(fs.readFileSync(paths.tauriConf, 'utf8'));
  tauri.version = newVersion;
  fs.writeFileSync(paths.tauriConf, JSON.stringify(tauri, null, 2) + '\n');
  console.log(`  ✓ tauri.conf.json → ${newVersion}`);

  // ─── 3. Aktualizácia Cargo.toml ─────────────────────────────────────────
  let cargo = fs.readFileSync(paths.cargoToml, 'utf8');
  cargo = cargo.replace(/^version\s*=\s*"[^"]*"/m, `version = "${newVersion}"`);
  fs.writeFileSync(paths.cargoToml, cargo);
  console.log(`  ✓ Cargo.toml → ${newVersion}`);

  // ─── 4. Aktualizácia Cargo.lock ─────────────────────────────────────────
  let cargoLock = fs.readFileSync(paths.cargoLock, 'utf8');
  const lockRegex = new RegExp(`(name = "scanner-reloaded"\\nversion = )"${currentVersion.replace(/\./g, '\\.')}"`, 'm');
  if (lockRegex.test(cargoLock)) {
    cargoLock = cargoLock.replace(lockRegex, `$1"${newVersion}"`);
    fs.writeFileSync(paths.cargoLock, cargoLock);
    console.log(`  ✓ Cargo.lock → ${newVersion}`);
  } else {
    console.warn(`  ⚠ Cargo.lock: pattern not found (may already be up-to-date)`);
  }

  // ─── Git commit a tag ──────────────────────────────────────────────────
  const filesToAdd = [
    'package.json',
    'src-tauri/tauri.conf.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'CHANGELOG.md',
  ];

  console.log(`\n  Vytváram commit a tag...`);
  execSync(`git add ${filesToAdd.join(' ')}`, { stdio: 'inherit' });
  execSync(`git commit -m "chore: bump version to ${newVersion}"`, { stdio: 'inherit' });
  execSync(`git tag -a v${newVersion} -m "v${newVersion}"`, { stdio: 'inherit' });

  console.log(`\n🎉 Hotovo! Verzia zvýšená z ${currentVersion} na ${newVersion}`);
  console.log(`\n📌 Nezabudni:`);
  console.log(`   1. Skontrolovať a dopísať CHANGELOG.md`);
  console.log(`   2. Pushnúť: git push origin main && git push origin v${newVersion}`);

} catch (error) {
  console.error('\n❌ Chyba:', error.message);
  process.exit(1);
}