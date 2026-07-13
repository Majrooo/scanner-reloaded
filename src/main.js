const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let aboutBtn = document.getElementById("about-btn");
let aboutModal = document.getElementById("about-modal");
let closeAboutBtn = document.getElementById("close-about-btn");
let githubLink = document.getElementById("github-link");

let diskScreen = document.getElementById("disk-screen");
let scanScreen = document.getElementById("scan-screen");
let diskList = document.getElementById("disk-list");
let currentFolderTitle = document.getElementById("current-folder-title");
let backBtn = document.getElementById("back-to-disks-btn");
let liveTicker = document.getElementById("live-ticker");
let filterToggle = document.getElementById("filter-toggle");

let hoverPath = document.getElementById("hover-path");
let hoverSize = document.getElementById("hover-size");
let hoverStats = document.getElementById("hover-stats");

let centerIcon = document.getElementById("center-icon");
let centerName = document.getElementById("center-name");
let centerSize = document.getElementById("center-size");
let centerInfo = document.getElementById("center-info");

// Context menu
let menuTargetNode = null;
const contextMenu = document.getElementById("custom-context-menu");

// TC Path Modal
const tcPathModal = document.getElementById("tc-path-modal");
const tcPathInput = document.getElementById("tc-path-input");
const tcBrowseBtn = document.getElementById("tc-browse-btn");
const tcSaveBtn = document.getElementById("tc-save-btn");
const tcClearBtn = document.getElementById("tc-clear-btn");
const tcCloseBtn = document.getElementById("close-tc-modal-btn");
const tcCurrentPathInfo = document.getElementById("tc-current-path-info");

// Globálna premenná, kde si uložíme celkovú kapacitu vybraného disku
let selectedDiskTotalSpace = 0;
let totalScannedBytes = 0;
let lastUpdateTime = 0;

// Globálne premenné pre správnu synchronizáciu
let memoryTree = {};
let rootPath = "";
let unlistenProgress;
let unlistenFinished;
let unlistenFailed;

// Globálne referencie pre D3 uzly (Dôležité pre živý filter)
let rootNode = null;
let gPartition = null;
let currentFocus = null;

const radius = 320;
const innerHoleRadius = 80;
const maxDepth = 24;

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

        if (currentFocus) {
          zoomTo(currentFocus);
        }

        if (!scanScreen.classList.contains("hidden")) {
          loadDisks();
        }
      });
    }

    applyTranslations();
  } catch (error) {
    console.error(error);
  }
}

// Globálna konfigurácia aplikácie
const APP_CONFIG = {
  usePerformanceFilter: true,
  minSizeToRender: 1 * 1024 * 1024,
  minAngleToRender: 0.01
};

// Škála žltej farby pre zložky
const yellowScale = d3.scaleLinear()
  .domain([0, maxDepth])
  .range(["#ffcc00", "#5c4a00"]);

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function loadDisks() {
  diskList.innerHTML = "";
  let disks = await invoke("get_disks");
  disks.sort((a, b) => a.mount_point.localeCompare(b.mount_point));

  disks.forEach(disk => {
    const used = disk.total_space - disk.available_space;
    const pct = (used / disk.total_space) * 100;

    const card = document.createElement("div");
    card.className = "disk-card";
    card.innerHTML = `
      <div class="disk-name" title="${disk.name} (${disk.mount_point})">${disk.name} (${disk.mount_point})</div>
      <div class="disk-bar-bg"><div class="disk-bar-fill" style="width: ${pct}%"></div></div>
      <div>${getText("diskScreen.used", { used: formatBytes(used), total: formatBytes(disk.total_space) })}</div>
    `;
    const usedSpace = disk.total_space - disk.available_space;
    card.onclick = () => startDiskScan(disk.mount_point, usedSpace);
    diskList.appendChild(card);
  });
}

async function startDiskScan(path, totalSpace) {
  if (unlistenProgress) unlistenProgress();
  if (unlistenFinished) unlistenFinished();
  diskScreen.classList.add("hidden");
  scanScreen.classList.remove("hidden");
  document.getElementById("live-ticker-container").classList.remove("hidden");
  liveTicker.textContent = getText("scanScreen.statuses.initializingScan");
  document.getElementById("live-ticker-bar").style.width = "0%"; // Reset progress baru

  d3.select("#sunburst-chart").selectAll("*").remove();

  rootPath = path.replace(/\\/g, "/");
  selectedDiskTotalSpace = totalSpace;
  totalScannedBytes = 0;
  lastUpdateTime = 0;

  updateCenterHUD("📁", path, "0 Bytes");

  unlistenProgress = await listen("scan-live-folder", (event) => {
    let currentPath = "";
    let currentSize = 0;

    if (typeof event.payload === "object" && event.payload !== null) {
      currentPath = event.payload.path || "";
      currentSize = event.payload.size || 0;
    } else {
      currentPath = event.payload;
    }

    totalScannedBytes += currentSize;

    const now = performance.now();
    if (now - lastUpdateTime >= 100) {
      lastUpdateTime = now;

      liveTicker.textContent = getText("scanScreen.statuses.current", { path: currentPath });

      if (selectedDiskTotalSpace > 0) {
        const progressPct = Math.min(100, (totalScannedBytes / selectedDiskTotalSpace) * 100);
        document.getElementById("live-ticker-bar").style.width = `${progressPct}%`;
      }

      updateCenterHUD("⏳", rootPath, formatBytes(totalScannedBytes));
    }
  });

  unlistenFinished = await listen("scan-finished-with-data", (event) => {
    liveTicker.textContent = getText("scanScreen.statuses.finished");
    document.getElementById("live-ticker-bar").style.width = "100%";

    setTimeout(() => {
      const tickerContainer = document.getElementById("live-ticker-container");
      if (tickerContainer) {
        tickerContainer.classList.add("hidden");
      }
    }, 6000);

    const fullTree = event.payload;

    const normalizePaths = (node) => {
      node.path = node.path.replace(/\\/g, "/");
      if (node.children) node.children.forEach(normalizePaths);
    };
    normalizePaths(fullTree);

    drawSunburst(fullTree);

    if (unlistenProgress) unlistenProgress();
    if (unlistenFinished) unlistenFinished();
    if (unlistenFailed) unlistenFailed();
  });

  unlistenFailed = await listen("scan-failed", (event) => {
    liveTicker.textContent = getText("scanScreen.statuses.error", { message: event.payload });
    document.getElementById("live-ticker-bar").style.width = "0%";
    if (unlistenProgress) unlistenProgress();
    if (unlistenFailed) unlistenFailed();
  });

  invoke("start_async_scan", { path });
}

function showDiskScreen() {
  if (unlistenProgress) unlistenProgress();
  if (unlistenFinished) unlistenFinished();
  if (unlistenFailed) unlistenFailed();
  scanScreen.classList.add("hidden");
  diskScreen.classList.remove("hidden");
  rootNode = null;
  gPartition = null;
  currentFocus = null;
  loadDisks();
}

function updateCenterHUD(icon, name, size) {
  centerIcon.textContent = icon;
  centerName.textContent = name;
  centerSize.textContent = size;
}

function updateBreadcrumbs(p) {
  const container = document.getElementById("current-folder-title");
  if (!container) return;
  container.innerHTML = "";

  const ancestors = p.ancestors().reverse();

  ancestors.forEach((node, index) => {
    const isLast = index === ancestors.length - 1;
    const item = document.createElement("span");
    item.className = `breadcrumb-item ${isLast ? "active" : ""}`;
    item.textContent = node.data.name;

    if (!isLast) {
      item.onclick = () => zoomTo(node);
    }

    container.appendChild(item);

    if (!isLast) {
      const separator = document.createElement("span");
      separator.className = "breadcrumb-separator";
      separator.textContent = " ❯ ";
      container.appendChild(separator);
    }
  });
}

function drawSunburst(data) {
  if (!data || !data.children || data.children.length === 0) return;

  const baseSize = 640;

  rootNode = d3.hierarchy(data)
    .sum(d => d.is_dir ? 0 : (d.size || 0))
    .sort((a, b) => b.value - a.value);

  gPartition = d3.partition().size([2 * Math.PI, radius]);
  rootNode.each(d => { d.data.size = d.value; });
  gPartition(rootNode);

  currentFocus = rootNode;

  d3.select("#sunburst-chart").selectAll("*").remove();
  const svg = d3.select("#sunburst-chart")
    .attr("viewBox", `0 0 ${baseSize} ${baseSize}`)
    .attr("width", "100%")
    .attr("height", "100%")
    .append("g")
    .attr("id", "sunburst-group")
    .attr("transform", `translate(${baseSize / 2},${baseSize / 2})`);

  svg.append("circle")
    .attr("r", innerHoleRadius)
    .attr("fill", "#1e1e2e")
    .attr("id", "d3-center-click-zone")
    .style("cursor", "default")
    .on("click", () => {
      if (currentFocus && currentFocus.parent) {
        zoomTo(currentFocus.parent);
      }
    });

  zoomTo(rootNode);
}

function zoomTo(p) {
  currentFocus = p;
  const svg = d3.select("#sunburst-group");
  if (svg.empty()) return;

  const d3Center = d3.select("#d3-center-click-zone");
  if (!d3Center.empty()) {
    d3Center.style("cursor", p.parent ? "pointer" : "default");
  }

  updateCenterHUD(p.parent ? getText("scanScreen.center.goUp") : "📁", p.data.name, formatBytes(p.value));
  updateBreadcrumbs(p);

  if (gPartition && rootNode) {
    gPartition(rootNode);
  }

  const descendants = p.descendants();

  const visibleDescendants = descendants.filter(d => {
    const basicCheck = d.depth > p.depth &&
      d.depth <= p.depth + maxDepth &&
      d.value > 0 &&
      d.x1 > p.x0 && d.x0 < p.x1;

    if (!basicCheck) return false;

    if (APP_CONFIG.usePerformanceFilter) {
      const sizeCheck = d.value >= APP_CONFIG.minSizeToRender;
      const relativeAngle = ((d.x1 - d.x0) / (p.x1 - p.x0)) * 2 * Math.PI;
      const angleCheck = relativeAngle >= APP_CONFIG.minAngleToRender;
      return sizeCheck && angleCheck;
    }

    return true;
  });

  let realMaxDepth = 0;
  visibleDescendants.forEach(d => {
    const currentRelativeDepth = d.depth - p.depth;
    if (currentRelativeDepth > realMaxDepth) {
      realMaxDepth = currentRelativeDepth;
    }
  });

  if (realMaxDepth === 0) realMaxDepth = 1;

  function getScaleY(depth) {
    if (depth <= 0) return innerHoleRadius;
    const availableRadius = radius - innerHoleRadius;
    const factor = realMaxDepth > 5 ? 0.90 : 0.95;

    let totalUnits = 0;
    for (let i = 0; i < realMaxDepth; i++) {
      totalUnits += Math.pow(factor, i);
    }

    const baseStep = availableRadius / totalUnits;

    let currentRadius = innerHoleRadius;
    for (let i = 0; i < depth; i++) {
      if (i >= realMaxDepth) return radius;
      currentRadius += baseStep * Math.pow(factor, i);
    }

    if (depth >= realMaxDepth) return radius;
    return currentRadius;
  }

  const arc = d3.arc()
    .startAngle(d => Math.max(0, Math.min(2 * Math.PI, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI)
    .endAngle(d => Math.max(0, Math.min(2 * Math.PI, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI)
    .innerRadius(d => getScaleY(d.depth - p.depth - 1))
    .outerRadius(d => getScaleY(d.depth - p.depth) - 1);

  svg.selectAll("path").remove();

  const paths = svg.append("g")
    .selectAll("path")
    .data(visibleDescendants, d => d.data.path)
    .join("path")
    .attr("fill", d => {
      if (d.data.is_dir) {
        const localYellowScale = d3.scaleLinear()
          .domain([0, realMaxDepth])
          .range(["#ffcc00", "#423500"]);
        return localYellowScale(d.depth - p.depth - 1);
      }
      return "#89b4fa";
    })
    .attr("d", arc)
    .style("cursor", "pointer");

  paths.on("mouseover", (event, d) => {
    hoverPath.textContent = d.data.path;
    hoverSize.textContent = formatBytes(d.value);
    const dirCount = d.data.dir_count || 0;
    const fileCount = d.data.file_count || 0;
    hoverStats.textContent = d.data.is_dir
      ? getText("scanScreen.stats.contains", { dirCount, fileCount })
      : getText("scanScreen.stats.fileType");
  })
    .on("mouseout", () => {
      hoverPath.textContent = getText("scanScreen.hoverPlaceholder");
      hoverSize.textContent = "";
      hoverStats.textContent = "";
    })
    .on("click", (event, d) => {
      if (d.children && d.children.length > 0) {
        zoomTo(d);
      }
    })
    // PRIDANÉ: Spracovanie pravého kliknutia (Context Menu) priamo na d3 objektoch
    .on("contextmenu", (event, d) => {
      event.preventDefault();
      menuTargetNode = d;

      if (contextMenu) {
        contextMenu.style.top = `${event.pageY}px`;
        contextMenu.style.left = `${event.pageX}px`;
        contextMenu.classList.remove("hidden");
      }
    });
}

// Skrytie kontextového menu pri kliknutí kamkoľvek mimo neho
window.addEventListener("click", () => {
  if (contextMenu) {
    contextMenu.classList.add("hidden");
  }
});

// Event Listenery po načítaní DOM
window.addEventListener("DOMContentLoaded", async () => {
  if (filterToggle) {
    filterToggle.addEventListener("change", (event) => {
      APP_CONFIG.usePerformanceFilter = event.target.checked;
      if (currentFocus) {
        zoomTo(currentFocus);
      }
    });
  }

  backBtn.onclick = showDiskScreen;

  // PRIDANÉ: Priradenie akcií pre položky kontextového menu (správne umiestnené v DOMContentLoaded)
  const cmOpenExplorer = document.getElementById("cm-open-explorer");
  if (cmOpenExplorer) {
    cmOpenExplorer.onclick = async () => {
      if (menuTargetNode) await invoke("show_in_file_manager", { path: menuTargetNode.data.path });
    };
  }

  const cmOpenTc = document.getElementById("cm-open-tc");
  if (cmOpenTc) {
    cmOpenTc.onclick = async () => {
      if (menuTargetNode) {
        try {
          await invoke("show_in_total_commander", { path: menuTargetNode.data.path });
        } catch (err) {
          alert(err);
        }
      }
    };
  }

  const cmProperties = document.getElementById("cm-properties");
  if (cmProperties) {
    cmProperties.onclick = async () => {
      if (menuTargetNode) await invoke("show_file_properties", { path: menuTargetNode.data.path });
    };
  }

  const cmTrash = document.getElementById("cm-trash");
  if (cmTrash) {
    cmTrash.onclick = async () => {
      if (menuTargetNode) {
        if (confirm(getText("confirmations.trash", { name: menuTargetNode.data.name }))) {
          try {
            await invoke("move_to_trash", { path: menuTargetNode.data.path });

            if (menuTargetNode.parent) {
              const parentNode = menuTargetNode.parent;

              // 1. Odstránenie uzla zo surových dát (vaša pôvodná logika)
              if (parentNode.data.children) {
                parentNode.data.children = parentNode.data.children.filter(
                  child => child.path !== menuTargetNode.data.path
                );
              }

              // 2. OPRAVA: Odstránenie uzla priamo z D3 štruktúry rodiča
              if (parentNode.children) {
                parentNode.children = parentNode.children.filter(
                  child => child.data.path !== menuTargetNode.data.path
                );
              }

              // 3. Prepočítanie celého stromu (veľkosti sa preženú smerom k rootu)
              rootNode.sum(d => d.is_dir ? 0 : (d.size || 0))
                      .sort((a, b) => b.value - a.value);

              // 4. Aktualizácia rozloženia (partition layout)
              if (gPartition) {
                gPartition(rootNode);
              }

              // 5. Prekreslenie grafu zameraného na rodiča
              zoomTo(parentNode);
            } else {
              showDiskScreen();
            }

          } catch (err) {
            alert("Chyba: " + err);
          }
        }
      }
    };
  }

  const cmDelete = document.getElementById("cm-delete");
  if (cmDelete) {
    cmDelete.onclick = async () => {
      if (menuTargetNode) {
        if (confirm(getText("confirmations.delete", { name: menuTargetNode.data.name }))) {
          try {
            await invoke("permanent_delete", { path: menuTargetNode.data.path });

            if (menuTargetNode.parent) {
              const parentNode = menuTargetNode.parent;

              // 1. Odstránenie zo surových dát
              if (parentNode.data.children) {
                parentNode.data.children = parentNode.data.children.filter(
                  child => child.path !== menuTargetNode.data.path
                );
              }

              // 2. OPRAVA: Odstránenie uzla priamo z D3 štruktúry rodiča
              if (parentNode.children) {
                parentNode.children = parentNode.children.filter(
                  child => child.data.path !== menuTargetNode.data.path
                );
              }

              // 3. Prepočítanie stromu
              rootNode.sum(d => d.is_dir ? 0 : (d.size || 0))
                      .sort((a, b) => b.value - a.value);

              // 4. Aktualizácia rozloženia
              if (gPartition) {
                gPartition(rootNode);
              }

              // 5. Prekreslenie grafu
              zoomTo(parentNode);
            } else {
              showDiskScreen();
            }

          } catch (err) {
            alert("Chyba: " + err);
          }
        }
      }
    };
  }

  // ── TC Path Modal Logic ──────────────────────────────────────────────

  async function openTcPathModal() {
    try {
      const currentPath = await invoke("get_tc_path");
      tcPathInput.value = currentPath || "";
      tcCurrentPathInfo.textContent = currentPath
        ? getText("tcModal.currentPath", { path: currentPath })
        : getText("tcModal.noPath");
    } catch {
      tcPathInput.value = "";
      tcCurrentPathInfo.textContent = getText("tcModal.noPath");
    }
    applyTranslations();
    tcPathModal.classList.remove("hidden");
  }

  if (tcCloseBtn) {
    tcCloseBtn.onclick = () => tcPathModal.classList.add("hidden");
  }

  window.addEventListener("click", (event) => {
    if (event.target === tcPathModal) {
      tcPathModal.classList.add("hidden");
    }
  });

  if (tcBrowseBtn) {
    tcBrowseBtn.onclick = async () => {
      try {
        const selected = await window.__TAURI__.dialog.open({
          filters: [{ name: "Executable", extensions: ["exe"] }],
          title: getText("tcModal.title"),
        });
        if (selected) {
          tcPathInput.value = selected;
        }
      } catch (err) {
        console.error("Browse failed:", err);
      }
    };
  }

  if (tcSaveBtn) {
    tcSaveBtn.onclick = async () => {
      const path = tcPathInput.value.trim();
      try {
        await invoke("set_tc_path", { path });
        tcCurrentPathInfo.textContent = path
          ? getText("tcModal.currentPath", { path })
          : getText("tcModal.noPath");
        alert(getText("tcModal.saved"));
        tcPathModal.classList.add("hidden");
      } catch (err) {
        alert(err);
      }
    };
  }

  if (tcClearBtn) {
    tcClearBtn.onclick = async () => {
      try {
        await invoke("set_tc_path", { path: "" });
        tcPathInput.value = "";
        tcCurrentPathInfo.textContent = getText("tcModal.noPath");
        alert(getText("tcModal.cleared"));
      } catch (err) {
        alert(err);
      }
    };
  }

  // Add "Set TC Path" item to context menu dynamically
  const cmSetTcPath = document.createElement("div");
  cmSetTcPath.className = "menu-item";
  cmSetTcPath.id = "cm-set-tc-path";
  cmSetTcPath.setAttribute("data-i18n", "contextMenu.setTCPath");
  cmSetTcPath.textContent = getText("contextMenu.setTCPath");
  cmSetTcPath.onclick = () => openTcPathModal();

  // Insert before the divider in context menu
  const cmDivider = contextMenu?.querySelector(".divider");
  if (cmDivider && contextMenu) {
    contextMenu.insertBefore(cmSetTcPath, cmDivider);
  }

  await loadTranslations();
  loadDisks();
});

// Otvorenie modálneho okna
aboutBtn.onclick = async () => {
  applyTranslations();
  aboutModal.classList.remove("hidden");
};

// Zatvorenie modálneho okna
closeAboutBtn.onclick = () => {
  aboutModal.classList.add("hidden");
};

// Zatvorenie kliknutím mimo okna (opravené aby nezatváralo kontextové menu)
window.addEventListener("click", (event) => {
  if (event.target === aboutModal) {
    aboutModal.classList.add("hidden");
  }
});

// Bezpečné otvorenie GitHubu v externom prehliadači cez Tauri rozhranie
if (githubLink) {
  githubLink.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      if (window.__TAURI__?.opener?.openUrl) {
        await window.__TAURI__.opener.openUrl("https://github.com/majrooo/scanner-reloaded");
      } else {
        window.open("https://github.com/majrooo/scanner-reloaded", "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      console.error("Nepodarilo sa otvoriť GitHub odkaz", error);
      window.open("https://github.com/majrooo/scanner-reloaded", "_blank", "noopener,noreferrer");
    }
  });
}