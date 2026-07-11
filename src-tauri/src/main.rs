#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use std::thread;
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

// Rozšírená štruktúra o počet súborov a zložiek
#[derive(Serialize, Clone)]
struct ProgressPayload {
    name: String,
    path: String,
    size: u64,
    is_dir: bool,
    dir_count: usize,
    file_count: usize,
    parent_path: Option<String>,
}

#[tauri::command]
fn get_disks() -> Vec<DiskInfo> {
    let disks = Disks::new_with_refreshed_list();
    let mut result = Vec::new();
    for disk in &disks {
        let name = disk.name().to_string_lossy().into_owned();
        let mount_point = disk.mount_point().to_string_lossy().into_owned();
        result.push(DiskInfo {
            name: if name.is_empty() { mount_point.clone() } else { name },
            mount_point,
            total_space: disk.total_space(),
            available_space: disk.available_space(),
        });
    }
    result
}

// Funkcia bežiaca na pozadí, posiela udalosti cez app_handle
fn scan_and_emit(path: &Path, app_handle: &AppHandle, parent_path: Option<String>) -> (u64, usize, usize) {
    let mut total_size = 0;
    let mut dir_count = 0;
    let mut file_count = 0;

    let metadata = match path.symlink_metadata() {
        Ok(m) => m,
        Err(_) => return (0, 0, 0),
    };

    let name = path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let path_str = path.to_string_lossy().into_owned();

    if metadata.is_dir() {
        // OPRAVA: Explicitne skontrolujeme, či aktuálna cesta nie je symbolický odkaz.
        // Ak je, nebudeme rekurzívne skenovať jej obsah, aby sme predišli slučkám a duplicitnému počítaniu.
        if metadata.file_type().is_symlink() {
            return (0, 0, 0); // Vrátime nulu, pretože veľkosť odkazov nezapočítavame.
        }

        dir_count = 1; // Samotný aktuálny priečinok je jeden priečinok
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                let child_path = entry.path();
                let child_meta = match child_path.symlink_metadata() {
                    Ok(m) => m,
                    Err(_) => continue, // Preskočíme súbory/priečinky, ku ktorým nemáme prístup
                };

                if child_meta.is_dir() {
                    let (c_size, c_dirs, c_files) = scan_and_emit(&child_path, app_handle, Some(path_str.clone()));
                    total_size += c_size;
                    dir_count += c_dirs;
                    file_count += c_files;
                } else {
                    file_count += 1;
                    let c_size = child_meta.len();
                    total_size += c_size;

                    // POSIELAME INFO AJ O JEDNOTLIVÝCH SÚBOROCH
                    let _ = app_handle.emit("scan-progress", ProgressPayload {
                        name: child_path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                        path: child_path.to_string_lossy().into_owned(),
                        size: c_size,
                        is_dir: false,
                        dir_count: 0,
                        file_count: 1,
                        parent_path: Some(path_str.clone()),
                    });
                }
            }
        }

        let _ = app_handle.emit("scan-progress", ProgressPayload {
            name,
            path: path_str,
            size: total_size,
            is_dir: true,
            dir_count,
            file_count,
            parent_path,
        });
    }

    (total_size, dir_count, file_count)
}

// Asynchrónny príkaz, ktorý len naštartuje vlákno a hneď vráti riadenie frontend-u
#[tauri::command]
fn start_async_scan(path: String, app_handle: AppHandle) {
    thread::spawn(move || {
        let target_path = Path::new(&path);
        if target_path.exists() {
            scan_and_emit(target_path, &app_handle, None);
        }
        // Na konci oznámime frontendu, že sme hotoví
        let _ = app_handle.emit("scan-finished", ());
    });
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_disks, start_async_scan])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}