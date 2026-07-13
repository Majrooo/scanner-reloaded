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

// Toast & Confirm
const toastContainer = document.getElementById("toast-container");
const confirmModal = document.getElementById("confirm-modal");
const confirmMessage = document.getElementById("confirm-message");
const confirmOkBtn = document.getElementById("confirm-ok-btn");
const confirmCancelBtn = document.getElementById("confirm-cancel-btn");

// Cancel scan
const cancelScanBtn = document.getElementById("cancel-scan-btn");
let isScanning = false;

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

// Animovaný graf
let useAnimatedGraph = false;

// Detekcia OS
const isWindows = navigator.platform?.toLowerCase().includes("win") || navigator.userAgent?.toLowerCase().includes("windows");

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

// ── Toast notifikácie (A3) ────────────────────────────────────────────────────
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

// ── Custom Confirm Dialog (A4) ────────────────────────────────────────────────
function showConfirm(message, isDanger = false) {
  return new Promise((resolve) => {
    if (!confirmModal || !confirmMessage) {
      resolve(window.confirm(message));
      return;
    }

    confirmMessage.textContent = message;
    confirmOkBtn.classList.toggle("danger", isDanger);
    confirmModal.classList.remove("hidden");

    function cleanup() {
      confirmModal.classList.add("hidden");
      confirmOkBtn.onclick = null;
      confirmCancelBtn.onclick = null;
    }

    confirmOkBtn.onclick = () => {
      cleanup();
      resolve(true);
    };

    confirmCancelBtn.onclick = () => {
      cleanup();
      resolve(false);
    };
  });
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

  // A8: Zobraziť tlačidlo zrušenia skenovania
  isScanning = true;
  if (cancelScanBtn) cancelScanBtn.classList.remove("hidden");

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
    // A8: Skryť tlačidlo zrušenia po dokončení
    isScanning = false;
    if (cancelScanBtn) cancelScanBtn.classList.add("hidden");

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
    // A8: Skryť tlačidlo zrušenia pri chybe
    isScanning = false;
    if (cancelScanBtn) cancelScanBtn.classList.add("hidden");

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

  // A8: Skryť tlačidlo zrušenia a resetovať stav skenovania
  isScanning = false;
  if (cancelScanBtn) cancelScanBtn.classList.add("hidden");

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
    })
    // Pravý klik na stred grafu - otvorí kontextové menu pre aktuálny fokus
    .on("contextmenu", (event) => {
      event.preventDefault();
      if (currentFocus) {
        menuTargetNode = currentFocus;

        if (contextMenu) {
          contextMenu.style.top = `${event.pageY}px`;
          contextMenu.style.left = `${event.pageX}px`;
          contextMenu.classList.remove("hidden");
        }
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

  // Pomocná funkcia pre farbu
  function getFillColor(d) {
    if (d.data.is_dir) {
      const localYellowScale = d3.scaleLinear()
        .domain([0, realMaxDepth])
        .range(["#ffcc00", "#423500"]);
      return localYellowScale(d.depth - p.depth - 1);
    }
    return "#89b4fa";
  }

  // Pomocná funkcia pre event listenery na path
  function attachPathEvents(paths) {
    paths.on("mouseover", (event, d) => {
      hoverPath.textContent = d.data.path;
      hoverSize.textContent = formatBytes(d.value);
      const dirCount = d.data.dir_count || 0;
      const fileCount = d.data.file_count || 0;
      hoverStats.textContent = d.data.is_dir
        ? getText("scanScreen.stats.contains", { dirCount, fileCount })
        : getText("scanScreen.stats.fileType");

      // A2: Hover highlight - zvýrazni aktívny segment, stlmi ostatné
      d3.select("#sunburst-group").selectAll("path")
        .classed("hover-active", false)
        .classed("hover-dimmed", true);
      d3.select(event.currentTarget)
        .classed("hover-active", true)
        .classed("hover-dimmed", false);
    })
      .on("mouseout", (event) => {
        hoverPath.textContent = getText("scanScreen.hoverPlaceholder");
        hoverSize.textContent = "";
        hoverStats.textContent = "";

        // A2: Reset hover highlight
        d3.select("#sunburst-group").selectAll("path")
          .classed("hover-active", false)
          .classed("hover-dimmed", false);
      })
      .on("click", (event, d) => {
        if (d.children && d.children.length > 0) {
          zoomTo(d);
        }
      })
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

  if (useAnimatedGraph) {
    // ── ANIMOVANÝ REŽIM ──────────────────────────────────────────────
    const TRANSITION_DURATION = 600;

    // Pomocná funkcia pre interpoláciu oblúkov
    function arcTween(oldArc, newArc) {
      const interpolateStartAngle = d3.interpolate(oldArc.startAngle, newArc.startAngle);
      const interpolateEndAngle = d3.interpolate(oldArc.endAngle, newArc.endAngle);
      const interpolateInnerR = d3.interpolate(oldArc.innerRadius, newArc.innerRadius);
      const interpolateOuterR = d3.interpolate(oldArc.outerRadius, newArc.outerRadius);

      return function(t) {
        return arc({
          startAngle: interpolateStartAngle(t),
          endAngle: interpolateEndAngle(t),
          innerRadius: interpolateInnerR(t),
          outerRadius: interpolateOuterR(t),
          depth: newArc.depth,
          x0: newArc.x0,
          x1: newArc.x1,
          data: newArc.data
        });
      };
    }

    // Vypočítame arc data pre každý viditeľný uzol
    const arcDataMap = new Map();
    visibleDescendants.forEach(d => {
      arcDataMap.set(d.data.path, {
        startAngle: Math.max(0, Math.min(2 * Math.PI, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
        endAngle: Math.max(0, Math.min(2 * Math.PI, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
        innerRadius: getScaleY(d.depth - p.depth - 1),
        outerRadius: getScaleY(d.depth - p.depth) - 1,
        depth: d.depth,
        x0: d.x0,
        x1: d.x1,
        data: d.data
      });
    });

    // Získame existujúce paths
    const existingPaths = svg.selectAll("path").data(visibleDescendants, d => d.data.path);

    // Odchádzajúce paths (fade out + shrink to center)
    existingPaths.exit()
      .transition()
      .duration(TRANSITION_DURATION / 2)
      .style("opacity", 0)
      .attrTween("d", function(d) {
        const oldD = this.__arcData || {
          startAngle: 0, endAngle: 0,
          innerRadius: innerHoleRadius, outerRadius: innerHoleRadius
        };
        const target = {
          startAngle: oldD.startAngle,
          endAngle: oldD.startAngle,
          innerRadius: innerHoleRadius,
          outerRadius: innerHoleRadius
        };
        return arcTween(oldD, target);
      })
      .remove();

    // Aktualizácia existujúcich paths (animácia z starej pozície na novú)
    existingPaths.each(function(d) {
      const el = this;
      const newArcData = arcDataMap.get(d.data.path);
      const oldArcData = el.__arcData || newArcData;

      d3.select(el)
        .transition()
        .duration(TRANSITION_DURATION)
        .attrTween("d", function() {
          return arcTween(oldArcData, newArcData);
        })
        .attr("fill", getFillColor(d))
        .on("end", function() {
          el.__arcData = newArcData;
        });
    });

    // Nové paths (expand from center)
    const newPaths = existingPaths.enter()
      .append("path")
      .attr("fill", d => getFillColor(d))
      .style("cursor", "pointer")
      .style("opacity", 0)
      .each(function(d) {
        const newArcData = arcDataMap.get(d.data.path);
        const startArc = {
          startAngle: newArcData.startAngle,
          endAngle: newArcData.startAngle,
          innerRadius: innerHoleRadius,
          outerRadius: innerHoleRadius
        };
        this.__arcData = startArc;
        d3.select(this).attr("d", arc(startArc));
      });

    newPaths.transition()
      .duration(TRANSITION_DURATION)
      .style("opacity", 1)
      .attrTween("d", function(d) {
        const startArc = this.__arcData;
        const endArc = arcDataMap.get(d.data.path);
        return arcTween(startArc, endArc);
      })
      .on("end", function(d) {
        this.__arcData = arcDataMap.get(d.data.path);
      });

    // Spojíme existujúce + nové pre event listenery
    const allPaths = existingPaths.merge(newPaths);
    attachPathEvents(allPaths);

  } else {
    // ── KLASSICKÝ REŽIM (okamžité prekreslenie) ──────────────────────
    svg.selectAll("path").remove();

    const paths = svg
      .selectAll("path")
      .data(visibleDescendants, d => d.data.path)
      .join("path")
      .attr("fill", d => getFillColor(d))
      .attr("d", arc)
      .style("cursor", "pointer");

    attachPathEvents(paths);
  }
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

  // Animation toggle listener
  const animationToggle = document.getElementById("animation-toggle");
  if (animationToggle) {
    // Načítanie stavu z localStorage
    const savedAnimationState = localStorage.getItem("disk-scanner-animation");
    if (savedAnimationState === "true") {
      animationToggle.checked = true;
      useAnimatedGraph = true;
    }

    animationToggle.addEventListener("change", (event) => {
      useAnimatedGraph = event.target.checked;
      localStorage.setItem("disk-scanner-animation", useAnimatedGraph);
      if (currentFocus) {
        zoomTo(currentFocus);
      }
    });
  }

  backBtn.onclick = showDiskScreen;

  // A6: Refresh button - obnoví zoznam diskov
  const refreshDisksBtn = document.getElementById("refresh-disks-btn");
  if (refreshDisksBtn) {
    refreshDisksBtn.onclick = () => loadDisks();
  }

  // A8: Cancel scan button - zruší skenovanie a vráti na obrazovku diskov
  if (cancelScanBtn) {
    cancelScanBtn.onclick = async () => {
      if (isScanning) {
        try {
          await invoke("cancel_scan");
        } catch (err) {
          console.error("Cancel scan failed:", err);
        }
        showToast(getText("toast.scanCancelled"), "info");
        showDiskScreen();
      }
    };
  }

  // A4: Zatvorenie confirm modalu kliknutím mimo neho
  window.addEventListener("click", (event) => {
    if (event.target === confirmModal) {
      confirmModal.classList.add("hidden");
      if (confirmOkBtn) confirmOkBtn.onclick = null;
      if (confirmCancelBtn) confirmCancelBtn.onclick = null;
    }
  });

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
          showToast(err, "error");
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

  // A5: Kopírovanie cesty do schránky
  const cmCopyPath = document.getElementById("cm-copy-path");
  if (cmCopyPath) {
    cmCopyPath.onclick = async () => {
      if (menuTargetNode) {
        try {
          await navigator.clipboard.writeText(menuTargetNode.data.path);
          showToast(getText("toast.pathCopied"), "success");
        } catch (err) {
          showToast(getText("toast.copyFailed"), "error");
        }
      }
    };
  }

  const cmTrash = document.getElementById("cm-trash");
  if (cmTrash) {
    cmTrash.onclick = async () => {
      if (menuTargetNode) {
        // A4+A9: Vlastný confirm dialog + toast feedback
        const confirmed = await showConfirm(
          getText("confirmations.trash", { name: menuTargetNode.data.name }),
          false
        );
        if (confirmed) {
          try {
            await invoke("move_to_trash", { path: menuTargetNode.data.path });
            showToast(getText("toast.trashed", { name: menuTargetNode.data.name }), "success");

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
            showToast(err, "error");
          }
        }
      }
    };
  }

  const cmDelete = document.getElementById("cm-delete");
  if (cmDelete) {
    cmDelete.onclick = async () => {
      if (menuTargetNode) {
        // A4+A9: Vlastný confirm dialog (danger) + toast feedback
        const confirmed = await showConfirm(
          getText("confirmations.delete", { name: menuTargetNode.data.name }),
          true
        );
        if (confirmed) {
          try {
            await invoke("permanent_delete", { path: menuTargetNode.data.path });
            showToast(getText("toast.deleted", { name: menuTargetNode.data.name }), "success");

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
            showToast(err, "error");
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
        showToast(getText("tcModal.saved"), "success");
        tcPathModal.classList.add("hidden");
      } catch (err) {
        showToast(err, "error");
      }
    };
  }

  if (tcClearBtn) {
    tcClearBtn.onclick = async () => {
      try {
        await invoke("set_tc_path", { path: "" });
        tcPathInput.value = "";
        tcCurrentPathInfo.textContent = getText("tcModal.noPath");
        showToast(getText("tcModal.cleared"), "info");
      } catch (err) {
        showToast(err, "error");
      }
    };
  }

  // Add "Set TC Path" item to context menu dynamically (len na Windows)
  if (isWindows) {
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
  } else {
    // Na ne-Windows systémoch skryjeme TC položky v kontextovom menu
    const cmOpenTcItem = document.getElementById("cm-open-tc");
    if (cmOpenTcItem) {
      cmOpenTcItem.style.display = "none";
    }
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