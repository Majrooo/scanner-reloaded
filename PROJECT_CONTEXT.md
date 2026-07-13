# Project Context: Scanner Reloaded

## Project Name & Main Purpose

**Scanner Reloaded** is a desktop application designed to help users manage their disk space effectively. Its main purpose is to analyze disk usage, visualize file and folder sizes in an interactive sunburst chart, and provide tools for managing storage. Users can identify large files and directories, and then perform actions such as deleting them, moving them to trash, or opening them in a file manager, ultimately aiming to free up disk space and better understand their storage consumption.

## Tech Stack

*   **Languages**:
    *   **Backend**: Rust
    *   **Frontend**: JavaScript, HTML, CSS
*   **Frameworks/Libraries**:
    *   **Application Framework**: Tauri (for building cross-platform desktop applications)
    *   **Frontend Visualization**: D3.js (for creating interactive sunburst charts)
    *   **Tauri APIs/Plugins**:
        *   `@tauri-apps/api/core`: For Inter-Process Communication (IPC) between the frontend and backend, event listening, and invoking Rust commands.
        *   `@tauri-apps/plugin-dialog`: For native file open/save, message, and confirmation dialogs.
        *   `@tauri-apps/api/tray`: For system tray icon management (though not explicitly used in the main frontend logic, it's part of the dependencies).
    *   **Internationalization (i18n)**: The application supports multiple languages (English and Slovak) via a `translations.json` file, with language selection persisted in local storage.
*   **Database**: Not applicable for core functionality; file system is the primary data source.

## Architecture

The application follows a client-server architecture facilitated by the Tauri framework:

*   **Frontend (Webview)**: This is the user-facing part, built using standard web technologies (HTML, CSS, JavaScript). It leverages D3.js to render a dynamic and interactive sunburst chart that visualizes disk usage. All user interactions, such as clicks, hovers, context menus, and drag-and-drop events, are handled here. The frontend communicates with the backend exclusively through Tauri's IPC layer.
*   **Backend (Rust)**: This component is responsible for all system-level operations. It enumerates available disks, performs recursive file system scans, executes file operations (moving to trash, permanent deletion), and integrates with external applications (e.g., opening paths in the system's file manager or Total Commander on Windows). The Rust backend exposes specific functionalities as "commands" that the frontend can `invoke` and emits "events" that the frontend can `listen` to for real-time updates.
*   **IPC Layer**: Tauri's robust IPC mechanism acts as the communication bridge. It allows the JavaScript frontend to call Rust functions (`invoke`) and enables the Rust backend to send data and notifications back to the JavaScript frontend (`emit` and `listen`).

## Key User Workflows

1.  **View Available Disks**: Upon launching, the user is presented with a list of detected storage drives, displaying their names, mount points, types (SSD, HDD, Removable), and current usage statistics.
2.  **Initiate Disk/Folder Scan**: The user can select a disk from the list to analyze its contents or use a file dialog/drag-and-drop to specify a particular folder for scanning.
3.  **Monitor Scan Progress**: During a scan, a live ticker shows the currently processed file/folder path and a progress bar indicates the overall completion status.
4.  **Visualize Disk Usage**: Once the scan is complete, the disk usage is displayed as an interactive sunburst chart, where each segment represents a file or folder, with its size determining its angular width.
5.  **Navigate & Inspect**: Users can click on a segment to "zoom in" and explore its sub-contents, navigate back up the hierarchy, and use breadcrumbs for context. Hovering over segments reveals detailed information like the full path, size, and contained file/directory counts.
6.  **File System Actions**: A right-click context menu on any chart segment provides several actions:
    *   "Open in File Explorer" (or system equivalent).
    *   "Open in Total Commander" (Windows-specific).
    *   "Properties" to view system file properties.
    *   "Copy path" to clipboard.
    *   "Move to Trash" (with a confirmation dialog).
    *   "Delete Permanently" (with a strong warning and confirmation).
7.  **Configuration**: Users can access a settings modal to configure the path to the Total Commander executable (Windows-specific) and change the application's display language.
8.  **Scan Management**: An active scan can be cancelled at any time, returning the user to the disk selection screen.
9.  **Display Customization**: Users can toggle a "Fast mode" (performance filter to hide small files/folders) and enable/disable animated transitions for the sunburst chart.

```