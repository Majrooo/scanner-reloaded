const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

let aboutBtn = document.getElementById("about-btn");
let aboutModal = document.getElementById("about-modal");
let closeAboutBtn = document.getElementById("close-about-btn");
let githubLink = document.getElementById("github-link");

let diskScreen = document.getElementById("disk-screen");
let diskList = document.getElementById("disk-list");

// Drag & Drop overlay
const dragDropOverlay = document.getElementById("drag-drop-overlay");

// TC Path Modal
const tcPathModal = document.getElementById("tc-path-modal");
const tcPathInput = document.getElementById("tc-path-input");
const tcBrowseBtn = document.getElementById("tc-browse-btn");
const tcSaveBtn = document.getElementById("tc-save-btn");
const tcClearBtn = document.getElementById("tc-clear-btn");
const tcCloseBtn = document.getElementById("close-tc-modal-btn");
const tcCurrentPathInfo = document.getElementById("tc-current-path-info");

// OS detection
const isWindows = navigator.platform?.toLowerCase().includes("win") || navigator.userAgent?.toLowerCase().includes("windows");

async function loadDisks() {
  const skeleton = document.getElementById("disk-list-skeleton");
  diskList.innerHTML = "";
  const noDisksMsg = document.getElementById("no-disks-message");

  // Show skeleton while loading
  if (skeleton) skeleton.classList.remove("hidden");

  let disks = await invoke("get_disks");

  // Hide skeleton after loading
  if (skeleton) skeleton.classList.add("hidden");
  disks.sort((a, b) => a.mount_point.localeCompare(b.mount_point));

  if (disks.length === 0) {
    if (noDisksMsg) noDisksMsg.classList.remove("hidden");
    return;
  }
  if (noDisksMsg) noDisksMsg.classList.add("hidden");

  disks.forEach(disk => {
    const used = disk.total_space - disk.available_space;
    const pct = (used / disk.total_space) * 100;
    const typeIcon = I18n.getText(`diskScreen.diskType.${disk.kind || "unknown"}`);

    const card = document.createElement("div");
    card.className = "disk-card";
    card.innerHTML = `
      <div class="disk-type-icon">${typeIcon}</div>
      <div class="disk-name" title="${disk.name} (${disk.mount_point})">${disk.name} (${disk.mount_point})</div>
      <div class="disk-bar-bg"><div class="disk-bar-fill" style="width: ${pct}%"></div></div>
      <div>${I18n.getText("diskScreen.used", { used: Utils.formatBytes(used), total: Utils.formatBytes(disk.total_space) })}</div>
    `;
    const usedSpace = disk.total_space - disk.available_space;
    card.onclick = () => startDiskScan(disk.mount_point, usedSpace);
    diskList.appendChild(card);
  });

  Utils.showToast(I18n.getText("toast.disksLoaded"), "success", 2000);
}

function startDiskScan(path, totalSpace) {
  const encodedPath = encodeURIComponent(path);
  const encodedTotalSpace = encodeURIComponent(totalSpace);
  window.location.href = `scanner.html?path=${encodedPath}&totalSpace=${encodedTotalSpace}`;
}

function handleDragDropHover() {
  if (dragDropOverlay) {
    dragDropOverlay.classList.add("drag-over");
    dragDropOverlay.classList.remove("hidden");
  }
}

function handleDragDropCancel() {
  if (dragDropOverlay) {
    dragDropOverlay.classList.remove("drag-over");
    dragDropOverlay.classList.add("hidden");
  }
}

async function handleDragDrop(paths) {
  if (dragDropOverlay) {
    dragDropOverlay.classList.remove("drag-over");
    dragDropOverlay.classList.add("hidden");
  }

  if (!paths || paths.length === 0) {
    Utils.showToast(I18n.getText("dragDrop.noPaths"), "error");
    return;
  }

  const path = paths[0]; // Take the first path

  try {
    // Validate path is a directory using Rust backend
    await invoke("validate_directory", { path: path });
    startDiskScan(path, 0);
  } catch (err) {
    Utils.showToast(I18n.getText("dragDrop.notDirectory"), "error");
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  await I18n.loadTranslations();
  loadDisks();

  const refreshDisksBtn = document.getElementById("refresh-disks-btn");
  if (refreshDisksBtn) {
    refreshDisksBtn.onclick = () => loadDisks();
  }

  const scanFolderBtn = document.getElementById("scan-folder-btn");
  if (scanFolderBtn) {
    scanFolderBtn.onclick = async () => {
      try {
        const selected = await window.__TAURI__.dialog.open({
          directory: true,
          multiple: false,
          title: I18n.getText("diskScreen.scanFolder"),
        });
        if (selected) {
          startDiskScan(selected, 0);
        }
      } catch (err) {
        console.error("Folder selection failed:", err);
      }
    };
  }

  const systemUtilitiesSection = document.getElementById("system-utilities-section");
  if (isWindows && systemUtilitiesSection) {
    systemUtilitiesSection.classList.remove("hidden");

    document.getElementById("util-disk-cleanup")?.addEventListener("click", () => invoke("open_system_utility", { utility: "disk-cleanup" }));
    document.getElementById("util-apps-features")?.addEventListener("click", () => invoke("open_system_utility", { utility: "apps-features" }));
    document.getElementById("util-storage-settings")?.addEventListener("click", () => invoke("open_system_utility", { utility: "storage-settings" }));
    document.getElementById("util-defrag")?.addEventListener("click", () => invoke("open_system_utility", { utility: "defrag" }));
  }

  // Language selector setup
  const languageSelect = document.getElementById("language-select");
  if (languageSelect) {
    const languages = I18n.getAvailableLanguages();
    const transData = I18n.getTranslationsData();
    languageSelect.innerHTML = "";
    languages.forEach((code) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = (transData?.languages?.[code]?.name) || code.toUpperCase();
      languageSelect.appendChild(option);
    });
    languageSelect.value = I18n.getCurrentLanguage();
    languageSelect.addEventListener("change", (event) => {
      I18n.setLanguage(event.target.value);
      loadDisks();
    });
  }

  // About Modal - using native dialog API
  aboutBtn.onclick = async () => {
    I18n.applyTranslations();
    if (aboutModal.showModal) {
      aboutModal.showModal();
    } else {
      aboutModal.classList.remove("hidden");
    }
  };

  closeAboutBtn.onclick = () => {
    if (aboutModal.close) {
      aboutModal.close();
    } else {
      aboutModal.classList.add("hidden");
    }
  };

  // TC Path Modal - using native dialog API
  tcCloseBtn.onclick = () => {
    if (tcPathModal.close) {
      tcPathModal.close();
    } else {
      tcPathModal.classList.add("hidden");
    }
  };

  tcSaveBtn.onclick = async () => {
    if (tcPathInput.value) {
      await invoke("set_tc_path", { path: tcPathInput.value || "" });
    }
    if (tcPathModal.close) {
      tcPathModal.close();
    } else {
      tcPathModal.classList.add("hidden");
    }
  };

  tcClearBtn.onclick = async () => {
    tcPathInput.value = "";
    await invoke("set_tc_path", { path: "" });
    if (tcPathModal.close) {
      tcPathModal.close();
    } else {
      tcPathModal.classList.add("hidden");
    }
  };

  // Click on backdrop closes dialogs (native dialogs handle this automatically, but we keep fallback)
  window.addEventListener("click", (event) => {
    if (event.target === aboutModal) {
      if (aboutModal.close) {
        aboutModal.close();
      } else {
        aboutModal.classList.add("hidden");
      }
    }
    if (event.target === tcPathModal) {
      if (tcPathModal.close) {
        tcPathModal.close();
      } else {
        tcPathModal.classList.add("hidden");
      }
    }
  });

  // Register drag-drop event listeners using Window API
  const appWindow = getCurrentWindow();
  await appWindow.onDragDropEvent((event) => {
    const eventType = event.type || event.payload?.type;
    const paths = event.paths || event.payload?.paths || [];
    
    if (eventType === 'enter' || eventType === 'over') {
      handleDragDropHover();
    } else if (eventType === 'drop') {
      handleDragDrop(paths);
    } else if (eventType === 'leave') {
      handleDragDropCancel();
    }
  });
});