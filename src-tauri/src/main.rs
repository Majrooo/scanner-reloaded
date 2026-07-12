#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use std::thread;
use std::time::Instant;
use serde::Serialize;
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
        
        if matches!(disk.kind(), sysinfo::DiskKind::Unknown(_)) && mount_point.contains("BaseImages") {
            continue;
        }
        if disk.total_space() == 0 {
            continue;
        }

        result.push(DiskInfo {
            name: if name.is_empty() { mount_point.clone() } else { name },
            mount_point,
            total_space: disk.total_space(),
            available_space: disk.available_space(),
        });
    }
    result
}

// Rekurzívna funkcia s pridaným throtlovaním pre live ticker a posielaním veľkostí
fn scan_directory(path: &Path, app_handle: &AppHandle, last_emit: &mut Instant) -> Option<FileNode> {
    let metadata = match path.symlink_metadata() {
        Ok(m) => m,
        Err(_) => return None,
    };

    let name = path.file_name()
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
            let _ = app_handle.emit("scan-live-folder", LivePayload {
                path: path_str.clone(),
                size: total_size,
            });
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
            let _ = app_handle.emit("scan-live-folder", LivePayload {
                path: path_str.clone(),
                size,
            });
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_disks, start_async_scan])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}