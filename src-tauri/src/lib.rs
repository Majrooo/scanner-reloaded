use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Instant;
use sysinfo::Disks;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;
use std::collections::HashMap;
use tauri::WebviewWindow;

// A8: Globálny flag pre zrušenie skenovania
static SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

// Globálny stav pre dynamické načítanie podstromov (Local Relative Throttling)
#[derive(Default)]
pub struct ScanState {
    current_tree: Mutex<Option<FileNode>>,
}

const OTHERS_NAME: &str = "__others__";
// Prah pre relatívne orezávanie: 0.1 % z veľkosti aktuálne zobrazeného priečinka
const RELATIVE_THRESHOLD: f64 = 0.001;

// ─── Disk Info ───────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct DiskInfo {
    name: String,
    mount_point: String,
    total_space: u64,
    available_space: u64,
    kind: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct FileNode {
    name: Box<str>,
    path: Box<str>,
    size: u64,
    is_dir: bool,
    dir_count: usize,
    file_count: usize,
    children: Vec<FileNode>,
}

#[derive(Serialize, Clone)]
struct LivePayload {
    path: String,
    size: u64,
}

// ─── Total Commander Config ──────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Default)]
struct AppConfig {
    total_commander_path: Option<String>,
}

/// Returns the path to the config file: {app_data}/scanner-reloaded/config.json
fn get_config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("scanner-reloaded").join("config.json"))
}

fn load_config() -> AppConfig {
    if let Some(path) = get_config_path() {
        if path.exists() {
            if let Ok(data) = std::fs::read_to_string(&path) {
                if let Ok(cfg) = serde_json::from_str(&data) {
                    return cfg;
                }
            }
        }
    }
    AppConfig::default()
}

fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let path = get_config_path().ok_or("Nepodarilo sa nájsť konfiguračný priečinok")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

/// Try to find Total Commander via Windows registry
#[cfg(target_os = "windows")]
fn find_tc_in_registry() -> Option<String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, RegCloseKey, RegOpenKeyExW,
        RegQueryValueExW,
    };

    let registry_paths = [
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Ghisler\Total Commander",
            "InstallDir",
        ),
        (
            HKEY_CURRENT_USER,
            r"SOFTWARE\Ghisler\Total Commander",
            "InstallDir",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Ghisler\Total Commander",
            "InstallDir",
        ),
    ];

    for (hkey, subkey, value_name) in &registry_paths {
        let wide_subkey: Vec<u16> = OsStr::new(subkey)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let wide_value: Vec<u16> = OsStr::new(value_name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            let mut h_key: windows_sys::Win32::System::Registry::HKEY = 0;
            if RegOpenKeyExW(*hkey, wide_subkey.as_ptr(), 0, KEY_READ, &mut h_key) != 0 {
                continue;
            }

            let mut buf_len: u32 = 1024;
            let mut buf: Vec<u8> = vec![0; buf_len as usize];
            let mut value_type: u32 = 0;

            let result = RegQueryValueExW(
                h_key,
                wide_value.as_ptr(),
                std::ptr::null_mut(),
                &mut value_type,
                buf.as_mut_ptr(),
                &mut buf_len,
            );

            RegCloseKey(h_key);

            if result == 0 && buf_len > 2 {
                // Convert to UTF-16 then to String
                let wide: Vec<u16> = buf[..buf_len as usize]
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .take_while(|&c| c != 0)
                    .collect();
                if let Some(s) = String::from_utf16(&wide).ok() {
                    let exe_path = Path::new(&s).join("TOTALCMD64.EXE");
                    if exe_path.exists() {
                        return Some(exe_path.to_string_lossy().into_owned());
                    }
                    let exe_path32 = Path::new(&s).join("TOTALCMD.EXE");
                    if exe_path32.exists() {
                        return Some(exe_path32.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    None
}

/// Common well-known paths for Total Commander
fn find_tc_by_known_paths() -> Option<String> {
    let candidates = [
        r"C:\totalcmd\TOTALCMD64.EXE",
        r"C:\totalcmd\TOTALCMD.EXE",
        r"C:\Program Files\totalcmd\TOTALCMD64.EXE",
        r"C:\Program Files\totalcmd\TOTALCMD.EXE",
        r"C:\Program Files (x86)\totalcmd\TOTALCMD64.EXE",
        r"C:\Program Files (x86)\totalcmd\TOTALCMD.EXE",
    ];
    for candidate in &candidates {
        if Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Resolve Total Commander executable path.
/// Priority: 1) config file, 2) registry, 3) known paths, 4) PATH fallback
fn resolve_tc_path() -> Result<String, String> {
    // 1) Config file
    let cfg = load_config();
    if let Some(ref p) = cfg.total_commander_path {
        if Path::new(p).exists() {
            return Ok(p.clone());
        }
    }

    // 2) Registry (Windows only)
    #[cfg(target_os = "windows")]
    if let Some(p) = find_tc_in_registry() {
        return Ok(p);
    }

    // 3) Known paths
    if let Some(p) = find_tc_by_known_paths() {
        return Ok(p);
    }

    // 4) PATH fallback
    Ok("totalcmd.exe".to_string())
}

// ─── Protected paths for permanent_delete ────────────────────────────────────

/// Check if the path is a system/protected directory that should never be deleted.
fn is_protected_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('/', "\\");
    let normalized_lower = normalized.to_lowercase();
    let trimmed = normalized_lower.trim_end_matches('\\');

    let protected = [
        r"c:\windows",
        r"c:\program files",
        r"c:\program files (x86)",
        r"c:\programdata",
        r"c:\users",
        r"c:\",
        // Linux/macOS
        "/",
        "/bin",
        "/boot",
        "/dev",
        "/etc",
        "/home",
        "/lib",
        "/lib64",
        "/proc",
        "/root",
        "/sbin",
        "/sys",
        "/usr",
        "/var",
    ];

    protected.iter().any(|p| trimmed == *p)
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
fn get_disks() -> Vec<DiskInfo> {
    let disks = Disks::new_with_refreshed_list();
    let mut result = Vec::new();
    for disk in &disks {
        let name = disk.name().to_string_lossy().into_owned();
        let mount_point = disk.mount_point().to_string_lossy().into_owned();

        // B4: Pridanie typu disku (SSD/HDD)
        let kind = match disk.kind() {
            sysinfo::DiskKind::SSD => "ssd",
            sysinfo::DiskKind::HDD => "hdd",
            _ => "unknown",
        };

        // B4: Nefiltrujeme Unknown disky - USB/externé disky môžu byť detekované ako Unknown
        if mount_point.contains("BaseImages") {
            continue;
        }
        if disk.total_space() == 0 {
            continue;
        }

        result.push(DiskInfo {
            name: if name.is_empty() {
                mount_point.clone()
            } else {
                name
            },
            mount_point,
            total_space: disk.total_space(),
            available_space: disk.available_space(),
            kind: kind.to_string(),
        });
    }
    result
}

fn scan_directory(
    root_path: &Path,
    app_handle: &AppHandle,
    last_emit: &mut Instant,
    running_total: &mut u64,
) -> Option<FileNode> {
    // Vytvoríme si pomocnú mapu pre zostavenie stromu (od koncových uzlov ku koreňu)
    let mut nodes: HashMap<PathBuf, FileNode> = HashMap::with_capacity(250_000);
    let mut paths_to_process = Vec::with_capacity(250_000);

    // 1. Prejdeme celý disk pomocou WalkDir lineárne bez rekurzie.
    // follow_links(false) tu striktne zakáže prechod na disk C: cez akékoľvek Junctions/Symlinks.
    let walker = WalkDir::new(root_path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok());

    for entry in walker {
        if SCAN_CANCELLED.load(Ordering::Relaxed) {
            return None;
        }

        let path = entry.path().to_path_buf();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // Preskočíme priečinky bez prístupových práv (napr. System Volume Information)
        };

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned().into_boxed_str())
            .unwrap_or_else(|| path.to_string_lossy().into_owned().into_boxed_str());

        if metadata.is_dir() {
            let path_str = path.to_string_lossy().into_owned().into_boxed_str();
            nodes.insert(
                path.clone(),
                FileNode {
                    name,
                    path: path_str.clone(),
                    size: 0,
                    is_dir: true,
                    dir_count: 1,
                    file_count: 0,
                    children: Vec::new(),
                },
            );
            paths_to_process.push(path);
        } else {
            let size = metadata.len();
            *running_total += size;
 
            let live_path_str = path.to_string_lossy().to_string(); // Create an owned String here
            nodes.insert(
                path.clone(),
                FileNode {
                    name,
                    path: "".into(), // Pre súbory cestu neukladáme
                    size,
                    is_dir: false,
                    dir_count: 0,
                    file_count: 1,
                    children: Vec::new(),
                },
            );
            paths_to_process.push(path);

            // Priebežné odosielanie stavu na frontend
            if last_emit.elapsed().as_millis() >= 50 {
                let _ = app_handle.emit(
                    "scan-live-folder",
                    LivePayload {
                        path: live_path_str.to_string(),
                        size: *running_total,
                    },
                );
                *last_emit = Instant::now();
            }
        }
    }

    // 2. Zoradíme cesty od najdlhšej po najkratšiu (od spodu stromu nahor),
    // aby sme mohli správne priradiť deti ich rodičom a sčítať veľkosti.
    paths_to_process.sort_by_key(|p| std::cmp::Reverse(p.as_os_str().len()));

    let root_path_buf = root_path.to_path_buf();
    let mut final_root_node = None;

    for path in paths_to_process {
        if let Some(current_node) = nodes.remove(&path) {
            if path == root_path_buf {
                final_root_node = Some(current_node);
                break;
            }

            if let Some(parent_path) = path.parent() {
                if let Some(parent_node) = nodes.get_mut(parent_path) {
                    parent_node.size += current_node.size;
                    parent_node.dir_count += current_node.dir_count;
                    parent_node.file_count += current_node.file_count;
                    parent_node.children.push(current_node);
                }
            }
        }
    }

    // Na konci ešte raz vyžiadame finálny stav na UI
    let _ = app_handle.emit(
        "scan-live-folder",
        LivePayload {
            path: root_path.to_string_lossy().into_owned(),
            size: *running_total,
        },
    );

    final_root_node
}

/// Normalize all paths in the tree to use forward slashes (matches frontend convention).
/// Zároveň rekonštruuje cesty pre súbory.
fn normalize_paths(node: &mut FileNode) {
    node.path = node.path.replace('\\', "/").into();
    for child in &mut node.children {
        if !child.is_dir {
            // Rekonštrukcia cesty pre súbor
            child.path = format!("{}/{}", node.path, child.name).into_boxed_str();
        }
        normalize_paths(child);
    }
}

#[tauri::command]
fn start_async_scan(path: String, app_handle: AppHandle) {
    // A8: Reset flag zrušenia pred začiatkom nového skenu
    SCAN_CANCELLED.store(false, Ordering::Relaxed);

    thread::spawn(move || {
        let _start_time = Instant::now();
        let target_path = Path::new(&path);
        if !target_path.exists() {
            let _ = app_handle.emit("scan-failed", format!("Cesta neexistuje: {}", path));
            return;
        }
        if !target_path.is_dir() {
            let _ = app_handle.emit("scan-failed", format!("Nie je priečinok: {}", path));
            return;
        }

        let mut last_emit = Instant::now();
        let mut running_total: u64 = 0;

        // Volanie upravenej funkcie scan_directory, ktorá prebehne celý disk lineárne pomocou WalkDir
        if let Some(mut full_tree) =
            scan_directory(target_path, &app_handle, &mut last_emit, &mut running_total)
        {
            // Cesty normalizujeme na forward slashes, aby ich vedel frontend ľahko porovnať
            normalize_paths(&mut full_tree);

            // Kompletný neorezaný strom si uložíme do globálneho stavu.
            // Frontend si neskôr vypýta výrezy cez get_submenu_tree.
            let state = app_handle.state::<ScanState>();
            if let Ok(mut guard) = state.current_tree.lock() {
                *guard = Some(full_tree);
            } else {
                let _ = app_handle.emit(
                    "scan-failed",
                    "Nepodarilo sa uložiť stav skenovania".to_string(),
                );
                return;
            }

            // Na frontend pošleme len signál, že skenovanie úspešne skončilo (bez dát).
            let _ = app_handle
                .emit("scan-finished", ())
                .map_err(|e| eprintln!("Failed to emit scan-finished: {}", e));
        } else {
            // A8: Ak bolo skenovanie zrušené, pošleme scan-failed so správou o zrušení
            if SCAN_CANCELLED.load(Ordering::Relaxed) {
                let _ = app_handle.emit(
                    "scan-failed",
                    "Skenovanie bolo zrušené používateľom".to_string(),
                );
            } else {
                let _ = app_handle.emit("scan-failed", "Nepodarilo sa načítať disk".to_string());
            }
        }
    });
}

// A8: Command pre zrušenie skenovania
#[tauri::command]
fn cancel_scan() {
    SCAN_CANCELLED.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn clear_scan_state(state: tauri::State<'_, ScanState>) -> Result<(), String> {
    if let Ok(mut lock) = state.current_tree.lock() {
        *lock = None; // Vymaže Option a uvoľní FileNode z RAM
    }
    Ok(())
}

#[tauri::command]
fn optimize_webview_memory(window: WebviewWindow) -> Result<(), String> {
    // 100% bezpečné a multiplatformové Tauri v2 API
    // Vymaže cache, históriu vykresľovania a uvoľní pamäť WebView na minimum
    window.clear_all_browsing_data()
        .map_err(|e| e.to_string())?;
    
    Ok(())
}

// ── Dynamic sub-tree access (Local Relative Throttling) ──────────────────────


/// Performs a deep clone of the node with the given `name` and `path` rewritten
/// so the returned subtree looks like a "root" (its children stay untouched).
fn clone_as_subtree_root(node: &FileNode) -> FileNode {
    FileNode {
        name: node.name.clone(), // Box<str> je cheap to clone (Arc-like)
        path: node.path.clone(), // Box<str> je cheap to clone
        size: node.size,
        is_dir: node.is_dir,
        dir_count: node.dir_count,
        file_count: node.file_count,
        children: node.children.clone(),
    }
}

/// Recursively collapses children whose size is below `RELATIVE_THRESHOLD`
/// of the parent's size into a single `__others__` node. This is "Local
/// Relative Throttling" - thresholds are computed relative to the currently
/// focused folder instead of the whole disk.
fn collapse_local(node: &mut FileNode, parent_size: u64) {
    if !node.is_dir || node.children.is_empty() {
        return;
    }

    // Rekurzívne najprv vyčistíme hlbšie úrovne.
    for child in &mut node.children {
        collapse_local(child, node.size.max(1));
    }

    // Prah: RELATIVE_THRESHOLD % z veľkosti aktuálne zobrazovaného priečinka.
    let threshold = (parent_size as f64 * RELATIVE_THRESHOLD) as u64;

    let mut small_items_size = 0;
    let mut small_items_file_count = 0;
    let mut small_items_dir_count = 0;

    let mut large_children: Vec<FileNode> = Vec::new();

    for child in node.children.drain(..) {
        if child.size < threshold && child.name.as_ref() != OTHERS_NAME {
            small_items_size += child.size;
            small_items_file_count += child.file_count;
            small_items_dir_count += child.dir_count;
        } else {
            large_children.push(child);
        }
    }

    if small_items_size > 0 {
        let others_node = FileNode {
            name: OTHERS_NAME.into(),
            path: format!("{}/{}", node.path, OTHERS_NAME).into_boxed_str(),
            size: small_items_size,
            is_dir: false,
            dir_count: small_items_dir_count,
            file_count: small_items_file_count,
            children: Vec::new(),
        };
        large_children.push(others_node);
    }

    // Zoradíme podľa veľkosti zostupne, ale `__others__` vždy na koniec.
    large_children.sort_by(|a, b| {
        if a.name.as_ref() == OTHERS_NAME {
            std::cmp::Ordering::Greater
        } else if b.name.as_ref() == OTHERS_NAME {
            std::cmp::Ordering::Less
        } else {
            b.size.cmp(&a.size)
        }
    });

    node.children = large_children;
}

/// Returns a copy of the subtree rooted at `target_path` with relative
/// throttling applied. If the path is not found, an error is returned.
#[tauri::command]
fn get_submenu_tree(
    state: tauri::State<'_, ScanState>,
    target_path: String,
) -> Result<FileNode, String> {
    // Normalizujeme vstup na forward slashes a case-insensitive (Windows).
    let normalized_target = target_path.replace('\\', "/").trim_end_matches('/').to_string();

    let guard = state
        .current_tree
        .lock()
        .map_err(|_| "Nepodarilo sa získať prístup k stavu skenovania".to_string())?;

    let root = guard
        .as_ref()
        .ok_or_else(|| "Zatiaľ neexistuje žiadny naskenovaný strom".to_string())?;

    // Špeciálny prípad: ak sa pýtame na root stromu.
    let normalized_root = root.path.replace('\\', "/").trim_end_matches('/').to_string();

    let node_opt = if normalized_target.eq_ignore_ascii_case(&normalized_root) {
        Some(root)
    } else {
        // Hľadáme v celom strome (case-insensitive kvôli Windows).
        find_node_by_path_case_insensitive(root, &normalized_target)
    };

    let node = node_opt.ok_or_else(|| {
        format!("Priečinok '{}' sa nenašiel v strome", target_path)
    })?;

    let mut subtree = clone_as_subtree_root(node);
    // Aplikujeme relatívne orezávanie (prah = subtree.size).
    let subtree_size = subtree.size;
    collapse_local(&mut subtree, subtree_size.max(1));

    // Rekurzívne zrekonštruujeme cesty pre súbory v orezanom podstrome
    fn reconstruct_file_paths(node: &mut FileNode) {
        for child in &mut node.children {
            if !child.is_dir {
                let normalized_parent_path = node.path.replace('\\', "/");
                child.path = format!("{}/{}", normalized_parent_path, child.name).into_boxed_str();
            } else {
                reconstruct_file_paths(child);
            }
        }
    }

    reconstruct_file_paths(&mut subtree);

    Ok(subtree)
}

/// Case-insensitive DFS vyhľadávanie uzla podľa cesty (v rámci Windows
/// súborového systému, kde `C:\Users` a `c:\users` sú ekvivalentné).
fn find_node_by_path_case_insensitive<'a>(
    node: &'a FileNode,
    target_path: &str,
) -> Option<&'a FileNode> {
    let path_replaced = node.path.replace('\\', "/");
    let normalized_node_path = path_replaced.trim_end_matches('/');
    if normalized_node_path.eq_ignore_ascii_case(target_path) {
        return Some(node);
    }
    for child in &node.children {
        if let Some(found) = find_node_by_path_case_insensitive(child, target_path) {
            return Some(found);
        }
    }
    None
}

// ── Cross-platform: Show in File Manager ─────────────────────────────────────

#[tauri::command]
fn show_in_file_manager(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("Cesta neexistuje: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        // Konverzia separátorov na Windows formát (\)
        let windows_path = path.replace("/", "\\");

        std::process::Command::new("explorer")
            // Argumenty rozdelíme. Rust ich automaticky správne obalí do úvodzoviek, ak je to potrebné.
            .arg("/select,")
            .arg(windows_path)
            .spawn()
            .map_err(|e| format!("Nepodarilo sa otvoriť Prieskumníka: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Nepodarilo sa otvoriť Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try to open the parent directory with xdg-open
        let dir = if target.is_dir() {
            target.to_path_buf()
        } else {
            target.parent().unwrap_or(target).to_path_buf()
        };
        Command::new("xdg-open")
            .arg(dir.to_string_lossy().as_ref())
            .spawn()
            .map_err(|e| format!("Nepodarilo sa otvoriť súborový manažér: {}", e))?;
    }

    Ok(())
}

// ── Total Commander ──────────────────────────────────────────────────────────

#[tauri::command]
fn show_in_total_commander(path: String) -> Result<(), String> {
    let target_path = Path::new(&path);
    let tc_executable = resolve_tc_path()?;

    #[cfg(target_os = "windows")]
    {
        let windows_path = path.replace("/", "\\");

        let param = if target_path.is_dir() {
            format!("/L={}", windows_path)
        } else {
            let parent = target_path
                .parent()
                .unwrap_or(target_path)
                .to_string_lossy()
                .replace("/", "\\");
            format!("/L={}", parent)
        };

        Command::new(&tc_executable)
            .arg("/O")
            .arg(param)
            .spawn()
            .map_err(|e| {
                format!(
                    "Nepodarilo sa spustiť Total Commander ({}). Chyba: {}",
                    tc_executable, e
                )
            })?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        return Err("Total Commander je dostupný len na Windows.".to_string());
    }

    Ok(())
}

/// Get the currently configured Total Commander path (for frontend display)
#[tauri::command]
fn get_tc_path() -> Result<String, String> {
    let cfg = load_config();
    Ok(cfg.total_commander_path.unwrap_or_default())
}

/// Set the Total Commander path manually (called from frontend dialog)
#[tauri::command]
fn set_tc_path(path: String) -> Result<(), String> {
    if !path.is_empty() && !Path::new(&path).exists() {
        return Err(format!("Súbor neexistuje: {}", path));
    }
    let mut cfg = load_config();
    cfg.total_commander_path = if path.is_empty() { None } else { Some(path) };
    save_config(&cfg)
}

// ── Cross-platform: Show File Properties ─────────────────────────────────────

#[tauri::command]
fn show_file_properties(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("Cesta neexistuje: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{
            SEE_MASK_INVOKEIDLIST, SHELLEXECUTEINFOW, ShellExecuteExW,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOW;

        let windows_path = path.replace("/", "\\");

        let wide_path: Vec<u16> = OsStr::new(&windows_path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let wide_verb: Vec<u16> = OsStr::new("properties")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
            info.fMask = SEE_MASK_INVOKEIDLIST;
            info.lpVerb = wide_verb.as_ptr();
            info.lpFile = wide_path.as_ptr();
            info.nShow = SW_SHOW;

            let result = ShellExecuteExW(&mut info);
            if result == 0 {
                return Err("Nepodarilo sa otvoriť okno vlastností systému Windows.".to_string());
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Use AppleScript to show Get Info window
        let script = format!(
            r#"tell application "Finder" to get information of (POSIX file "{}" as alias)"#,
            path
        );
        Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| format!("Nepodarilo sa zobraziť vlastnosti: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try zenity as a simple properties dialog, fallback to xdg-open parent
        let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        let size = if metadata.is_dir() {
            "Priečinok".to_string()
        } else {
            format!("{} bytes", metadata.len())
        };
        let info = format!(
            "Názov: {}\nCesta: {}\nVeľkosť: {}",
            target.file_name().unwrap_or_default().to_string_lossy(),
            path,
            size
        );
        let _ = Command::new("zenity")
            .args(["--info", "--title=Vlastnosti", &format!("--text={}", info)])
            .spawn();
    }

    Ok(())
}

// ── Cross-platform: Move to Trash ────────────────────────────────────────────

#[tauri::command]
fn move_to_trash(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("Cesta neexistuje: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{
            FO_DELETE, FOF_ALLOWUNDO, FOF_WANTNUKEWARNING, SHFILEOPSTRUCTW, SHFileOperationW,
        };

        let windows_path = path.replace("/", "\\");

        let mut wide_path: Vec<u16> = OsStr::new(&windows_path).encode_wide().collect();
        wide_path.push(0);
        wide_path.push(0);

        unsafe {
            let mut file_op: SHFILEOPSTRUCTW = std::mem::zeroed();
            file_op.wFunc = FO_DELETE;
            file_op.pFrom = wide_path.as_ptr();
            file_op.fFlags = (FOF_ALLOWUNDO | FOF_WANTNUKEWARNING) as u16;

            let result = SHFileOperationW(&mut file_op);

            if file_op.fAnyOperationsAborted != 0 {
                return Err("Operácia bola prerušená používateľom.".to_string());
            }

            if result != 0 {
                return Err(format!(
                    "Systémová chyba Windows pri presúvaní do koša: Kód {}",
                    result
                ));
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"tell application "Finder" to delete (POSIX file "{}" as alias)"#,
            path
        );
        Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("Nepodarilo sa presunúť do koša: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try gio trash first, then trash-cli
        let result = Command::new("gio").args(["trash", &path]).output();

        match result {
            Ok(output) if output.status.success() => {}
            _ => {
                // Fallback to trash-cli
                Command::new("trash-put").arg(&path).output().map_err(|e| {
                    format!(
                        "Nepodarilo sa presunúť do koša (skúste nainštalovať trash-cli): {}",
                        e
                    )
                })?;
            }
        }
    }

    Ok(())
}

// ── Permanent Delete with validation ─────────────────────────────────────────

#[tauri::command]
fn permanent_delete(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("Cesta neexistuje: {}", path));
    }

    // Safety: refuse to delete protected system paths
    if is_protected_path(target) {
        return Err(format!(
            "Odmietnuté: Cesta '{}' je chránená systémová cesta a nemôže byť vymazaná.",
            path
        ));
    }

    // Additional safety: refuse to delete paths that are too short (e.g. "C:\")
    let path_str = path.trim_end_matches(|c| c == '/' || c == '\\');
    if path_str.len() <= 3 {
        return Err(format!(
            "Odmietnuté: Cesta '{}' je príliš krátka a môže byť koreňový disk.",
            path
        ));
    }

    if target.is_dir() {
        std::fs::remove_dir_all(target).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(target).map_err(|e| e.to_string())
    }
}

#[tauri::command]
#[cfg(target_os = "windows")]
fn open_system_utility(utility: String) -> Result<(), String> {
    let command = match utility.as_str() {
        "disk-cleanup" => "cleanmgr.exe",
        "apps-features" => "ms-settings:appsfeatures",
        "storage-settings" => "ms-settings:storagesense",
        "defrag" => "dfrgui.exe",
        _ => return Err(format!("Neznáma utilita: {}", utility)),
    };

    if command.starts_with("ms-settings:") {
        Command::new("cmd")
            .args(&["/c", "start", command])
            .spawn()
            .map_err(|e| format!("Nepodarilo sa spustiť {}: {}", command, e))?;
    } else {
        Command::new(command)
            .spawn()
            .map_err(|e| format!("Nepodarilo sa spustiť {}: {}", command, e))?;
    }

    Ok(())
}

// ─── App Entry Point ─────────────────────────────────────────────────────────

pub fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ScanState::default())
        .invoke_handler(tauri::generate_handler![
            get_disks,
            start_async_scan,
            cancel_scan,
            clear_scan_state,
            optimize_webview_memory,
            get_submenu_tree,
            show_in_file_manager,
            show_in_total_commander,
            show_file_properties,
            move_to_trash,
            permanent_delete,
            get_tc_path,
            set_tc_path,
            #[cfg(target_os = "windows")]
            open_system_utility,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
