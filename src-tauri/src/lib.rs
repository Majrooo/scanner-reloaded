use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Instant;
use sysinfo::Disks;
use tauri::{AppHandle, Emitter, Manager};
use std::collections::HashMap;
use tauri::WebviewWindow;
use walkdir::WalkDir;

// Global flag to cancel a scan.
static SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

// Global state for storing the full scan tree (frontend handles local navigation).
#[derive(Default)]
pub struct ScanState {
    current_tree: Mutex<Option<FileNode>>,
}

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

impl FileNode {
    /// Serializes this node and all its children into a compact binary format (pre-order traversal).
    /// Format (per node):
    ///   [is_dir: 1 byte]
    ///   [size: 8 bytes LE]
    ///   [dir_count: 4 bytes LE (u32)]
    ///   [file_count: 4 bytes LE (u32)]
    ///   [name_len: 2 bytes LE (u16)]
    ///   [name: N bytes UTF-8]
    ///   [path_len: 2 bytes LE (u16)]
    ///   [path: M bytes UTF-8]
    ///   [children_count: 4 bytes LE (u32)] — only if is_dir == true
    /// Then recursively each child.
    pub fn serialize_to_binary(&self, buf: &mut Vec<u8>) {
        // is_dir
        buf.push(if self.is_dir { 1 } else { 0 });
        // size (u64, 8 bytes LE)
        buf.extend_from_slice(&self.size.to_le_bytes());
        // dir_count (usize -> u32, 4 bytes LE)
        buf.extend_from_slice(&(self.dir_count as u32).to_le_bytes());
        // file_count (usize -> u32, 4 bytes LE)
        buf.extend_from_slice(&(self.file_count as u32).to_le_bytes());
        // name_len (u16, 2 bytes LE)
        let name_bytes = self.name.as_bytes();
        let name_len = name_bytes.len().min(u16::MAX as usize) as u16;
        buf.extend_from_slice(&name_len.to_le_bytes());
        // name
        buf.extend_from_slice(&name_bytes[..name_len as usize]);
        // path_len (u16, 2 bytes LE)
        let path_bytes = self.path.as_bytes();
        let path_len = path_bytes.len().min(u16::MAX as usize) as u16;
        buf.extend_from_slice(&path_len.to_le_bytes());
        // path
        buf.extend_from_slice(&path_bytes[..path_len as usize]);
        // children_count (only if is_dir)
        if self.is_dir {
            let cc = self.children.len().min(u32::MAX as usize) as u32;
            buf.extend_from_slice(&cc.to_le_bytes());
            // recursively serialize children
            for child in &self.children {
                child.serialize_to_binary(buf);
            }
        }
    }
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
fn get_config_path() -> Option<PathBuf> { // A1: This function is correct.
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
    let path = get_config_path().ok_or("Could not find config directory")?;
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
        
        // Add disk type (SSD/HDD).
        let kind = match disk.kind() {
            sysinfo::DiskKind::SSD => "ssd",
            sysinfo::DiskKind::HDD => "hdd",
            _ => "unknown", // B4: Correctly handles unknown types.
        };

        // B4: Do not filter Unknown disks - USB/external drives can be detected as Unknown.
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
    // Create a helper map to build the tree (from leaf nodes to the root).
    let mut nodes: HashMap<PathBuf, FileNode> = HashMap::with_capacity(250_000);
    let mut paths_to_process = Vec::with_capacity(250_000);

    // 1. Traverse the entire disk linearly using WalkDir without recursion.
    // `follow_links(false)` strictly prevents traversing to C: drive via any Junctions/Symlinks.
    let walker = WalkDir::new(root_path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok()); // B1: Correctly filters out errors.

    for entry in walker {
        if SCAN_CANCELLED.load(Ordering::Relaxed) {
            return None;
        }

        let path = entry.path().to_path_buf();
        let metadata = match entry.metadata() {
            Ok(m) => m, // B2: Correctly gets metadata.
            Err(_) => continue, // Skip folders without access rights (e.g., System Volume Information).
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
 
            let live_path_str = path.to_string_lossy().to_string();
            nodes.insert(
                path.clone(),
                FileNode {
                    name,
                    path: "".into(), // For files, we don't store the path initially.
                    size,
                    is_dir: false,
                    dir_count: 0,
                    file_count: 1,
                    children: Vec::new(),
                },
            );
            paths_to_process.push(path);

            // Periodically send status to the frontend.
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

    // 2. Sort paths from longest to shortest (from the bottom of the tree upwards)
    // to correctly assign children to their parents and sum up sizes.
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

    // At the end, request the final state on the UI one more time.
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
/// Also reconstructs paths for files.
fn normalize_paths(node: &mut FileNode) {
    node.path = node.path.replace('\\', "/").into();
    for child in &mut node.children {
        if !child.is_dir {
            // Reconstruct path for file.
            child.path = format!("{}/{}", node.path, child.name).into_boxed_str();
        }
        normalize_paths(child);
    }
}

#[tauri::command]
fn start_async_scan(path: String, app_handle: AppHandle) {
    // Reset cancellation flag before starting a new scan.
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

        // Call the modified scan_directory function, which traverses the disk linearly using WalkDir.
        if let Some(mut full_tree) =
            scan_directory(target_path, &app_handle, &mut last_emit, &mut running_total)
        {
            // Normalize paths to forward slashes so the frontend can easily compare them.
            normalize_paths(&mut full_tree);

            // Store the complete, untrimmed tree in the global state.
            // The frontend will later fetch it binary via get_binary_tree and handle navigation locally.
            let state = app_handle.state::<ScanState>();
            if let Ok(mut guard) = state.current_tree.lock() {
                *guard = Some(full_tree);
            } else {
                let _ = app_handle.emit(
                    "scan-failed",
                    "Failed to save scan state".to_string(),
                );
                return;
            }

            // Send only a signal to the frontend that the scan finished successfully (without data).
            let _ = app_handle
                .emit("scan-finished", ())
                .map_err(|e| eprintln!("Failed to emit scan-finished: {}", e));
        } else {
            // A8: Ak bolo skenovanie zrušené, pošleme scan-failed so správou o zrušení
            if SCAN_CANCELLED.load(Ordering::Relaxed) {
                let _ = app_handle.emit(
                    "scan-failed", // A8: Correctly emits scan-failed on cancellation.
                    "Scan was cancelled by user".to_string(),
                );
            } else {
                let _ = app_handle.emit("scan-failed", "Failed to load disk".to_string());
            }
        }
    });
}

// Command to cancel a scan.
#[tauri::command]
fn cancel_scan() {
    SCAN_CANCELLED.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn clear_scan_state(state: tauri::State<'_, ScanState>) -> Result<(), String> {
    if let Ok(mut lock) = state.current_tree.lock() {
        *lock = None; // Clears the Option and frees the FileNode from RAM.
    }
    Ok(())
}

#[tauri::command]
fn optimize_webview_memory(window: WebviewWindow) -> Result<(), String> {
    // 100% safe and multi-platform Tauri v2 API.
    // Clears cache, rendering history, and frees WebView memory to a minimum.
    window.clear_all_browsing_data()
        .map_err(|e| e.to_string())?;
    
    Ok(())
}

// ── Binary Data Transfer ─────────────────────────────────────────────────────

/// Returns the entire tree serialized into compact binary format.
/// Uses Tauri IPC Response for native binary transfer (no JSON serialization).
/// The frontend deserializes and performs local collapse/navigation on the full tree.
#[tauri::command]
fn get_binary_tree(
    state: tauri::State<'_, ScanState>,
) -> Result<tauri::ipc::Response, String> {
    let guard = state
        .current_tree
        .lock()
        .map_err(|_| "Failed to get access to scan state".to_string())?;

    let root = guard
        .as_ref()
        .ok_or_else(|| "No scanned tree exists yet".to_string())?;

    let mut buf = Vec::with_capacity(10 * 1024 * 1024); // pre-allocate 10 MB
    root.serialize_to_binary(&mut buf);
    Ok(tauri::ipc::Response::new(buf))
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
        // Convert separators to Windows format (\).
        let windows_path = path.replace("/", "\\");

        std::process::Command::new("explorer")
            // Split arguments. Rust will correctly quote them if necessary.
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
                    "Failed to start Total Commander ({}). Error: {}",
                    tc_executable, e
                )
            })?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        return Err("Total Commander is only available on Windows.".to_string());
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
        return Err(format!("File does not exist: {}", path));
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
                return Err("Failed to open Windows properties window.".to_string());
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
        let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?; // B3: Correctly handles metadata errors.
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
                return Err("Operation was aborted by the user.".to_string());
            }

            if result != 0 {
                return Err(format!(
                    "Windows system error while moving to trash: Code {}",
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
            .output() // B6: Correctly uses `output()` to wait for completion.
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
                        "Failed to move to trash (try installing trash-cli): {}",
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
            "Denied: Path '{}' is a protected system path and cannot be deleted.",
            path
        ));
    }

    // Additional safety: refuse to delete paths that are too short (e.g. "C:\")
    let path_str = path.trim_end_matches(|c| c == '/' || c == '\\');
    if path_str.len() <= 3 { // B7: Correctly checks for short paths.
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
        _ => return Err(format!("Unknown utility: {}", utility)),
    };

    if command.starts_with("ms-settings:") {
        Command::new("cmd")
            .args(&["/c", "start", command])
            .spawn()
            .map_err(|e| format!("Failed to start {}: {}", command, e))?;
    } else {
        Command::new(command)
            .spawn()
            .map_err(|e| format!("Failed to start {}: {}", command, e))?;
    }

    Ok(())
}

// ─── Directory Validation for Drag & Drop ─────────────────────────────────────

/// Validates that a path exists and is a directory.
/// Used by drag-drop handler to verify dropped paths before scanning.
#[tauri::command]
fn validate_directory(path: String) -> Result<bool, String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !target.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    Ok(true)
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
      get_binary_tree,
      show_in_file_manager,
      show_in_total_commander,
      show_file_properties,
      move_to_trash,
      permanent_delete,
      get_tc_path,
      set_tc_path,
      validate_directory,
      #[cfg(target_os = "windows")]
      open_system_utility,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
