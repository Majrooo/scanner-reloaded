const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let scanScreen = document.getElementById("scan-screen");
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

// Globálna premenná, kde si uložíme celkovú kapacitu vybraného disku
let selectedDiskTotalSpace = 0;
let totalScannedBytes = 0;
let lastUpdateTime = 0;
let tickerHideTimeout = null;

// Globálne premenné pre správnu synchronizáciu
let memoryTree = {};
let rootPath = "";
// Aktuálne zobrazená cesta v rámci dynamického stromu (Local Relative Throttling)
let currentViewPath = "";
let unlistenProgress;
let unlistenFinished;
let unlistenFailed;

// Globálne referencie pre D3 uzly (Dôležité pre živý filter)
let rootNode = null;
let gPartition = null;
let currentFocus = null;

// Animovaný graf
let useAnimatedGraph = false;

// Globálny stav pre úvodnú animáciu
let isFirstRenderAfterScan = false;

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
    if (key) element.textContent = getText(key);
  });
}

async function loadTranslations() {
  try {
    const response = await fetch("./translations.json");
    if (!response.ok) throw new Error("Failed to load translations");
    translationsData = await response.json();
    const languages = Object.keys(translationsData.languages || {});
    const storedLanguage = localStorage.getItem("disk-scanner-language");
    const browserLanguage = navigator.language?.split("-")[0];
    const preferredLanguage = storedLanguage || (languages.includes(browserLanguage) ? browserLanguage : translationsData.defaultLanguage || languages[0]);
    currentLanguage = languages.includes(preferredLanguage) ? preferredLanguage : translationsData.defaultLanguage || languages[0];
    applyTranslations();
  } catch (error) {
    console.error(error);
  }
}

const APP_CONFIG = {
  usePerformanceFilter: true,
  autoTogglePerformanceFilter: true, // Whether to toggle the filter automatically based on the number of items
  performanceThreshold: 500,  // The threshold for automatically enabling the filter
  minSizeToRender: 1 * 1024 * 1024,
  minAngleToRender: 0.01,
  // Nastavenia animácií:
  introAnimationType: "random", // Možnosti: "none", "sweep", "grow", "staggered", "random"
  transitionDuration: 600,      // Pre interaktívny zoom
  introSweepDuration: 850,     // Trvanie pre vejár (sweep)
  introGrowDuration: 400       // Spomalené trvanie pre grow expanziu, aby bola pekne viditeľná
  
};

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
    confirmOkBtn.onclick = () => { cleanup(); resolve(true); };
    confirmCancelBtn.onclick = () => { cleanup(); resolve(false); };
  });
}

async function startDiskScan(path, totalSpace) {
  if (tickerHideTimeout) {
    clearTimeout(tickerHideTimeout);
    tickerHideTimeout = null;
  }
  if (unlistenProgress) unlistenProgress();
  if (unlistenFinished) unlistenFinished();

  document.getElementById("live-ticker-container").classList.remove("hidden");
  liveTicker.textContent = getText("scanScreen.statuses.initializingScan");

  const breadcrumbsContainer = document.getElementById("current-folder-title");
  if (breadcrumbsContainer) {
    breadcrumbsContainer.innerHTML = `<span class="breadcrumb-item active">${path}</span>`;
  }

  document.getElementById("live-ticker-bar").style.width = "0%";

  isScanning = true;
  backBtn.textContent = getText("scanScreen.cancelScan");
  backBtn.classList.add("in-cancel-mode");
  if (cancelScanBtn) cancelScanBtn.classList.add("hidden");

  const spinner = document.getElementById("scan-spinner");
  if (spinner) spinner.classList.remove("hidden");

  const statsBar = document.getElementById("scan-stats-bar");
  if (statsBar) statsBar.classList.add("hidden");

  d3.select("#sunburst-chart").selectAll("*").remove();

  // Cestu vždy držíme s forward-slash, aby sa dala ľahko porovnávať s cestami vrátenými z Rustu.
  rootPath = path.replace(/\\/g, "/");
  currentViewPath = rootPath;
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
    totalScannedBytes = currentSize;
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

  // Po skončení skenu si od Rustu pýtame podstrom pre rootPath.
  // Rust nám vráti orezaný strom, v ktorom sa drobné súbory zgrupujú do __others__.
  unlistenFinished = await listen("scan-finished", async () => {
    isScanning = false;
    backBtn.textContent = getText("scanScreen.backButton");
    backBtn.classList.remove("in-cancel-mode");

    const spinner = document.getElementById("scan-spinner");
    if (spinner) spinner.classList.add("hidden");

    liveTicker.textContent = getText("scanScreen.statuses.finished");
    document.getElementById("live-ticker-bar").style.width = "100%";

    tickerHideTimeout = setTimeout(() => {
      const tickerContainer = document.getElementById("live-ticker-container");
      if (tickerContainer) tickerContainer.classList.add("hidden");
    }, 4000);

    try {
      const rootData = await invoke("get_submenu_tree", { targetPath: rootPath });
      memoryTree = rootData;
      isFirstRenderAfterScan = true;
      currentViewPath = rootData.path || rootPath;
      drawSunburst(rootData);

      const statsBar = document.getElementById("scan-stats-bar");
      if (statsBar && rootData) {
        statsBar.textContent = getText("scanScreen.statsBar", {
          files: rootData.file_count || 0,
          dirs: rootData.dir_count || 0,
          size: formatBytes(rootData.size || 0)
        });
        statsBar.classList.remove("hidden");
      }
    } catch (err) {
      console.error("Failed to fetch subtree:", err);
      showToast(typeof err === "string" ? err : "Nepodarilo sa načítať strom.", "error");
    }

    if (unlistenProgress) unlistenProgress();
    if (unlistenFinished) unlistenFinished();
    if (unlistenFailed) unlistenFailed();
  });

  unlistenFailed = await listen("scan-failed", (event) => {
    isScanning = false;
    backBtn.textContent = getText("scanScreen.backButton");
    backBtn.classList.remove("in-cancel-mode");
    const spinner = document.getElementById("scan-spinner");
    if (spinner) spinner.classList.add("hidden");
    liveTicker.textContent = getText("scanScreen.statuses.error", { message: event.payload });
    document.getElementById("live-ticker-bar").style.width = "0%";
    if (unlistenProgress) unlistenProgress();
    if (unlistenFailed) unlistenFailed();
  });

  invoke("start_async_scan", { path });
}

async function goBackToMenu() {
  if (isScanning) {
    await invoke("cancel_scan").catch(console.error);
  }
  if (unlistenProgress) unlistenProgress();
  if (unlistenFinished) unlistenFinished();
  if (unlistenFailed) unlistenFailed();
  d3.select("#sunburst-chart").selectAll("*").remove();
  rootNode = null;
  gPartition = null;
  currentFocus = null;
  memoryTree = null;
  currentViewPath = "";
  rootPath = "";

  const mainContainers = ["sunburst-chart", "current-folder-title", "live-ticker"];
  mainContainers.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  });

  // 1. Vyčistíme backend pamäť (Rust)
  await invoke("clear_scan_state").catch(console.error);

  // 2. Prikážeme WebView uvoľniť systémovú cache a pamäť
  await invoke("optimize_webview_memory").catch(console.error);

  setTimeout(() => {
    window.location.replace("index.html");
  }, 100);
}

function updateCenterHUD(icon, name, size) {
  centerIcon.textContent = icon;
  centerName.textContent = name;
  centerSize.textContent = size;
}

function updateBreadcrumbs(currentPath) {
  const container = document.getElementById("current-folder-title");
  if (!container) return;
  container.innerHTML = "";

  if (!currentPath) return;

  const separator = currentPath.includes('\\') ? '\\' : '/';
  const segments = currentPath.split(separator).filter(s => s);

  let builtPath = "";

  segments.forEach((segment, index) => {
    if (index === 0 && segments.length > 1) {
      builtPath = segment.endsWith(':') ? segment + separator : segment;
    } else if (index > 0) {
      builtPath += (builtPath.endsWith(separator) ? "" : separator) + segment;
    } else {
      builtPath = segment;
    }

    const pathForAction = builtPath;
    const isLast = index === segments.length - 1;

    const item = document.createElement("span");
    item.className = `breadcrumb-item ${isLast ? "active" : ""}`;
    item.textContent = segment.endsWith(separator) ? segment.slice(0, -1) : segment;

    if (!isLast) {
      item.onclick = () => navigateToPath(pathForAction);
    }

    container.appendChild(item);

    if (!isLast) {
      const separatorEl = document.createElement("span");
      separatorEl.className = "breadcrumb-separator";
      separatorEl.textContent = " ❯ ";
      container.appendChild(separatorEl);
    }
  });
}

async function navigateToPath(targetPath) {
  if (!targetPath || targetPath === currentViewPath) return;
  try {
    const data = await invoke("get_submenu_tree", { targetPath });
    currentViewPath = data.path || targetPath;
    drawSunburst(data); // This will call updateBreadcrumbs
  } catch (err) {
    console.error("navigateToPath failed:", err);
    showToast(typeof err === "string" ? err : "Nepodarilo sa načítať priečinok.", "error");
  }
}

/** Vypýta si od Rustu nový podstrom pre daný priečinok a prekreslí D3 graf. */
async function updateSunburstForFolder(folderPath) {
  if (!folderPath) return;
  try {
    const newData = await invoke("get_submenu_tree", { targetPath: folderPath });
    currentViewPath = newData.path || folderPath;
    drawSunburst(newData); // This will call updateBreadcrumbs
  } catch (err) {
    console.error("updateSunburstForFolder failed:", err);
    showToast(typeof err === "string" ? err : "Nepodarilo sa načítať priečinok.", "error");
  }
}

function getParentPath(path) {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return null;
  return normalized.substring(0, idx);
}

function drawSunburst(data) {
  const emptyFolderMsg = document.getElementById("empty-folder-message");
  if (!data || !data.children || data.children.length === 0) {
    if (emptyFolderMsg) emptyFolderMsg.classList.remove("hidden");
    updateCenterHUD("🤷", data ? data.name : "?", getText("scanScreen.emptyFolder"));
    updateBreadcrumbs(data ? data.path : currentViewPath);
    return;
  }
  if (emptyFolderMsg) emptyFolderMsg.classList.add("hidden");

  const baseSize = 640;

  rootNode = d3.hierarchy(data)
    .sum(d => d.is_dir ? 0 : (d.size || 0))
    .sort((a, b) => {
        if (a.data.name === "__others__") return 1;
        if (b.data.name === "__others__") return -1;
        return b.value - a.value;
    });

  gPartition = d3.partition().size([2 * Math.PI, radius]);

  // Calculate the total number of descendants for the new root.
  const totalDescendants = rootNode.descendants().length;

  // Automatically toggle the performance filter if enabled.
  // This check is now performed only once when a new directory is loaded.
  if (APP_CONFIG.autoTogglePerformanceFilter) {
    if (totalDescendants >= APP_CONFIG.performanceThreshold) {
      APP_CONFIG.usePerformanceFilter = true;
    } else {
      APP_CONFIG.usePerformanceFilter = false;
    }
    if (filterToggle) filterToggle.checked = APP_CONFIG.usePerformanceFilter;
  }
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
      // Namiesto D3 zoomu ideme hore cez Rust - dynamicky načítame podstrom rodiča.
      const parentPath = getParentPath(currentViewPath);
      if (parentPath && parentPath !== currentViewPath) {
        updateSunburstForFolder(parentPath);
      }
    })
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
  updateBreadcrumbs(data.path);
}

function zoomTo(p) {
  currentFocus = p;
  const svg = d3.select("#sunburst-group");
  if (svg.empty()) return;

  const d3Center = d3.select("#d3-center-click-zone");
  if (!d3Center.empty()) {
    d3Center.style("cursor", p.parent ? "pointer" : "default");
  }

  // Zobrazenie "Hore" ikony v strede, ak existuje rodič (t. j. nie sme na root úrovni).
  const hasParent = !!getParentPath(currentViewPath);
  updateCenterHUD(hasParent ? getText("scanScreen.center.goUp") : "📁", p.data.name, formatBytes(p.value)); // Breadcrumbs are updated from drawSunburst

  const statsBar = document.getElementById("scan-stats-bar");
  if (statsBar && p.data) {
    statsBar.textContent = getText("scanScreen.statsBar", {
      files: p.data.file_count || 0,
      dirs: p.data.dir_count || 0,
      size: formatBytes(p.value || 0)
    });
  }

  if (gPartition && rootNode) {
    gPartition(rootNode);
  }

  const visibleDescendants = p.descendants().filter(d => {
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
    if (currentRelativeDepth > realMaxDepth) realMaxDepth = currentRelativeDepth;
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
    .innerRadius(d => d.innerRadius !== undefined ? d.innerRadius : getScaleY(d.depth - p.depth - 1))
    .outerRadius(d => d.outerRadius !== undefined ? d.outerRadius : getScaleY(d.depth - p.depth) - 1)
    .padAngle(d => {
      if (d.x1 - d.x0 >= 2 * Math.PI - 0.001) return 0.005;
      return 0.001;
    });

  function introArcTween(d) {
    // We are animating the end angle from the start angle to its final value.
    const targetEndAngle = Math.max(0, Math.min(2 * Math.PI, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI;
    const startAngleValue = Math.max(0, Math.min(2 * Math.PI, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI;

    // Interpolate from startAngle to targetEndAngle.
    const interpolateEndAngle = d3.interpolate(startAngleValue, targetEndAngle);

    return function(t) {
      // In each step t (from 0 to 1), return the modified object for the arc generator.
      return arc({
        ...d,
        x1: p.x0 + (interpolateEndAngle(t) / (2 * Math.PI)) * (p.x1 - p.x0),
      });
    };
  }


  function getFillColor(d) {
    // A9: VlastnĂˇ farba pre uzol "__others__"
    if (d.data.name === "__others__") {
      return "#a6a6a6";
    }
    if (d.data.is_dir) {
      const localYellowScale = d3.scaleLinear()
        .domain([0, realMaxDepth])
        .range(["#ffcc00", "#423500"]);
      return localYellowScale(d.depth - p.depth - 1);
    }
    return "#89b4fa";
  }

  function attachPathEvents(paths) {
    paths.on("mouseover", (event, d) => {
      hoverPath.textContent = d.data.path;
      hoverSize.textContent = formatBytes(d.value);
      const dirCount = d.data.dir_count || 0;
      const fileCount = d.data.file_count || 0;
      hoverStats.textContent = d.data.is_dir
        ? getText("scanScreen.stats.contains", { dirCount, fileCount })
        : getText("scanScreen.stats.fileType");
      if (d.data.name === "__others__") {
        hoverStats.textContent = getText("scanScreen.stats.otherFiles", { count: fileCount });
      }

      d3.select("#sunburst-group").selectAll("path")
        .classed("hover-active", false)
        .classed("hover-dimmed", true);
      d3.select(event.currentTarget)
        .classed("hover-active", true)
        .classed("hover-dimmed", false);
    })
      .on("mouseout", () => {
        hoverPath.textContent = getText("scanScreen.hoverPlaceholder");
        hoverSize.textContent = "";
        hoverStats.textContent = "";
        d3.select("#sunburst-group").selectAll("path")
          .classed("hover-active", false)
          .classed("hover-dimmed", false);
      })
      .on("click", (event, d) => {
        // Namiesto D3 zoomu ideme do podprieÄŤinka cez Rust - dynamicky naÄŤĂ­tame novĂ˝ podstrom.
        if (d.data.is_dir && d.data.name !== "__others__" && d.data.path) {
          updateSunburstForFolder(d.data.path);
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
  if (useAnimatedGraph && !isFirstRenderAfterScan) {
    const TRANSITION_DURATION = APP_CONFIG.transitionDuration;
    const isFiniteNode = (n) => n && Number.isFinite(n.x0) && Number.isFinite(n.x1);

    const existingPaths = svg.selectAll("path").data(visibleDescendants, d => d.data.path);

    existingPaths.exit()
      .transition()
      .duration(TRANSITION_DURATION / 2)
      .style("opacity", 0)
      .attrTween("d", function (d) {
        const oldNode = this.__arcData;
        if (!isFiniteNode(oldNode)) return () => this.getAttribute("d");
        const collapsedNode = { x0: oldNode.x0, x1: oldNode.x0, depth: 0, data: oldNode.data, value: 0 };
        try { return SunburstAnimations.arcTween(oldNode, collapsedNode, arc); } catch (err) { return () => this.getAttribute("d"); }
      })
      .remove();

    existingPaths.each(function (d) {
      const el = this;
      const oldNode = el.__arcData;
      if (!isFiniteNode(oldNode) || !isFiniteNode(d)) return;
      d3.select(el)
        .transition()
        .duration(TRANSITION_DURATION)
        .attrTween("d", function () {
          try { return SunburstAnimations.arcTween(oldNode, d, arc); } catch (err) { return () => el.getAttribute("d"); }
        })
        .attr("fill", getFillColor(d))
        .on("end", function () { el.__arcData = d; });
    });

    const newPaths = existingPaths.enter()
      .append("path")
      .attr("fill", d => getFillColor(d))
      .style("cursor", "pointer")
      .style("opacity", 0)
      .each(function (d) {
        try {
          this.__arcData = d;
          d3.select(this).attr("d", arc(d));
        } catch (err) {
          if (!this.__arcErrorLogged) {
            console.warn("Sunburst: failed to render initial arc for", d?.data?.path, err);
            this.__arcErrorLogged = true;
          }
        }
      });

    newPaths.transition()
      .duration(TRANSITION_DURATION)
      .style("opacity", 1)
      .attrTween("d", function (d) {
        const oldNode = this.__arcData;
        if (!isFiniteNode(oldNode) || !isFiniteNode(d)) return () => this.getAttribute("d");
        try { return SunburstAnimations.arcTween(oldNode, d, arc); } catch (err) { return () => this.getAttribute("d"); }
      })
      .on("end", function (d) { this.__arcData = d; });

    const allPaths = existingPaths.merge(newPaths);
    attachPathEvents(allPaths);
  } else {
    // Statický režim vykreslenia bez permanentných animácií
    svg.selectAll("path").remove();
    const paths = svg
      .selectAll("path")
      .data(visibleDescendants, d => d.data.path)
      .join("path")
      .attr("fill", d => getFillColor(d))
      .style("cursor", "pointer");

    // Kontrola, či ide o prvý úvodný render po dokončení skenu
    if (isFirstRenderAfterScan && APP_CONFIG.introAnimationType !== "none") {
      // Dočasne zablokujeme klikanie počas animácie
      paths.style("pointer-events", "none");

      // Výber animácie (podpora pre "random")
      let activeAnimation = APP_CONFIG.introAnimationType;
      if (activeAnimation === "random") {
        const pool = ["sweep", "grow", "staggered"];
        activeAnimation = pool[Math.floor(Math.random() * pool.length)];
      }

      // Nastavenie špecifických parametrov pre typ animácie
      let duration = APP_CONFIG.introSweepDuration;
      let easing = d3.easeCubicOut;

      if (activeAnimation === "grow") {
        duration = APP_CONFIG.introGrowDuration; // Výrazne pomalšie pre lepší zážitok
        easing = d3.easeCubicInOut; // Plynulý rozbeh aj dobeh
      }

      const introTransition = paths.transition()
        .duration(duration)
        .ease(easing);

      // Ak je zvolený 'staggered' efekt, pridáme oneskorenie podľa hĺbky uzla
      if (activeAnimation === "staggered") {
        introTransition.delay(d => (d.depth - p.depth) * 100);
      }

      introTransition.attrTween("d", d => {
        if (activeAnimation === "grow") {
          // Vypočítame cieľové polomery a odovzdáme ich growTween funkcii
          const targetInnerRadius = arc.innerRadius()(d);
          const targetOuterRadius = arc.outerRadius()(d);
          return SunburstAnimations.growTween(d, targetInnerRadius, targetOuterRadius, arc);
        } else {
          // Pre 'sweep' a 'staggered' použijeme vejarový efekt
          return SunburstAnimations.sweepTween(d, p, arc);
        }
      })
        .on("end", function () {
          d3.select(this).style("pointer-events", "auto");
        });

      // Resetujeme vlajku prvého renderu
      isFirstRenderAfterScan = false;
    } else {
      // Bežné okamžité vykreslenie bez efektu
      paths.attr("d", d => { try { return arc(d); } catch { return null; } });
    }
    attachPathEvents(paths);
  }
}

window.addEventListener("click", () => {
  if (contextMenu) contextMenu.classList.add("hidden");
});

window.addEventListener("DOMContentLoaded", async () => {
  await loadTranslations();

  const urlParams = new URLSearchParams(window.location.search);
  const pathToScan = urlParams.get('path');
  const totalSpace = urlParams.get('totalSpace') || 0;

  if (pathToScan) {
    startDiskScan(pathToScan, parseInt(totalSpace, 10));
  } else {
    console.error("No path to scan provided in URL.");
    liveTicker.textContent = getText("scanScreen.statuses.error", { message: "No path specified." });
  }

  if (filterToggle) {
    filterToggle.addEventListener("change", (event) => {
      APP_CONFIG.usePerformanceFilter = event.target.checked;
      if (currentFocus) zoomTo(currentFocus);
    });
  }

  const animationToggle = document.getElementById("animation-toggle");
  if (animationToggle) {
    const savedAnimationState = localStorage.getItem("disk-scanner-animation");
    if (savedAnimationState === "true") {
      animationToggle.checked = true;
      useAnimatedGraph = true;
    }
    animationToggle.addEventListener("change", (event) => {
      useAnimatedGraph = event.target.checked;
      localStorage.setItem("disk-scanner-animation", useAnimatedGraph);
      if (currentFocus) zoomTo(currentFocus);
    });
  }

  backBtn.addEventListener("click", goBackToMenu);
  if (cancelScanBtn) cancelScanBtn.classList.add("hidden");

  window.addEventListener("click", (event) => {
    if (event.target === confirmModal) {
      confirmModal.classList.add("hidden");
      if (confirmOkBtn) confirmOkBtn.onclick = null;
      if (confirmCancelBtn) confirmCancelBtn.onclick = null;
    }
  });

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
        try { await invoke("show_in_total_commander", { path: menuTargetNode.data.path }); }
        catch (err) { showToast(err, "error"); }
      }
    };
  }

  const cmProperties = document.getElementById("cm-properties");
  if (cmProperties) {
    cmProperties.onclick = async () => {
      if (menuTargetNode) await invoke("show_file_properties", { path: menuTargetNode.data.path });
    };
  }

  const cmCopyPath = document.getElementById("cm-copy-path");
  if (cmCopyPath) {
    cmCopyPath.onclick = async () => {
      if (menuTargetNode) {
        try { await navigator.clipboard.writeText(menuTargetNode.data.path); showToast(getText("toast.pathCopied"), "success"); }
        catch (err) { showToast(getText("toast.copyFailed"), "error"); }
      }
    };
  }

  const cmTrash = document.getElementById("cm-trash");
  if (cmTrash) {
    cmTrash.onclick = async () => {
      if (menuTargetNode) {
        const confirmed = await showConfirm(getText("confirmations.trash", { name: menuTargetNode.data.name }), false);
        if (confirmed) {
          try {
            await invoke("move_to_trash", { path: menuTargetNode.data.path });
            showToast(getText("toast.trashed", { name: menuTargetNode.data.name }), "success");
            if (menuTargetNode.parent) {
              const parentNode = menuTargetNode.parent;
              if (parentNode.data.children) {
                parentNode.data.children = parentNode.data.children.filter(c => c.path !== menuTargetNode.data.path);
              }
              if (parentNode.children) {
                parentNode.children = parentNode.children.filter(c => c.data.path !== menuTargetNode.data.path);
              }
              rootNode.sum(d => d.is_dir ? 0 : (d.size || 0)).sort((a, b) => b.value - a.value);
              if (gPartition) gPartition(rootNode);
              zoomTo(parentNode);
            } else {
              goBackToMenu();
            }
          } catch (err) { showToast(err, "error"); }
        }
      }
    };
  }

  const cmDelete = document.getElementById("cm-delete");
  if (cmDelete) {
    cmDelete.onclick = async () => {
      if (menuTargetNode) {
        const confirmed = await showConfirm(getText("confirmations.delete", { name: menuTargetNode.data.name }), true);
        if (confirmed) {
          try {
            await invoke("permanent_delete", { path: menuTargetNode.data.path });
            showToast(getText("toast.deleted", { name: menuTargetNode.data.name }), "success");
            if (menuTargetNode.parent) {
              const parentNode = menuTargetNode.parent;
              if (parentNode.data.children) {
                parentNode.data.children = parentNode.data.children.filter(c => c.path !== menuTargetNode.data.path);
              }
              if (parentNode.children) {
                parentNode.children = parentNode.children.filter(c => c.data.path !== menuTargetNode.data.path);
              }
              rootNode.sum(d => d.is_dir ? 0 : (d.size || 0)).sort((a, b) => b.value - a.value);
              if (gPartition) gPartition(rootNode);
              zoomTo(parentNode);
            } else {
              goBackToMenu();
            }
          } catch (err) { showToast(err, "error"); }
        }
      }
    };
  }

  if (isWindows) {
    const cmSetTcPath = document.createElement("div");
    cmSetTcPath.className = "menu-item";
    cmSetTcPath.id = "cm-set-tc-path";
    cmSetTcPath.setAttribute("data-i18n", "contextMenu.setTCPath");
    cmSetTcPath.textContent = getText("contextMenu.setTCPath");
    cmSetTcPath.onclick = () => { showToast(getText("tcModal.configureFromMenu"), "info"); };
    const cmDivider = contextMenu?.querySelector(".divider");
    if (cmDivider && contextMenu) contextMenu.insertBefore(cmSetTcPath, cmDivider);
  } else {
    const cmOpenTcItem = document.getElementById("cm-open-tc");
    if (cmOpenTcItem) cmOpenTcItem.style.display = "none";
  }
});