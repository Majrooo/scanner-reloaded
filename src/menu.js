const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

let aboutBtn = document.getElementById("about-btn");
let aboutModal = document.getElementById("about-modal");
let closeAboutBtn = document.getElementById("close-about-btn");
let githubLink = document.getElementById("github-link");

let diskScreen = document.getElementById("disk-screen");
let diskList = document.getElementById("disk-list");

// Toast
const toastContainer = document.getElementById("toast-container");

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

// Detekcia OS
const isWindows = navigator.platform?.toLowerCase().includes("win") || navigator.userAgent?.toLowerCase().includes("windows");

let translationsData = null;
let currentLanguage = "sk";

function getNestedValue(obj, path) {
  return path.split(".").reduce((current, key) => current?.[key], obj);
}

function interpolate(template, replacements = {}) {
  if (typeof template !== "string") return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => replacements[key] ?? "");
}

function getText(key, replacements = {}) {
  if (!translationsData) return key;

  const currentTranslations = translationsData.languages?.[currentLanguage];
  const fallbackTranslations = translationsData.languages?.[translationsData.defaultLanguage] || {};
  const value = getNestedValue(currentTranslations, key) ?? getNestedValue(fallbackTranslations, key) ?? key;

  return interpolate(value, replacements);
}

function applyTranslations() {
  if (!translationsData) return;

  document.documentElement.lang = currentLanguage;
  document.title = getText("appTitle");

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    if (key) {
      element.textContent = getText(key);
    }
  });

  // Apply aria-labels for elements with data-i18n-title
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    const key = element.getAttribute("data-i18n-title");
    if (key) {
      element.setAttribute("aria-label", getText(key));
    }
  });

  const languageSelect = document.getElementById("language-select");
  if (languageSelect) {
    languageSelect.value = currentLanguage;
  }
}

async function loadTranslations() {
  try {
    const response = await fetch("./translations.json");
    if (!response.ok) throw new Error("Failed to load translations");

    translationsData = await response.json();
    const languages = Object.keys(translationsData.languages || {});
    const languageSelect = document.getElementById("language-select");

    if (languageSelect) {
      languageSelect.innerHTML = "";
      languages.forEach((code) => {
        const option = document.createElement("option");
        option.value = code;
        option.textContent = translationsData.languages[code].name || code.toUpperCase();
        languageSelect.appendChild(option);
      });

      const storedLanguage = localStorage.getItem("disk-scanner-language");
      const browserLanguage = navigator.language?.split("-")[0];
      const preferredLanguage = storedLanguage || (languages.includes(browserLanguage) ? browserLanguage : translationsData.defaultLanguage || languages[0]);
      currentLanguage = languages.includes(preferredLanguage) ? preferredLanguage : translationsData.defaultLanguage || languages[0];
      languageSelect.value = currentLanguage;

      languageSelect.addEventListener("change", (event) => {
        currentLanguage = event.target.value;
        localStorage.setItem("disk-scanner-language", currentLanguage);
        applyTranslations();
        loadDisks();
      });
    }

    applyTranslations();
  } catch (error) {
    console.error(error);
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function showToast(message, type = "info", duration = 4000) {
  if (!toastContainer) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("toast-fading");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

async function loadDisks() {
  diskList.innerHTML = "";
  const noDisksMsg = document.getElementById("no-disks-message");
  let disks = await invoke("get_disks");
  disks.sort((a, b) => a.mount_point.localeCompare(b.mount_point));

  if (disks.length === 0) {
    if (noDisksMsg) noDisksMsg.classList.remove("hidden");
    return;
  }
  if (noDisksMsg) noDisksMsg.classList.add("hidden");

  disks.forEach(disk => {
    const used = disk.total_space - disk.available_space;
    const pct = (used / disk.total_space) * 100;
    const typeIcon = getText(`diskScreen.diskType.${disk.kind || "unknown"}`);

    const card = document.createElement("div");
    card.className = "disk-card";
    card.innerHTML = `
      <div class="disk-type-icon">${typeIcon}</div>
      <div class="disk-name" title="${disk.name} (${disk.mount_point})">${disk.name} (${disk.mount_point})</div>
      <div class="disk-bar-bg"><div class="disk-bar-fill" style="width: ${pct}%"></div></div>
      <div>${getText("diskScreen.used", { used: formatBytes(used), total: formatBytes(disk.total_space) })}</div>
    `;
    const usedSpace = disk.total_space - disk.available_space;
    card.onclick = () => startDiskScan(disk.mount_point, usedSpace);
    diskList.appendChild(card);
  });

  showToast(getText("toast.disksLoaded"), "success", 2000);
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
    showToast(getText("dragDrop.noPaths"), "error");
    return;
  }

  const path = paths[0]; // Take the first path

  try {
    // Validate path is a directory using Rust backend
    await invoke("validate_directory", { path: path });
    startDiskScan(path, 0);
  } catch (err) {
    showToast(getText("dragDrop.notDirectory"), "error");
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  await loadTranslations();
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
          title: getText("diskScreen.scanFolder"),
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

  // About Modal - using native dialog API
  aboutBtn.onclick = async () => {
    applyTranslations();
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
    
    if (eventType === 'hover') {
      handleDragDropHover();
    } else if (eventType === 'drop') {
      handleDragDrop(paths);
    } else if (eventType === 'cancelled') {
      handleDragDropCancel();
    }
  });
});
