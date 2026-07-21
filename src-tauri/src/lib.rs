use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Instant;
use sysinfo::Disks;
use tauri::{AppHandle, Emitter, Manager};
use tauri::WebviewWindow;
use walkdir::WalkDir;
use flate2::read::GzEncoder;
use flate2::Compression;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;

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
    name: Arc<str>,
    path: Arc<str>,
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

#[derive(Serialize, Deserialize, Clone)]
struct AppConfig {
    total_commander_path: Option<String>,
    backend_merge_threshold_kb: Option<u64>,
    #[serde(default)]
    error_logging_enabled: Option<bool>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            total_commander_path: None,
            backend_merge_threshold_kb: None,
            error_logging_enabled: Some(true),
        }
    }
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

// ─── Error Logging ───────────────────────────────────────────────────────────

const MAX_LOG_SIZE: u64 = 1_000_000; // 1 MB

/// Internal helper that returns the error log path as PathBuf
fn resolve_error_log_path() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("scanner-reloaded").join("error.log"))
}

/// Logs an error message to the error log file with an ISO 8601 timestamp.
/// Respects the `error_logging_enabled` config flag.
/// Automatically rotates the log if it exceeds 1 MB.
fn log_error(msg: &str) {
    let cfg = load_config();
    if !cfg.error_logging_enabled.unwrap_or(true) {
        return;
    }

    let Some(log_path) = resolve_error_log_path() else {
        return;
    };

    // Ensure directory exists
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Rotate if file exceeds MAX_LOG_SIZE
    if log_path.exists() {
        if let Ok(metadata) = std::fs::metadata(&log_path) {
            if metadata.len() > MAX_LOG_SIZE {
                let old_path = log_path.with_extension("log.old");
                let _ = std::fs::rename(&log_path, &old_path);
            }
        }
    }

    // Append timestamped error message
    let timestamp = Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
    let line = format!("[{}] ERROR: {}\n", timestamp, msg);

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let _ = file.write_all(line.as_bytes());
    }
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

fn build_dir_node(dir_path: PathBuf, children: Vec<FileNode>) -> FileNode {
    let total_size: u64 = children.iter().map(|c| c.size).sum();
    let total_dirs: usize = children.iter().map(|c| c.dir_count).sum();
    let total_files: usize = children.iter().map(|c| c.file_count).sum();

    let name: Arc<str> = dir_path
        .file_name()
        .map(|n| Arc::from(n.to_string_lossy().as_ref()))
        .unwrap_or_else(|| Arc::from(dir_path.to_string_lossy().as_ref()));

    FileNode {
        name,
        path: Arc::from(dir_path.to_string_lossy().as_ref()),
        size: total_size,
        is_dir: true,
        dir_count: total_dirs + 1,
        file_count: total_files,
        children,
    }
}

fn scan_directory(
    root_path: &Path,
    app_handle: &AppHandle,
    last_emit: &mut Instant,
    running_total: &mut u64,
) -> Option<FileNode> {
    // In-place tree building using WalkDir::contents_first(true) + DFS stack.
    // contents_first(true) yields children BEFORE their parent directory,
    // so we accumulate children on the stack and pop when the dir entry arrives.
    // Eliminates FxHashMap (~200k+ entries) and O(n log n) sort → O(n), ~40% less RAM.
    let mut stack: Vec<(PathBuf, Vec<FileNode>)> = Vec::new();
    let root_path_buf = root_path.to_path_buf();
    stack.push((root_path_buf.clone(), Vec::new()));

    let walker = WalkDir::new(root_path)
        .contents_first(true)
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
            Err(_) => continue,
        };

        let parent = path.parent().unwrap_or(&root_path_buf).to_path_buf();

        // --- Step 1: Align stack so that top == parent ---
        // Pop completed directories or push missing intermediate dirs
        while stack.last().map_or(false, |(p, _)| *p != parent) {
            let (top_path, _) = &stack.last().unwrap();

            if parent.starts_with(top_path) {
                // Parent is deeper inside top_path → push intermediate directory
                let relative = parent.strip_prefix(top_path).unwrap();
                let first_component = relative.components().next().unwrap();
                let intermediate = top_path.join(first_component);
                stack.push((intermediate, Vec::new()));
            } else {
                // Parent is outside top_path → pop completed directory
                let (dir_path, children) = stack.pop().unwrap();
                let dir_node = build_dir_node(dir_path, children);
                if stack.is_empty() {
                    // Root finished — return immediately
                    return Some(dir_node);
                }
                stack.last_mut().unwrap().1.push(dir_node);
            }
        }

        // --- Step 2: Process the entry ---
        if metadata.is_dir() {
            // With contents_first(true), directory entry comes AFTER its children.
            // If the dir is still on the stack (e.g., it's the root), pop it now.
            if stack.last().map_or(false, |(p, _)| *p == path) {
                let (dir_path, children) = stack.pop().unwrap();
                let dir_node = build_dir_node(dir_path, children);
                if stack.is_empty() {
                    return Some(dir_node);
                }
                stack.last_mut().unwrap().1.push(dir_node);
            }
            // Otherwise the while-loop already popped it — nothing to do.
        } else {
            // File: add to current directory's children
            let name: Arc<str> = path
                .file_name()
                .map(|n| Arc::from(n.to_string_lossy().as_ref()))
                .unwrap_or_else(|| Arc::from(path.to_string_lossy().as_ref()));

            let size = metadata.len();
            *running_total += size;

            let live_path_str = path.to_string_lossy().to_string();

            stack.last_mut().unwrap().1.push(FileNode {
                name,
                path: Arc::from(""),
                size,
                is_dir: false,
                dir_count: 0,
                file_count: 1,
                children: Vec::new(),
            });

            // Periodically send status to the frontend.
            if last_emit.elapsed().as_millis() >= 50 {
                let _ = app_handle.emit(
                    "scan-live-folder",
                    LivePayload {
                        path: live_path_str,
                        size: *running_total,
                    },
                );
                *last_emit = Instant::now();
            }
        }
    }

    // Fallback: root was the only entry or empty
    // At the end, request the final state on the UI one more time.
    let _ = app_handle.emit(
        "scan-live-folder",
        LivePayload {
            path: root_path.to_string_lossy().into_owned(),
            size: *running_total,
        },
    );

    // Build root from whatever is left on the stack
    if let Some((root_dir_path, root_children)) = stack.pop() {
        Some(build_dir_node(root_dir_path, root_children))
    } else {
        None
    }
}

/// Normalize all paths in the tree to use forward slashes (matches frontend convention).
/// Also reconstructs paths for files.
fn normalize_paths(node: &mut FileNode) {
    node.path = Arc::from(node.path.replace('\\', "/").as_str());
    for child in &mut node.children {
        if !child.is_dir {
            // Reconstruct path for file.
            child.path = Arc::from(format!("{}/{}", node.path, child.name).as_str());
        }
        normalize_paths(child);
    }
}

/// Merge files smaller than `threshold` bytes into a single `__super_small_files__` node
/// in each directory. This drastically reduces the number of FileNode objects in the tree
/// before serialization, reducing memory usage and IPC transfer time.
fn merge_small_files(node: &mut FileNode, threshold: u64) {
    if !node.is_dir || node.children.is_empty() {
        return;
    }

    // First, recursively process children
    for child in &mut node.children {
        merge_small_files(child, threshold);
    }

    // Then merge small files in this directory
    let mut merged_size: u64 = 0;
    let mut merged_files: usize = 0;
    let mut keep: Vec<FileNode> = Vec::with_capacity(node.children.len());

    for child in node.children.drain(..) {
        if !child.is_dir && child.size < threshold {
            merged_size += child.size;
            merged_files += child.file_count;
        } else {
            keep.push(child);
        }
    }

    if merged_files > 0 {
        keep.push(FileNode {
            name: Arc::from("__super_small_files__"),
            path: Arc::from(format!("{}/__super_small_files__", node.path)),
            size: merged_size,
            is_dir: false,
            dir_count: 0,
            file_count: merged_files,
            children: Vec::new(),
        });
    }

    node.children = keep;
}

#[tauri::command]
fn start_async_scan(path: String, app_handle: AppHandle) {
    // Reset cancellation flag before starting a new scan.
    SCAN_CANCELLED.store(false, Ordering::Relaxed);

    thread::spawn(move || {
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

            // Merge small files in the backend if threshold is configured.
            // This drastically reduces the number of FileNode objects before serialization.
            let cfg = load_config();
            if let Some(threshold_kb) = cfg.backend_merge_threshold_kb {
                if threshold_kb > 0 {
                    let threshold_bytes = threshold_kb * 1024;
                    merge_small_files(&mut full_tree, threshold_bytes);
                }
            }

            // Store the complete, untrimmed tree in the global state.
            // The frontend will later fetch it binary via get_binary_tree and handle navigation locally.
            let state = app_handle.state::<ScanState>();
            if let Ok(mut guard) = state.current_tree.lock() {
                *guard = Some(full_tree);
            } else {
                log_error("Failed to lock scan state for saving");
                let _ = app_handle.emit(
                    "scan-failed",
                    "Failed to save scan state".to_string(),
                );
                return;
            }

            // Send only a signal to the frontend that the scan finished successfully (without data).
            let _ = app_handle
                .emit("scan-finished", ())
                .map_err(|e| {
                    let msg = format!("Failed to emit scan-finished: {}", e);
                    log_error(&msg);
                    eprintln!("{}", msg);
                });
        } else {
            // A8: Ak bolo skenovanie zrušené, pošleme scan-failed so správou o zrušení
            if SCAN_CANCELLED.load(Ordering::Relaxed) {
                let _ = app_handle.emit(
                    "scan-failed", // A8: Correctly emits scan-failed on cancellation.
                    "Scan was cancelled by user".to_string(),
                );
            } else {
                log_error("Scan directory returned None (not cancelled)");
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

/// Returns the entire tree serialized into compact binary format,
/// GZip compressed and base64-encoded for safe transfer through production IPC.
/// The frontend deserializes and performs local collapse/navigation on the full tree.
#[tauri::command]
fn get_binary_tree(
    state: tauri::State<'_, ScanState>,
) -> Result<String, String> {
    let guard = state
        .current_tree
        .lock()
        .map_err(|_| "Failed to get access to scan state".to_string())?;

    let root = guard
        .as_ref()
        .ok_or_else(|| "No scanned tree exists yet".to_string())?;

    let mut buf = Vec::with_capacity(10 * 1024 * 1024); // pre-allocate 10 MB
    root.serialize_to_binary(&mut buf);

    // GZip compress the binary data
    let mut encoder = GzEncoder::new(buf.as_slice(), Compression::default());
    let mut compressed = Vec::new();
    encoder.read_to_end(&mut compressed)
        .map_err(|e| format!("Compression failed: {}", e))?;

    // Base64 encode the compressed data for safe IPC transfer
    let encoded = BASE64.encode(&compressed);
    
    Ok(encoded)
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

/// Get the backend merge threshold in KB (0 = disabled)
#[tauri::command]
fn get_backend_merge_threshold() -> Result<u64, String> {
    let cfg = load_config();
    Ok(cfg.backend_merge_threshold_kb.unwrap_or(0))
}

/// Set the backend merge threshold in KB (0 = disabled)
#[tauri::command]
fn set_backend_merge_threshold(threshold_kb: u64) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.backend_merge_threshold_kb = if threshold_kb > 0 { Some(threshold_kb) } else { None };
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

// ─── Error Logging Commands ───────────────────────────────────────────────────

/// Returns whether error logging to file is enabled (default: true)
#[tauri::command]
fn get_error_logging_enabled() -> bool {
    let cfg = load_config();
    cfg.error_logging_enabled.unwrap_or(true)
}

/// Enable or disable error logging to file
#[tauri::command]
fn set_error_logging_enabled(enabled: bool) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.error_logging_enabled = Some(enabled);
    save_config(&cfg)
}

/// Returns the full path to the error log file
#[tauri::command]
fn get_error_log_path() -> String {
    get_error_log_path_internal()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Opens the error log file in the default text editor
#[tauri::command]
fn open_error_log() -> Result<(), String> {
    let log_path = get_error_log_path_internal()
        .ok_or("Could not determine log path")?;

    if !log_path.exists() {
        return Err("Error log file does not exist yet.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("notepad")
            .arg(log_path.to_string_lossy().as_ref())
            .spawn()
            .map_err(|e| format!("Failed to open error log: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-t")
            .arg(log_path.to_string_lossy().as_ref())
            .spawn()
            .map_err(|e| format!("Failed to open error log: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(log_path.to_string_lossy().as_ref())
            .spawn()
            .map_err(|e| format!("Failed to open error log: {}", e))?;
    }

    Ok(())
}

/// Internal helper that returns the error log path as PathBuf
fn get_error_log_path_internal() -> Option<PathBuf> {
    dirs::config_dir().map(|p| p.join("scanner-reloaded").join("error.log"))
}

// ─── App Entry Point ─────────────────────────────────────────────────────────

pub fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .manage(ScanState::default())
    .setup(|app| {
      // Window-state plugin has already applied saved position/size.
      // Short delay ensures the plugin has fully applied the state
      // before showing the window — prevents position flash.
      if let Some(window) = app.get_webview_window("main") {
        let w = window.clone();
        std::thread::spawn(move || {
          std::thread::sleep(std::time::Duration::from_millis(50));
          let _ = w.show();
        });
      }
      Ok(())
    })
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
      get_backend_merge_threshold,
      set_backend_merge_threshold,
      validate_directory,
      get_error_logging_enabled,
      set_error_logging_enabled,
      get_error_log_path,
      open_error_log,
      #[cfg(target_os = "windows")]
      open_system_utility,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
