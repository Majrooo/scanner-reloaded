// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::Instant;
use sysinfo::Disks;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct DiskInfo {
    name: String,
    mount_point: String,
    total_space: u64,
    available_space: u64,
}

#[derive(Serialize, Clone)]
struct FileNode {
    name: String,
    path: String,
    size: u64,
    is_dir: bool,
    dir_count: usize,
    file_count: usize,
    children: Vec<FileNode>,
}

// PRIDANÉ: Nová štruktúra pre live informácie pre frontend
#[derive(Serialize, Clone)]
struct LivePayload {
    path: String,
    size: u64,
}

#[tauri::command]
fn get_disks() -> Vec<DiskInfo> {
    let disks = Disks::new_with_refreshed_list();
    let mut result = Vec::new();
    for disk in &disks {
        let name = disk.name().to_string_lossy().into_owned();
        let mount_point = disk.mount_point().to_string_lossy().into_owned();

        if matches!(disk.kind(), sysinfo::DiskKind::Unknown(_))
            && mount_point.contains("BaseImages")
        {
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
        });
    }
    result
}

// Rekurzívna funkcia s pridaným throtlovaním pre live ticker a posielaním veľkostí
fn scan_directory(
    path: &Path,
    app_handle: &AppHandle,
    last_emit: &mut Instant,
) -> Option<FileNode> {
    let metadata = match path.symlink_metadata() {
        Ok(m) => m,
        Err(_) => return None,
    };

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let path_str = path.to_string_lossy().into_owned();

    if metadata.is_dir() {
        if metadata.file_type().is_symlink() {
            return None;
        }

        let mut children = Vec::new();
        let mut total_size = 0;
        let mut dir_count = 1;
        let mut file_count = 0;

        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                if let Some(child_node) = scan_directory(&entry.path(), app_handle, last_emit) {
                    total_size += child_node.size;
                    dir_count += child_node.dir_count;
                    file_count += child_node.file_count;
                    children.push(child_node);
                }
            }
        }

        // UPRAVENÉ: Správu na frontend pustíme maximálne raz za 50 ms, ale posielame už aj vypočítanú veľkosť (total_size)
        if last_emit.elapsed().as_millis() >= 50 {
            let _ = app_handle.emit(
                "scan-live-folder",
                LivePayload {
                    path: path_str.clone(),
                    size: total_size,
                },
            );
            *last_emit = Instant::now(); // Resetujeme časovač
        }

        Some(FileNode {
            name,
            path: path_str,
            size: total_size,
            is_dir: true,
            dir_count,
            file_count,
            children,
        })
    } else {
        let size = metadata.len();

        // Aby sme posielali dáta priebežne aj pri veľkých súboroch, ak narazíme na samostatný súbor po limite 50ms:
        if last_emit.elapsed().as_millis() >= 50 {
            let _ = app_handle.emit(
                "scan-live-folder",
                LivePayload {
                    path: path_str.clone(),
                    size,
                },
            );
            *last_emit = Instant::now();
        }

        Some(FileNode {
            name,
            path: path_str,
            size,
            is_dir: false,
            dir_count: 0,
            file_count: 1,
            children: Vec::new(),
        })
    }
}

#[tauri::command]
fn start_async_scan(path: String, app_handle: AppHandle) {
    thread::spawn(move || {
        let target_path = Path::new(&path);
        if target_path.exists() {
            // Inicializujeme časovač pre prvé odoslanie
            let mut last_emit = Instant::now();

            if let Some(full_tree) = scan_directory(target_path, &app_handle, &mut last_emit) {
                let _ = app_handle.emit("scan-finished-with-data", full_tree);
            } else {
                let _ = app_handle.emit("scan-failed", "Nepodarilo sa načítať disk".to_string());
            }
        }
    });
}

#[tauri::command]
fn show_in_file_manager(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Windows Explorer vyžaduje spätné lomky
        let windows_path = path.replace("/", "\\");

        // Správne volanie s prepínačom /select, ktorý súbor/priečinok priamo označí
        Command::new("explorer")
            .arg(format!("/select,{}", windows_path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_in_total_commander(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Konverzia na systémové spätné lomky
        let target_path = Path::new(&path);
        let windows_path = path.replace("/", "\\");

        // Overenie najčastejších ciest inštalácie Total Commandera na Windows
        let tc_executable = if Path::new("C:\\totalcmd\\TOTALCMD64.EXE").exists() {
            "C:\\totalcmd\\TOTALCMD64.EXE"
        } else if Path::new("C:\\totalcmd\\TOTALCMD.EXE").exists() {
            "C:\\totalcmd\\TOTALCMD.EXE"
        } else if Path::new("C:\\Program Files\\totalcmd\\TOTALCMD64.EXE").exists() {
            "C:\\Program Files\\totalcmd\\TOTALCMD64.EXE"
        } else if Path::new("d:\\WINA\\SW Dir&File\\totalcmd\\TOTALCMD64.EXE").exists() {
            "d:\\WINA\\SW Dir&File\\totalcmd\\TOTALCMD64.EXE"
        } else {
            "totalcmd.exe" // Pokus o spustenie z PATH, ak existuje
        };

        // Prepínač /O zabezpečí otvorenie v už existujúcom okne TC (ak beží)
        // /L= nastaví cestu do ľavého panelu
        let param = if target_path.is_dir() {
            format!("/O /L={}", windows_path)
        } else {
            // Ak ide o súbor, otvoríme jeho nadradený priečinok
            let parent = target_path
                .parent()
                .unwrap_or(target_path)
                .to_string_lossy()
                .replace("/", "\\");
            format!("/O /L={}", parent)
        };

        Command::new(tc_executable)
            .args(param.split_whitespace())
            .spawn()
            .map_err(|e| {
                format!(
                    "Nepodarilo sa spustiť Total Commander ({}). Chyba: {}",
                    tc_executable, e
                )
            })?;
    }
    Ok(())
}

#[tauri::command]
fn show_file_properties(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{
            SEE_MASK_INVOKEIDLIST, SHELLEXECUTEINFOW, ShellExecuteExW,
        };
        // OPRAVENÉ: SW_SHOW sa nachádza v WindowsAndMessaging
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOW;

        // 1. Windows vyžaduje spätné lomky \
        let windows_path = path.replace("/", "\\");

        // 2. Skonvertujeme reťazec do formátu širokých znakov (LPCWSTR / UTF-16) pre WinAPI
        let wide_path: Vec<u16> = OsStr::new(&windows_path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let wide_verb: Vec<u16> = OsStr::new("properties")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        // 3. Inicializácia štruktúry pre vykonanie príkazu na OS
        unsafe {
            let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
            // OPRAVENÉ: size_of namiesto sizeOf
            info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
            info.fMask = SEE_MASK_INVOKEIDLIST;
            info.lpVerb = wide_verb.as_ptr();
            info.lpFile = wide_path.as_ptr();
            info.nShow = SW_SHOW;

            // Spustenie
            let result = ShellExecuteExW(&mut info);
            if result == 0 {
                return Err("Nepodarilo sa otvoriť okno vlastností systému Windows.".to_string());
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn move_to_trash(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{
            FO_DELETE, FOF_ALLOWUNDO, FOF_WANTNUKEWARNING, SHFILEOPSTRUCTW, SHFileOperationW,
        };

        // 1. Windows vyžaduje spätné lomky \
        let windows_path = path.replace("/", "\\");

        // 2. DÔLEŽITÉ: SHFileOperationW vyžaduje, aby bola cesta zakončená DVOMA nulovými znakmi (\0\0)
        let mut wide_path: Vec<u16> = OsStr::new(&windows_path).encode_wide().collect();
        wide_path.push(0); // Prvá nula (koniec reťazca)
        wide_path.push(0); // Druhá nula (označuje koniec zoznamu ciest pre funkciu)

        unsafe {
            let mut file_op: SHFILEOPSTRUCTW = std::mem::zeroed();
            file_op.wFunc = FO_DELETE; // Akcia: Mazanie
            file_op.pFrom = wide_path.as_ptr(); // Cesta k súboru/priečinku

            // FOF_ALLOWUNDO -> Presunie súbor do koša namiesto trvalého vymazania
            // FOF_WANTNUKEWARNING -> Ak je priečinok príliš veľký pre kôš, Windows zobrazí varovanie o trvalom zmazaní
            file_op.fFlags = (FOF_ALLOWUNDO | FOF_WANTNUKEWARNING) as u16;

            let result = SHFileOperationW(&mut file_op);

            // Ak používateľ stlačil tlačidlo "Zrušiť" (Cancel) v systéme Windows
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
    Ok(())
}

#[tauri::command]
fn permanent_delete(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if target.is_dir() {
        std::fs::remove_dir_all(target).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(target).map_err(|e| e.to_string())
    }
}

// Nezabudnite tieto funkcie pridať do .invoke_handler(tauri::generate_handler![...]) vo vašom tauri::Builderi

pub fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_disks,
            start_async_scan,
            show_in_file_manager,
            show_in_total_commander,
            show_file_properties,
            move_to_trash,
            permanent_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
