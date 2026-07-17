const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open } = window.__TAURI__.dialog;

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

/**
 * Decode a base64 string into a Uint8Array.
 */
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decompress GZip-compressed bytes using the native CompressionStream API.
 * Returns an ArrayBuffer.
 */
async function decompressGzip(compressedBytes) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(compressedBytes);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

function deserializeBinaryTree(arrayBuffer) {
  // Handle production build where data may arrive as number[] or Uint8Array
  if (!(arrayBuffer instanceof ArrayBuffer)) {
    if (arrayBuffer instanceof Uint8Array) {
      arrayBuffer = arrayBuffer.buffer;
    } else if (Array.isArray(arrayBuffer)) {
      arrayBuffer = new Uint8Array(arrayBuffer).buffer;
    } else {
      throw new Error("Invalid binary data format");
    }
  }
  const view = new DataView(arrayBuffer);
  const decoder = new TextDecoder("utf-8");
  let offset = 0;

  function readNode() {
    const isDir = view.getUint8(offset++) === 1;
    const size = Number(view.getBigUint64(offset, true));
    offset += 8;
    const dirCount = view.getUint32(offset, true);
    offset += 4;
    const fileCount = view.getUint32(offset, true);
    offset += 4;

    const nameLen = view.getUint16(offset, true);
    offset += 2;
    const nameBytes = new Uint8Array(arrayBuffer, offset, nameLen);
    const name = decoder.decode(nameBytes);
    offset += nameLen;

    const pathLen = view.getUint16(offset, true);
    offset += 2;
    const pathBytes = new Uint8Array(arrayBuffer, offset, pathLen);
    const path = decoder.decode(pathBytes);
    offset += pathLen;

    const node = {
      name,
      path,
      size,
      is_dir: isDir,
      dir_count: dirCount,
      file_count: fileCount,
      children: []
    };

    if (isDir) {
      const childrenCount = view.getUint32(offset, true);
      offset += 4;
      for (let i = 0; i < childrenCount; i++) {
        node.children.push(readNode());
      }
    }

    return node;
  }

  return readNode();
}

// Global variable for total disk capacity
let selectedDiskTotalSpace = 0;
let totalScannedBytes = 0;
let lastUpdateTime = 0;

// Global variables for proper synchronization
let memoryTree = null;
let rootPath = "";
let currentViewPath = "";
let unlistenProgress;
let unlistenFinished;
let unlistenFailed;

// Path-to-node Map for O(1) lookup
let pathIndex = null;

// Cache for collapsed views keyed by path (avoids redundant clone+collapse)
const collapsedViewCache = new Map();

// Global references for D3 nodes
let rootNode = null;
let gPartition = null;
let currentFocus = null;

// Global state for intro animation
let isFirstRenderAfterScan = false;

// Flag to prevent ResizeObserver from interrupting zoom transitions
let isZoomAnimating = false;

// OS detection
const isWindows = navigator.platform?.toLowerCase().includes("win") || navigator.userAgent?.toLowerCase().includes("windows");

let radius = 320;
let innerHoleRadius = 80;
const maxDepth = 24;
let chartResizeObserver = null;
let isResizeScheduled = false;

/**
 * Schedule a chart redraw on the next animation frame (debounced).
 * D3 radius/viewBox stays fixed (640x640) — SVG preserveAspectRatio
 * handles actual pixel scaling. This just re-runs the D3 layout
 * to ensure proper arc positioning after container size changes.
 */
/**
 * Flag to block ResizeObserver during the initial chart render.
 * Prevents a second zoomTo from interrupting the intro animation.
 */
let isChartInitializing = false;

function scheduleChartResize() {
  if (isResizeScheduled) return;
  // Block ResizeObserver during the first chart render to avoid
  // a second zoomTo that would skip the intro animation.
  if (isChartInitializing) return;
  // Block ResizeObserver during zoom transitions to prevent
  // interrupting the arc interpolation animation.
  if (isZoomAnimating) return;
  isResizeScheduled = true;
  requestAnimationFrame(() => {
    isResizeScheduled = false;
    if (currentViewPath && memoryTree) {
      navigateToPath(currentViewPath);
    } else if (currentFocus) {
      zoomTo(currentFocus);
    }
  });
}

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
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    const key = element.getAttribute("data-i18n-title");
    if (key) element.setAttribute("aria-label", getText(key));
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

async function loadSettings() {
  try {
    const savedSettings = localStorage.getItem("scanner_settings");
    if (savedSettings) {
      const parsed = JSON.parse(savedSettings);
      Object.assign(APP_CONFIG, parsed);
    }
  } catch (error) {
    console.error("Failed to load settings from localStorage", error);
  }
}

async function saveSettings() {
  try {
    localStorage.setItem("scanner_settings", JSON.stringify(APP_CONFIG));
    showToast(getText("toast.success", { message: "Nastavenia uložené." }), "success");
  } catch (error) {
    console.error("Failed to save settings to localStorage", error);
    showToast(getText("toast.error", { message: "Nepodarilo sa uložiť nastavenia." }), "error");
  }
}

const APP_CONFIG = {
  usePerformanceFilter: true,
  autoTogglePerformanceFilter: true,
  performanceThreshold: 500,
  minSizeToRender: 1 * 1024 * 1024,
  minAngleToRender: 0.01,
  totalCommanderPath: "",
  useInteractiveAnimations: true,
  introAnimationType: "sweep",
  transitionDuration: 450,
  introSweepDuration: 850,
  introGrowDuration: 400,
  introSpiralDuration: 900,
  introSequentialDuration: 1000,
  introStaggeredDuration: 950,
  relativeThreshold: 0.0015,
};

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Middle-truncate a file path: keep the beginning (drive/root) and end (filename),
 * replace the middle with a highlighted "...".
 * Returns an HTML string. If the path is not truncated, returns plain text (safe for textContent).
 */
function middleTruncatePath(path, maxLen = 80) {
  if (!path || path.length <= maxLen) return path;
  const separator = path.includes('\\') ? '\\' : '/';
  const parts = path.split(separator);
  if (parts.length <= 2) {
    return escapeHtml(path.slice(0, Math.max(20, maxLen - 3))) + '<span class="truncation-marker">...</span>';
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  const availableForMiddle = maxLen - first.length - last.length - 5; // 5 = "..." + 2 separators
  if (availableForMiddle <= 0) {
    return escapeHtml(first) + '<span class="truncation-marker">...</span>' + escapeHtml(last);
  }
  let middleParts = [];
  let middleLen = 0;
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i];
    const extra = middleLen === 0 ? part.length : part.length + 1;
    if (middleLen + extra <= availableForMiddle) {
      middleParts.push(part);
      middleLen += extra;
    } else {
      break;
    }
  }
  if (middleParts.length === 0) {
    return escapeHtml(first) + separator + '<span class="truncation-marker">...</span>' + separator + escapeHtml(last);
  }
  return escapeHtml(first) + separator + escapeHtml(middleParts.join(separator)) + separator + '<span class="truncation-marker">...</span>' + separator + escapeHtml(last);
}

/**
 * Simple HTML escape to prevent XSS in path strings.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  var a = String.fromCharCode(38);
  return str.replace(/&/g, a + 'amp;').replace(/</g, a + 'lt;').replace(/>/g, a + 'gt;').replace(/"/g, a + 'quot;');
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
    confirmOkBtn.onclick = null;
    confirmCancelBtn.onclick = null;
    function cleanup() {
      if (confirmModal.close) {
        confirmModal.close();
      }
      confirmOkBtn.onclick = null;
      confirmCancelBtn.onclick = null;
    }
    confirmOkBtn.onclick = () => { cleanup(); resolve(true); };
    confirmCancelBtn.onclick = () => { cleanup(); resolve(false); };
    confirmModal.showModal();
  });
}

async function startDiskScan(path, totalSpace) {
  if (unlistenProgress) unlistenProgress();
  if (unlistenFinished) unlistenFinished();
  document.getElementById("scan-progress-content").classList.remove("hidden");
  document.getElementById("hover-details-content").classList.add("hidden");
  liveTicker.textContent = getText("scanScreen.statuses.initializingScan");
  const breadcrumbsContainer = document.getElementById("current-folder-title");
  if (breadcrumbsContainer) {
    breadcrumbsContainer.innerHTML = `<span class="breadcrumb-item active">${path}</span>`;
  }
  document.getElementById("live-ticker-bar").style.width = "0%";
  isScanning = true;
  backBtn.textContent = getText("scanScreen.cancelScan");
  backBtn.classList.add("in-cancel-mode");
  if (cancelScanBtn) cancelScanBtn.classList.remove("hidden");
  const spinner = document.getElementById("scan-spinner");
  if (spinner) spinner.classList.remove("hidden");
  const statsBar = document.getElementById("scan-stats-bar");
  if (statsBar) statsBar.classList.add("hidden");
  d3.select("#sunburst-chart").selectAll("*").remove();
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
  unlistenFinished = await listen("scan-finished", async () => {
    isScanning = false;
    backBtn.textContent = getText("scanScreen.backButton");
    backBtn.classList.remove("in-cancel-mode");
    if (cancelScanBtn) cancelScanBtn.classList.add("hidden");
    const spinner = document.getElementById("scan-spinner");
    if (spinner) spinner.classList.add("hidden");
    document.getElementById("live-ticker-bar").style.width = "100%";
    showToast(getText("scanScreen.statuses.finished"), "success");
    document.getElementById("scan-progress-content").classList.add("hidden");
    document.getElementById("hover-details-content").classList.remove("hidden");
    try {
      // Fetch and decompress the tree: base64 -> GZip -> ArrayBuffer -> deserialize
      const encoded = await invoke("get_binary_tree");
      const compressed = base64ToUint8Array(encoded);
      const binaryBuf = await decompressGzip(compressed);
      memoryTree = deserializeBinaryTree(binaryBuf);
      // Build O(1) path index for fast node lookup
      pathIndex = new Map();
      buildPathIndex(memoryTree, pathIndex);
      // Clear any previous cache (new scan = stale data)
      collapsedViewCache.clear();
      isChartInitializing = true;
      isFirstRenderAfterScan = true;
      currentViewPath = rootPath;
      // Use navigateToPath so the intro animation plays consistently
      // (same code path as after saving settings)
      navigateToPath(rootPath);
      isChartInitializing = false;
      const statsBar = document.getElementById("scan-stats-bar");
      if (statsBar && memoryTree) {
        statsBar.textContent = getText("scanScreen.statsBar", {
          files: memoryTree.file_count || 0,
          dirs: memoryTree.dir_count || 0,
          size: formatBytes(memoryTree.size || 0)
        });
        statsBar.classList.remove("hidden");
      }
    } catch (err) {
      console.error("Failed to fetch binary tree:", err);
      const errorMsg = (typeof err === "string" ? err : (err?.message || err?.toString() || "Nepodarilo sa načítať strom."));
      showToast(errorMsg, "error");
    }
    if (unlistenProgress) unlistenProgress();
    if (unlistenFinished) unlistenFinished();
    if (unlistenFailed) unlistenFailed();
  });
  unlistenFailed = await listen("scan-failed", (event) => {
    isScanning = false;
    backBtn.textContent = getText("scanScreen.backButton");
    backBtn.classList.remove("in-cancel-mode");
    if (cancelScanBtn) cancelScanBtn.classList.add("hidden");
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
  pathIndex = null;
  collapsedViewCache.clear();
  const mainContainers = ["sunburst-chart", "current-folder-title", "live-ticker"];
  mainContainers.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  });
  await invoke("clear_scan_state").catch(console.error);
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

function getOrCreateCollapsedView(found, targetPath) {
  const cacheKey = targetPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (collapsedViewCache.has(cacheKey)) {
    return collapsedViewCache.get(cacheKey);
  }
  const cloned = structuredClone(found);
  collapseLocalJS(cloned, Math.max(cloned.size, 1));
  // Pre-build D3 hierarchy + partition and cache them together
  const hierarchy = d3.hierarchy(cloned)
    .sum(d => d.is_dir ? 0 : (d.size || 0))
    .sort((a, b) => {
      if (a.data.name === "__others__") return 1;
      if (b.data.name === "__others__") return -1;
      return b.value - a.value;
    });
  const partition = d3.partition().size([2 * Math.PI, radius]);
  hierarchy.each(d => { d.data.size = d.value; });
  partition(hierarchy);
  const entry = { raw: cloned, hierarchy, partition };
  collapsedViewCache.set(cacheKey, entry);
  return entry;
}

function navigateToPath(targetPath) {
  if (!targetPath) return;
  const found = findNodeByPath(memoryTree, targetPath);
  if (!found) {
    showToast("Priečinok '" + targetPath + "' sa nenašiel v strome.", "error");
    return;
  }
  const entry = getOrCreateCollapsedView(found, targetPath);
  currentViewPath = targetPath;
  drawSunburst(entry.hierarchy, entry.partition);
}

function updateSunburstForFolder(folderPath) {
  if (!folderPath) return;
  const found = findNodeByPath(memoryTree, folderPath);
  if (!found) {
    showToast("Priečinok '" + folderPath + "' sa nenašiel v strome.", "error");
    return;
  }
  const entry = getOrCreateCollapsedView(found, folderPath);
  currentViewPath = folderPath;
  drawSunburst(entry.hierarchy, entry.partition);
}

/**
 * Build a Map from normalized path -> node for O(1) lookup.
 * Call this once after deserializing the tree.
 */
function buildPathIndex(node, map) {
  if (!node) return;
  const normalized = node.path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  map.set(normalized, node);
  for (const child of node.children) {
    buildPathIndex(child, map);
  }
}

function findNodeByPath(node, targetPath) {
  if (!node || !targetPath) return null;
  // Use pathIndex if available (O(1) lookup)
  if (pathIndex) {
    const normalized = targetPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return pathIndex.get(normalized) || null;
  }
  // Fallback: recursive search (shouldn't happen after pathIndex is built)
  const normalizedTarget = targetPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedNode = node.path ? node.path.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  if (normalizedNode.toLowerCase() === normalizedTarget.toLowerCase()) {
    return node;
  }
  if (!node.children) return null;
  for (const child of node.children) {
    const found = findNodeByPath(child, targetPath);
    if (found) return found;
  }
  return null;
}

const OTHERS_NAME = "__others__";

function collapseLocalJS(node, parentSize) {
  if (!node.is_dir || !node.children || node.children.length === 0) return;
  for (const child of node.children) {
    collapseLocalJS(child, Math.max(node.size, 1));
  }
  const threshold = Math.max(1, parentSize * APP_CONFIG.relativeThreshold);
  let smallItemsSize = 0;
  let smallItemsFileCount = 0;
  let smallItemsDirCount = 0;
  const largeChildren = [];
  for (const child of node.children) {
    if (child.size < threshold && child.name !== OTHERS_NAME) {
      smallItemsSize += child.size;
      smallItemsFileCount += child.file_count;
      smallItemsDirCount += child.dir_count;
    } else {
      largeChildren.push(child);
    }
  }
  if (smallItemsSize > 0) {
    largeChildren.push({
      name: OTHERS_NAME,
      path: node.path + "/" + OTHERS_NAME,
      size: smallItemsSize,
      is_dir: false,
      dir_count: smallItemsDirCount,
      file_count: smallItemsFileCount,
      children: []
    });
  }
  largeChildren.sort((a, b) => {
    if (a.name === OTHERS_NAME) return 1;
    if (b.name === OTHERS_NAME) return -1;
    return b.size - a.size;
  });
  node.children = largeChildren;
}

function getParentPath(path) {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return null;
  return normalized.substring(0, idx);
}

function drawSunburst(hierarchy, partition) {
  const data = hierarchy.data;
  const emptyFolderMsg = document.getElementById("empty-folder-message");
  if (!data || !data.children || data.children.length === 0) {
    if (emptyFolderMsg) emptyFolderMsg.classList.remove("hidden");
    updateCenterHUD("🤷", data ? data.name : "?", getText("scanScreen.emptyFolder"));
    updateBreadcrumbs(data ? data.path : currentViewPath);
    return;
  }
  if (emptyFolderMsg) emptyFolderMsg.classList.add("hidden");
  const baseSize = 640;
  rootNode = hierarchy;
  gPartition = partition;
  const totalDescendants = rootNode.descendants().length;
  if (APP_CONFIG.autoTogglePerformanceFilter) {
    if (totalDescendants >= APP_CONFIG.performanceThreshold) {
      APP_CONFIG.usePerformanceFilter = true;
    } else {
      APP_CONFIG.usePerformanceFilter = false;
    }
    if (filterToggle) filterToggle.checked = APP_CONFIG.usePerformanceFilter;
  }
  currentFocus = rootNode;
  let svg;
  if (d3.select("#sunburst-chart").select("#sunburst-group").empty()) {
    d3.select("#sunburst-chart")
      .attr("viewBox", `0 0 ${baseSize} ${baseSize}`)
      .attr("width", "100%")
      .attr("height", "100%")
      .append("g")
      .attr("id", "sunburst-group")
      .attr("transform", `translate(${baseSize / 2},${baseSize / 2})`)
      .append("circle")
      .attr("r", innerHoleRadius)
      .attr("fill", "#1e1e2e")
      .attr("id", "d3-center-click-zone")
      .style("cursor", "default")
      .on("click", () => {
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
  }
  svg = d3.select("#sunburst-group");
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
  const hasParent = !!getParentPath(currentViewPath);
  updateCenterHUD(hasParent ? getText("scanScreen.center.goUp") : "📁", p.data.name, formatBytes(p.value));
  const statsBar = document.getElementById("scan-stats-bar");
  if (statsBar && p.data) {
    statsBar.textContent = getText("scanScreen.statsBar", {
      files: p.data.file_count || 0,
      dirs: p.data.dir_count || 0,
      size: formatBytes(p.value || 0)
    });
  }
  // gPartition is already computed in drawSunburst – no need to recompute here
  const visibleDescendants = p.descendants().filter(d => {
    const basicCheck = d.depth > p.depth &&
      d.depth <= p.depth + maxDepth &&
      d.value > 0 &&
      d.x1 > p.x0 && d.x0 < p.x1;
    if (!basicCheck) return false;
    if (APP_CONFIG.usePerformanceFilter) {
      const sizeCheck = d.value >= APP_CONFIG.minSizeToRender;
      const relativeAngle = ((d.x1 - d.x0) / (p.x1 - p.x0)) * 2 * Math.PI;
      if (APP_CONFIG.minAngleToRender === undefined) {
        APP_CONFIG.minAngleToRender = 0.01;
      }
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
    const targetEndAngle = Math.max(0, Math.min(2 * Math.PI, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI;
    const startAngleValue = Math.max(0, Math.min(2 * Math.PI, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI;
    const interpolateEndAngle = d3.interpolate(startAngleValue, targetEndAngle);
    return function (t) {
      return arc({
        ...d,
        x1: p.x0 + (interpolateEndAngle(t) / (2 * Math.PI)) * (p.x1 - p.x0),
      });
    };
  }

  function getFillColor(d) {
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
      const fullPath = d.data.path;
      // First set the full path via textContent (safe)
      hoverPath.textContent = fullPath;
      // Then check if it overflows the container; if so, replace with truncated HTML
      if (hoverPath.scrollWidth > hoverPath.clientWidth) {
        hoverPath.innerHTML = middleTruncatePath(fullPath);
      }
      hoverSize.textContent = formatBytes(d.value);
      const dirCount = d.data.dir_count || 0;
      const fileCount = d.data.file_count || 0;
      hoverStats.textContent = d.data.is_dir
        ? getText("scanScreen.stats.contains", { dirCount, fileCount })
        : getText("scanScreen.stats.fileType");
      if (d.data.name === "__others__") {
        hoverStats.textContent = getText("scanScreen.stats.otherFiles", { count: fileCount });
      }
      const ancestors = d.ancestors();
      const ancestorPaths = new Set(ancestors.map(node => node.data.path));
      d3.select("#sunburst-group").selectAll("path")
        .classed("hover-dimmed", node => !ancestorPaths.has(node.data.path))
        .classed("hover-active", node => node === d);
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

  if (APP_CONFIG.useInteractiveAnimations && !isFirstRenderAfterScan) {
    isZoomAnimating = true;
    const TRANSITION_DURATION = APP_CONFIG.transitionDuration;
    const oldArcData = new Map();
    svg.selectAll("path").each(function () {
      if (this.__arcData?.data?.path) {
        oldArcData.set(this.__arcData.data.path, this.__arcData);
      }
    });
    svg.selectAll("path").remove();
    const paths = svg
      .selectAll("path")
      .data(visibleDescendants, d => d.data.path)
      .join("path")
      .attr("fill", d => getFillColor(d))
      .style("cursor", "pointer")
      .each(function (d) {
        // Uložíme aj aktuálne polomery, aby boli k dispozícii pre ďalší zoom
        this.__arcData = {
          ...d,
          innerRadius: arc.innerRadius()(d),
          outerRadius: arc.outerRadius()(d)
        };
      });
    paths.each(function (d) {
      const el = this;
      const oldNode = oldArcData.get(d.data.path);
      if (oldNode) {
        d3.select(el)
          .transition()
          .duration(TRANSITION_DURATION)
          .attrTween("d", function () {
            try { return SunburstAnimations.arcTween(oldNode, d, arc); } catch { return () => arc(d); }
          })
          .attr("fill", getFillColor(d));
      } else {
        // Nové uzly: animujeme od nuly (x1 = x0, innerRadius = 0, outerRadius = 0)
        d3.select(el)
          .style("opacity", 0)
          .transition()
          .duration(TRANSITION_DURATION)
          .style("opacity", 1)
          .attrTween("d", function () {
            const startNode = {
              ...d,
              x1: d.x0,
              innerRadius: 0,
              outerRadius: 0
            };
            try { return SunburstAnimations.arcTween(startNode, d, arc); } catch { return () => arc(d); }
          });
      }
    });
    // Po uplynutí trvania animácie (+ rezerva) uvoľníme flag,
    // aby ResizeObserver mohol opäť fungovať.
    setTimeout(() => { isZoomAnimating = false; }, TRANSITION_DURATION + 50);
    attachPathEvents(paths);
  } else {
    svg.selectAll("path").remove();
    const paths = svg
      .selectAll("path")
      .data(visibleDescendants, d => d.data.path)
      .join("path")
      .attr("fill", d => getFillColor(d))
      .style("cursor", "pointer")
      .each(function (d) { this.__arcData = { ...d }; });
    if (isFirstRenderAfterScan && APP_CONFIG.introAnimationType !== "none") {
      paths.style("pointer-events", "none");
      let activeAnimation = APP_CONFIG.introAnimationType;
      if (activeAnimation === "random") {
        const pool = ["sweep", "grow", "staggered", "spiral", "sequential"];
        activeAnimation = pool[Math.floor(Math.random() * pool.length)];
      }
      let duration = APP_CONFIG.introSweepDuration;
      let easing = d3.easeCubicOut;
      if (activeAnimation === "grow") {
        duration = APP_CONFIG.introGrowDuration;
        easing = d3.easeCubicInOut;
      } else if (activeAnimation === "spiral") {
        duration = APP_CONFIG.introSpiralDuration;
        easing = d3.easeCubicIn;
      } else if (activeAnimation === "sequential") {
        duration = APP_CONFIG.introSequentialDuration;
        easing = d3.easeCubicOut;
      } else if (activeAnimation === "staggered") {
        duration = APP_CONFIG.introStaggeredDuration;
        easing = d3.easeCubicOut;
      }
      const introTransition = paths.transition()
        .duration(duration)
        .ease(easing);
      if (activeAnimation === "staggered") {
        introTransition.delay(d => (d.depth - p.depth) * 100);
      }
      const indexedDescendants = visibleDescendants.map((d, i) => ({ node: d, index: i }));
      const totalNodes = visibleDescendants.length;
      introTransition.attrTween("d", (d, i, nodes) => {
        if (activeAnimation === "grow") {
          const targetInnerRadius = arc.innerRadius()(d);
          const targetOuterRadius = arc.outerRadius()(d);
          return SunburstAnimations.growTween(d, targetInnerRadius, targetOuterRadius, arc);
        } else if (activeAnimation === "spiral") {
          return SunburstAnimations.spiralTween(d, p, arc);
        } else if (activeAnimation === "sequential") {
          const nodeIndex = nodes.indexOf(d);
          return SunburstAnimations.sequentialTween(d, p, arc, nodeIndex, totalNodes);
        } else {
          return SunburstAnimations.sweepTween(d, p, arc);
        }
      })
        .on("end", function () {
          d3.select(this).style("pointer-events", "auto");
        });
      introTransition.end().then(() => {
        isFirstRenderAfterScan = false;
      }).catch(() => {
        // If the intro transition is interrupted (e.g. by ResizeObserver
        // triggering navigateToPath mid-animation), we must still clear
        // the flag so subsequent zoom interactions animate properly.
        isFirstRenderAfterScan = false;
      });
    } else {
      paths.attr("d", d => { try { return arc(d); } catch { return null; } });
    }
    attachPathEvents(paths);
  }
}

window.addEventListener("click", () => {
  if (contextMenu) contextMenu.classList.add("hidden");
});

window.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
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
  backBtn.addEventListener("click", goBackToMenu);
  if (cancelScanBtn) {
    cancelScanBtn.classList.add("hidden");
    cancelScanBtn.addEventListener("click", () => {
      if (isScanning) {
        invoke("cancel_scan").catch(console.error);
        showToast(getText("toast.scanCancelled"), "info");
      }
      goBackToMenu();
    });
  }

  // Initialize ResizeObserver for chart responsive sizing
  const chartContainer = document.getElementById("chart-container");
  if (chartContainer && window.ResizeObserver) {
    chartResizeObserver = new ResizeObserver(() => {
      scheduleChartResize();
    });
    chartResizeObserver.observe(chartContainer);
  }

  // Settings Modal Logic
  const settingsModal = document.getElementById("settings-modal");
  const settingsBtn = document.getElementById("settings-btn");
  const settingsCloseBtn = document.getElementById("settings-close-btn");
  const settingsCancelBtn = document.getElementById("settings-cancel-btn");
  const settingsSaveBtn = document.getElementById("settings-save-btn");
  const useInteractiveAnimationsCheckbox = document.getElementById("use-interactive-animations");
  const introAnimationTypeSelect = document.getElementById("intro-animation-type");
  const transitionDurationSlider = document.getElementById("transition-duration");
  const transitionDurationValue = document.getElementById("transition-duration-value");
  const introSweepDurationSlider = document.getElementById("intro-sweep-duration");
  const introSweepDurationValue = document.getElementById("intro-sweep-duration-value");
  const introGrowDurationSlider = document.getElementById("intro-grow-duration");
  const introGrowDurationValue = document.getElementById("intro-grow-duration-value");
  const introSpiralDurationSlider = document.getElementById("intro-spiral-duration");
  const introSpiralDurationValue = document.getElementById("intro-spiral-duration-value");
  const introSequentialDurationSlider = document.getElementById("intro-sequential-duration");
  const introSequentialDurationValue = document.getElementById("intro-sequential-duration-value");
  const introStaggeredDurationSlider = document.getElementById("intro-staggered-duration");
  const introStaggeredDurationValue = document.getElementById("intro-staggered-duration-value");
  const autoToggleFilterCheckbox = document.getElementById("auto-toggle-filter");
  const performanceThresholdInput = document.getElementById("performance-threshold");
  const minSizeToRenderInput = document.getElementById("min-size-to-render");
  const minAngleSlider = document.getElementById("setting-min-angle");
  const minAngleValue = document.getElementById("min-angle-value");
  const relativeThresholdSlider = document.getElementById("setting-relative-threshold");
  const relativeThresholdValue = document.getElementById("relative-threshold-value");
  const tcPathInput = document.getElementById("tc-path-input");
  const browseTcPathBtn = document.getElementById("browse-tc-path-btn");
  const introSweepRow = document.getElementById("intro-sweep-duration-row");
  const introGrowRow = document.getElementById("intro-grow-duration-row");
  const introSpiralRow = document.getElementById("intro-spiral-duration-row");
  const introSequentialRow = document.getElementById("intro-sequential-duration-row");
  const introStaggeredRow = document.getElementById("intro-staggered-duration-row");

  function updateConditionalSettingsUI() {
    const animType = introAnimationTypeSelect.value;
    introSweepRow.style.display = animType === 'sweep' ? 'flex' : 'none';
    introGrowRow.style.display = animType === 'grow' ? 'flex' : 'none';
    introSpiralRow.style.display = animType === 'spiral' ? 'flex' : 'none';
    introSequentialRow.style.display = animType === 'sequential' ? 'flex' : 'none';
    introStaggeredRow.style.display = animType === 'staggered' ? 'flex' : 'none';
  }

  function openSettingsModal() {
    useInteractiveAnimationsCheckbox.checked = APP_CONFIG.useInteractiveAnimations;
    introAnimationTypeSelect.value = APP_CONFIG.introAnimationType;
    transitionDurationSlider.value = APP_CONFIG.transitionDuration;
    transitionDurationValue.textContent = `${APP_CONFIG.transitionDuration}ms`;
    introSweepDurationSlider.value = APP_CONFIG.introSweepDuration;
    introSweepDurationValue.textContent = `${APP_CONFIG.introSweepDuration}ms`;
    introGrowDurationSlider.value = APP_CONFIG.introGrowDuration;
    introGrowDurationValue.textContent = `${APP_CONFIG.introGrowDuration}ms`;
    introStaggeredDurationSlider.value = APP_CONFIG.introStaggeredDuration;
    introStaggeredDurationValue.textContent = `${APP_CONFIG.introStaggeredDuration}ms`;
    introSpiralDurationSlider.value = APP_CONFIG.introSpiralDuration;
    introSpiralDurationValue.textContent = `${APP_CONFIG.introSpiralDuration}ms`;
    introSequentialDurationSlider.value = APP_CONFIG.introSequentialDuration;
    introSequentialDurationValue.textContent = `${APP_CONFIG.introSequentialDuration}ms`;
    autoToggleFilterCheckbox.checked = APP_CONFIG.autoTogglePerformanceFilter;
    performanceThresholdInput.value = APP_CONFIG.performanceThreshold;
    minSizeToRenderInput.value = (APP_CONFIG.minSizeToRender / (1024 * 1024)).toFixed(1);
    minAngleSlider.value = APP_CONFIG.minAngleToRender;
    updateMinAngleLabel(APP_CONFIG.minAngleToRender);
    relativeThresholdSlider.value = APP_CONFIG.relativeThreshold;
    updateRelativeThresholdLabel(APP_CONFIG.relativeThreshold);
    tcPathInput.value = APP_CONFIG.totalCommanderPath || "";
    updateConditionalSettingsUI();
    if (settingsModal.showModal) {
      settingsModal.showModal();
    } else {
      settingsModal.classList.remove("hidden");
    }
  }

  function resetSettingsToDefaults() {
    useInteractiveAnimationsCheckbox.checked = true;
    introAnimationTypeSelect.value = "sweep";
    transitionDurationSlider.value = 450;
    transitionDurationValue.textContent = "450ms";
    introSweepDurationSlider.value = 850;
    introSweepDurationValue.textContent = "850ms";
    introGrowDurationSlider.value = 400;
    introGrowDurationValue.textContent = "400ms";
    introSpiralDurationSlider.value = 900;
    introSpiralDurationValue.textContent = "900ms";
    introSequentialDurationSlider.value = 1000;
    introSequentialDurationValue.textContent = "1000ms";
    introStaggeredDurationSlider.value = 950;
    introStaggeredDurationValue.textContent = "950ms";
    autoToggleFilterCheckbox.checked = true;
    performanceThresholdInput.value = 500;
    minSizeToRenderInput.value = "1.0";
    minAngleSlider.value = 0.01;
    updateMinAngleLabel(0.01);
    relativeThresholdSlider.value = 0.0015;
    updateRelativeThresholdLabel(0.0015);
    tcPathInput.value = "";
    updateConditionalSettingsUI();
    showToast(getText("settingsModal.reset.success"), "info");
  }

  function closeSettingsModal() {
    if (settingsModal.close) {
      settingsModal.close();
    } else {
      settingsModal.classList.add("hidden");
    }
  }

  settingsBtn.addEventListener("click", openSettingsModal);
  settingsCloseBtn.addEventListener("click", closeSettingsModal);
  settingsCancelBtn.addEventListener("click", closeSettingsModal);
  const resetSettingsBtn = document.getElementById("reset-settings-btn");
  if (resetSettingsBtn) {
    resetSettingsBtn.addEventListener("click", resetSettingsToDefaults);
  }
  settingsModal.addEventListener("click", (event) => {
    if (event.target === settingsModal) {
      closeSettingsModal();
    }
  });
  transitionDurationSlider.addEventListener("input", (event) => {
    transitionDurationValue.textContent = `${event.target.value}ms`;
  });
  introSweepDurationSlider.addEventListener("input", (event) => {
    introSweepDurationValue.textContent = `${event.target.value}ms`;
  });
  introGrowDurationSlider.addEventListener("input", (event) => {
    introGrowDurationValue.textContent = `${event.target.value}ms`;
  });
  introSpiralDurationSlider.addEventListener("input", (event) => {
    introSpiralDurationValue.textContent = `${event.target.value}ms`;
  });
  introSequentialDurationSlider.addEventListener("input", (event) => {
    introSequentialDurationValue.textContent = `${event.target.value}ms`;
  });
  introStaggeredDurationSlider.addEventListener("input", (event) => {
    introStaggeredDurationValue.textContent = `${event.target.value}ms`;
  });

  function updateMinAngleLabel(value) {
    const numValue = parseFloat(value);
    if (numValue === 0) {
      minAngleValue.textContent = getText("settingsModal.performance.minAngleToRenderOff");
    } else {
      minAngleValue.textContent = `${numValue.toFixed(3)} rad`;
    }
  }

  function updateRelativeThresholdLabel(value) {
    if (parseFloat(value) === 0) {
      relativeThresholdValue.textContent = getText("settingsModal.performance.relativeThresholdOff");
    } else {
      relativeThresholdValue.textContent = `${(value * 100).toFixed(2)}%`;
    }
  }

  minAngleSlider.addEventListener("input", (event) => updateMinAngleLabel(event.target.value));
  relativeThresholdSlider.addEventListener("input", (event) => updateRelativeThresholdLabel(event.target.value));
  introAnimationTypeSelect.addEventListener("change", updateConditionalSettingsUI);

  browseTcPathBtn.addEventListener("click", async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Executable', extensions: ['exe'] }]
    });
    if (typeof selected === 'string') {
      tcPathInput.value = selected;
    }
  });

  settingsSaveBtn.addEventListener("click", async () => {
    APP_CONFIG.useInteractiveAnimations = useInteractiveAnimationsCheckbox.checked;
    APP_CONFIG.introAnimationType = introAnimationTypeSelect.value;
    APP_CONFIG.transitionDuration = parseInt(transitionDurationSlider.value, 10);
    APP_CONFIG.introSweepDuration = parseInt(introSweepDurationSlider.value, 10);
    APP_CONFIG.introGrowDuration = parseInt(introGrowDurationSlider.value, 10);
    APP_CONFIG.introSpiralDuration = parseInt(introSpiralDurationSlider.value, 10);
    APP_CONFIG.introSequentialDuration = parseInt(introSequentialDurationSlider.value, 10);
    APP_CONFIG.introStaggeredDuration = parseInt(introStaggeredDurationSlider.value, 10);
    APP_CONFIG.autoTogglePerformanceFilter = autoToggleFilterCheckbox.checked;
    APP_CONFIG.performanceThreshold = parseInt(performanceThresholdInput.value, 10);
    APP_CONFIG.minSizeToRender = parseFloat(minSizeToRenderInput.value) * 1024 * 1024;
    APP_CONFIG.minAngleToRender = parseFloat(minAngleSlider.value);
    APP_CONFIG.relativeThreshold = parseFloat(relativeThresholdSlider.value);
    APP_CONFIG.totalCommanderPath = tcPathInput.value;
    await invoke("set_tc_path", { path: tcPathInput.value || "" });
    await saveSettings();
    // Clear cache so settings like relativeThreshold, introAnimationType take effect
    collapsedViewCache.clear();
    // Re-enable intro animation so the newly built graph plays the selected animation
    isFirstRenderAfterScan = true;
    closeSettingsModal();
    if (currentViewPath && memoryTree) {
      navigateToPath(currentViewPath);
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
  if (!isWindows) {
    const cmOpenTcItem = document.getElementById("cm-open-tc");
    if (cmOpenTcItem) cmOpenTcItem.style.display = "none";
  }
});