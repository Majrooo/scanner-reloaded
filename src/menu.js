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

  let disks = await Utils.invokeWithTimeout("get_disks", {}, 10000);

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
    await Utils.invokeWithTimeout("validate_directory", { path: path }, 5000);
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
        Utils.showToast(I18n.getText("toast.folderSelectFailed"), "error", 5000);
      }
    };
  }

  const systemUtilitiesSection = document.getElementById("system-utilities-section");
  if (isWindows && systemUtilitiesSection) {
    systemUtilitiesSection.classList.remove("hidden");

    document.getElementById("util-disk-cleanup")?.addEventListener("click", () => Utils.invokeWithTimeout("open_system_utility", { utility: "disk-cleanup" }, 10000));
    document.getElementById("util-apps-features")?.addEventListener("click", () => Utils.invokeWithTimeout("open_system_utility", { utility: "apps-features" }, 10000));
    document.getElementById("util-storage-settings")?.addEventListener("click", () => Utils.invokeWithTimeout("open_system_utility", { utility: "storage-settings" }, 10000));
    document.getElementById("util-defrag")?.addEventListener("click", () => Utils.invokeWithTimeout("open_system_utility", { utility: "defrag" }, 10000));
  }

  // TC Path section (Windows only)
  const tcPathSection = document.getElementById("tc-path-section");
  if (isWindows && tcPathSection) {
    tcPathSection.classList.remove("hidden");
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

  // Help Modal (Menu) — opening and dynamic population
  const helpMenuBtn = document.getElementById("help-menu-btn");
  const helpMenuModal = document.getElementById("help-menu-modal");
  const closeHelpMenuBtn = document.getElementById("close-help-menu-btn");
  const helpMenuBody = document.getElementById("help-menu-body");

  function renderHelpMenuModal() {
    if (!helpMenuBody) return;
    const items = I18n.getText("helpModalMenu.items");
    // getText returns the key if not found; items is an array so we need special handling
    const transData = I18n.getTranslationsData();
    const langData = transData?.languages?.[I18n.getCurrentLanguage()] || transData?.languages?.[transData?.defaultLanguage] || {};
    const helpItems = langData?.helpModalMenu?.items || [];
    helpMenuBody.innerHTML = helpItems.map(item => {
      return `<div class="help-item">
        <strong>${item.title}</strong>
        <p>${item.text}</p>
      </div>`;
    }).join("");
  }

  helpMenuBtn.onclick = () => {
    renderHelpMenuModal();
    if (helpMenuModal.showModal) {
      helpMenuModal.showModal();
    } else {
      helpMenuModal.classList.remove("hidden");
    }
  };

  closeHelpMenuBtn.onclick = () => {
    if (helpMenuModal.close) {
      helpMenuModal.close();
    } else {
      helpMenuModal.classList.add("hidden");
    }
  };

  // About Modal - using native dialog API
  aboutBtn.onclick = async () => {
    I18n.applyTranslations();
    try {
      const version = await window.__TAURI__.app.getVersion();
      document.getElementById("app-version").textContent = version;
    } catch (e) {
      // fallback if running outside Tauri
    }
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
      await Utils.invokeWithTimeout("set_tc_path", { path: tcPathInput.value || "" }, 5000);
    }
    if (tcPathModal.close) {
      tcPathModal.close();
    } else {
      tcPathModal.classList.add("hidden");
    }
  };

  tcClearBtn.onclick = async () => {
    tcPathInput.value = "";
    await Utils.invokeWithTimeout("set_tc_path", { path: "" }, 5000);
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

  // ─── App Settings Modal ─────────────────────────────────────────────────

  const appSettingsBtn = document.getElementById("app-settings-btn");
  const appSettingsModal = document.getElementById("app-settings-modal");
  const closeAppSettingsBtn = document.getElementById("close-app-settings-btn");
  const appSettingsCloseBtn = document.getElementById("app-settings-close-btn");
  const permLoggingToggle = document.getElementById("perm-logging-toggle");
  const internalLoggingToggle = document.getElementById("internal-logging-toggle");
  const openErrorLogBtn = document.getElementById("open-error-log-btn");
  const logPathDisplay = document.getElementById("log-path-display");

  async function openAppSettings() {
    // Load current logging config
    try {
      const config = await Utils.invokeWithTimeout("get_logging_config", {}, 5000);
      permLoggingToggle.checked = config.permission_errors !== false;
      internalLoggingToggle.checked = config.internal_errors !== false;
    } catch (err) {
      console.error("Failed to load logging config:", err);
      // Defaults: both enabled
      permLoggingToggle.checked = true;
      internalLoggingToggle.checked = true;
    }

    // Load log path
    try {
      const logPath = await Utils.invokeWithTimeout("get_error_log_path", {}, 5000);
      logPathDisplay.textContent = logPath || "unknown";
    } catch (err) {
      logPathDisplay.textContent = "unknown";
    }

    appSettingsModal.classList.remove("hidden");
  }

  function closeAppSettings() {
    appSettingsModal.classList.add("hidden");
  }

  function updateOpenLogButtonState() {
    // Enable the button only if the log file exists
    Utils.invokeWithTimeout("get_error_log_path", {}, 5000).then(logPath => {
      // If we got a path (not "unknown"), assume the file may exist
      // The backend open_error_log command will check existence and show error if needed
      openErrorLogBtn.disabled = false;
    }).catch(() => {
      openErrorLogBtn.disabled = true;
    });
  }

  if (appSettingsBtn) {
    appSettingsBtn.addEventListener("click", openAppSettings);
  }

  if (closeAppSettingsBtn) {
    closeAppSettingsBtn.addEventListener("click", closeAppSettings);
  }

  if (appSettingsCloseBtn) {
    appSettingsCloseBtn.addEventListener("click", closeAppSettings);
  }

  // Info-toggle button (ⓘ) event delegation
  appSettingsModal.querySelector('.modal-body').addEventListener('click', (e) => {
    const btn = e.target.closest('.info-toggle-btn');
    if (!btn) return;
    const infoId = btn.dataset.infoId;
    if (!infoId) return;
    const card = document.getElementById(infoId);
    if (!card) return;
    card.classList.toggle('hidden');
    btn.classList.toggle('active');
  });

  // Save logging config helper
  async function saveLoggingConfig() {
    try {
      await Utils.invokeWithTimeout("set_logging_config", {
        config: {
          permission_errors: permLoggingToggle.checked,
          internal_errors: internalLoggingToggle.checked,
        }
      }, 5000);
      Utils.showToast(I18n.getText("appSettings.logging.saved") || "Logging settings saved", "info");
    } catch (err) {
      Utils.showToast(I18n.getText("appSettings.logging.toggleFailed") || "Failed to save setting", "error");
    }
  }

  // Permission logging toggle
  if (permLoggingToggle) {
    permLoggingToggle.addEventListener("change", async () => {
      await saveLoggingConfig();
    });
  }

  // Internal logging toggle
  if (internalLoggingToggle) {
    internalLoggingToggle.addEventListener("change", async () => {
      await saveLoggingConfig();
    });
  }

  // Open error log button
  if (openErrorLogBtn) {
    openErrorLogBtn.addEventListener("click", async () => {
      try {
        await Utils.invokeWithTimeout("open_error_log", {}, 10000);
      } catch (err) {
        const msg = Utils.extractErrorMessage(err);
        Utils.showToast(msg || I18n.getText("appSettings.logging.openFailed") || "Failed to open error log", "error");
      }
    });
  }

  // Click on backdrop closes dialog
  window.addEventListener("click", (event) => {
    if (event.target === appSettingsModal) {
      closeAppSettings();
    }
  });

  // Update "Open Error Log" button state whenever modal opens (file may have been created)
  if (appSettingsBtn) {
    appSettingsBtn.addEventListener("click", () => {
      setTimeout(updateOpenLogButtonState, 200);
    });
  }

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