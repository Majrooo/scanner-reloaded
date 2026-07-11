const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

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

// Globálne premenné pre správnu synchronizáciu
let memoryTree = {};
let rootPath = "";
let unlistenProgress;
let unlistenFinished;

// Globálne referencie pre D3 uzly (Dôležité pre živý filter)
let rootNode = null;
let gPartition = null;
let currentFocus = null;

const radius = 300;   
const innerHoleRadius = 80;
const maxDepth = 5;

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
      <div>Využité: ${formatBytes(used)} z ${formatBytes(disk.total_space)}</div>
    `;
    card.onclick = () => startDiskScan(disk.mount_point);
    diskList.appendChild(card);
  });
}

async function startDiskScan(path) {
  diskScreen.classList.add("hidden");
  scanScreen.classList.remove("hidden");
  liveTicker.textContent = "Spúšťam asynchrónne vlákno...";
  
  // ZABRÁNENIE ZOBRAZENIU PREDDOŠLÉHO DISKU:
  // Pred spustením nového skenovania musíme odstrániť starý graf.
  // Získame SVG element pre graf
  const svg = d3.select("#sunburst-chart");
  // Vyčistíme všetok obsah vnútri SVG
  svg.selectAll("*").remove();

  memoryTree = {};
  rootPath = path.replace(/\\/g, "/");

  memoryTree[rootPath] = { name: path, path: rootPath, size: 0, is_dir: true, children: [], dir_count: 0, file_count: 0 };
  updateCenterHUD("📁", memoryTree[rootPath].name, "Počítam...");

  // Inicializujeme základný vizuálny breadcrumb, nech tam nesvieti prázdno
  const dummyRoot = d3.hierarchy(memoryTree[rootPath]);
  updateBreadcrumbs(dummyRoot);

  unlistenProgress = await listen("scan-progress", (event) => {
    const payload = event.payload;
    const pPath = payload.path.replace(/\\/g, "/");
    liveTicker.textContent = `Aktuálne: ${pPath}`;

    if (!memoryTree[pPath]) {
      memoryTree[pPath] = { children: [] };
    }
    
    Object.assign(memoryTree[pPath], {
      name: payload.name,
      path: pPath,
      size: payload.size,
      is_dir: payload.is_dir,
      dir_count: payload.dir_count,
      file_count: payload.file_count
    });

    if (payload.parent_path) {
      const parentP = payload.parent_path.replace(/\\/g, "/");
      if (!memoryTree[parentP]) {
        memoryTree[parentP] = { children: [] };
      }
      if (!memoryTree[parentP].children.some(c => c.path === pPath)) {
        memoryTree[parentP].children.push(memoryTree[pPath]);
      }
    }

    if (memoryTree[rootPath]) {
      let totalLiveSize = 0;
      for (let key in memoryTree) {
        if (memoryTree[key].is_dir === false) {
          totalLiveSize += memoryTree[key].size || 0;
        }
      }
      updateCenterHUD("📁", memoryTree[rootPath].name, formatBytes(totalLiveSize));
    }
  });

  unlistenFinished = await listen("scan-finished", () => {
    liveTicker.textContent = "✅ Skenovanie dokončené úspešne.";
    if (memoryTree[rootPath]) {
      let totalFinalSize = 0;
      for (let key in memoryTree) {
        if (memoryTree[key].is_dir === false) {
          totalFinalSize += memoryTree[key].size || 0;
        }
      }
      memoryTree[rootPath].size = totalFinalSize;
      updateCenterHUD("📁", memoryTree[rootPath].name, formatBytes(totalFinalSize));
      drawSunburst(memoryTree[rootPath]);
    } else {
      liveTicker.textContent = "❌ Nepodarilo sa načítať štruktúru disku.";
    }

    if(unlistenProgress) unlistenProgress();
    if(unlistenFinished) unlistenFinished();
  });

  invoke("start_async_scan", { path });
}

function showDiskScreen() {
  if(unlistenProgress) unlistenProgress();
  if(unlistenFinished) unlistenFinished();
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

  // Priradíme dáta priamo do globálnych premenných, ŽIADNE "const" ani "let" tu nesmie byť!
  rootNode = d3.hierarchy(data)
    .sum(d => d.is_dir ? 0 : (d.size || 0))
    .sort((a, b) => b.value - a.value);

  gPartition = d3.partition().size([2 * Math.PI, radius]);
  rootNode.each(d => { d.data.size = d.value; });
  gPartition(rootNode);

  currentFocus = rootNode;

  // Vyčistíme starý graf pred vykreslením nového
  d3.select("#sunburst-chart").selectAll("*").remove(); 
  const svg = d3.select("#sunburst-chart")
    .attr("viewBox", `0 0 ${baseSize} ${baseSize}`)
    .attr("width", "100%")
    .attr("height", "100%")
    .append("g")
    .attr("id", "sunburst-group")
    .attr("transform", `translate(${baseSize / 2},${baseSize / 2})`);

  // Pozadie stredového kruhu
  svg.append("circle")
    .attr("r", innerHoleRadius)
    .attr("fill", "#1e1e2e");

  // Vykreslíme úvodný stav
  zoomTo(rootNode);
}

// Spoločná funkcia pre vykreslenie a zoomovanie (Vytiahnutá von z drawSunburst)
function zoomTo(p) {
  currentFocus = p;
  const svg = d3.select("#sunburst-group");
  if (svg.empty()) return;

  // Aktualizácia stredového kliku a textov
  centerInfo.onclick = () => {
    if (currentFocus.parent) zoomTo(currentFocus.parent);
  };
  centerInfo.style.cursor = p.parent ? "pointer" : "default";

  updateCenterHUD(p.parent ? "⬆ Hore" : "📁", p.data.name, formatBytes(p.value));
  updateBreadcrumbs(p);

  // Živý prepočet rozloženia pred aplikáciou filtra
  if (gPartition && rootNode) {
    gPartition(rootNode);
  }

  function getScaleY(depth) {
    if (depth < 0) return 0;
    const availableRadius = radius - innerHoleRadius;
    const step = availableRadius / maxDepth;
    return innerHoleRadius + (depth * step);
  }

  const arc = d3.arc()
    .startAngle(d => Math.max(0, Math.min(2 * Math.PI, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI)
    .endAngle(d => Math.max(0, Math.min(2 * Math.PI, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI)
    .innerRadius(d => getScaleY(d.depth - p.depth - 1)) 
    .outerRadius(d => getScaleY(d.depth - p.depth) - 1);

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

  svg.selectAll("path").remove();

  const paths = svg.append("g")
    .selectAll("path")
    .data(visibleDescendants, d => d.data.path)
    .join("path")
    .attr("fill", d => d.data.is_dir ? yellowScale(d.depth - p.depth - 1) : "#89b4fa") 
    .attr("d", arc)
    .style("cursor", "pointer");

  paths.on("mouseover", (event, d) => {
      hoverPath.textContent = d.data.path;
      hoverSize.textContent = formatBytes(d.value);
      hoverStats.textContent = d.data.is_dir ? `Obsahuje: ${d.data.dir_count || 0} priečinkov, ${d.data.file_count || 0} súborov` : `Typ: Súbor`;
    })
    .on("mouseout", () => {
      hoverPath.textContent = "Ukaž myšou na priečinok...";
      hoverSize.textContent = "";
      hoverStats.textContent = "";
    })
    .on("click", (event, d) => {
      if (d.children && d.children.length > 0) {
        zoomTo(d);
      }
    });
}

// Event Listenery po načítaní DOM
window.addEventListener("DOMContentLoaded", () => {
  if (filterToggle) {
    filterToggle.addEventListener("change", (event) => {
      APP_CONFIG.usePerformanceFilter = event.target.checked;
      if (currentFocus) {
        zoomTo(currentFocus);
      }
    });
  }
  
  backBtn.onclick = showDiskScreen;
  loadDisks();
});