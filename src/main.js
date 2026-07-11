const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event; // Importujeme načúvanie udalostí

let diskScreen = document.getElementById("disk-screen");
let scanScreen = document.getElementById("scan-screen");
let diskList = document.getElementById("disk-list");
let currentFolderTitle = document.getElementById("current-folder-title");
let backBtn = document.getElementById("back-to-disks-btn");
let liveTicker = document.getElementById("live-ticker");

let hoverPath = document.getElementById("hover-path");
let hoverSize = document.getElementById("hover-size");
let hoverStats = document.getElementById("hover-stats");

let centerIcon = document.getElementById("center-icon");
let centerName = document.getElementById("center-name");
let centerSize = document.getElementById("center-size");

// Globálna databáza uzlov na live rekonštrukciu stromu
let memoryTree = {};
let rootPath = "";
let unlistenProgress;
let unlistenFinished;

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function loadDisks() {
  diskList.innerHTML = "";
  
  // Načítame disky z Rustu
  let disks = await invoke("get_disks");
  
  // ZORADENIE PODĽA ABECEDY (porovnávame mount_point, napr. C:\, D:\, E:\)
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
  currentFolderTitle.textContent = `Analýza disku: ${path}`;
  liveTicker.textContent = "Spúšťam asynchrónne vlákno...";
  
  // Reset stromu
  memoryTree = {};
  rootPath = path.replace(/\\/g, "/");

  // Vytvorenie základného root uzla v pamäti
  memoryTree[rootPath] = { name: path, path: rootPath, size: 0, is_dir: true, children: [], dir_count:0, file_count:0 };

  updateCenterHUD("📁", memoryTree[rootPath].name, "Počítam...");

// Prihlásenie sa na odber správ z Rust vlákna
  unlistenProgress = await listen("scan-progress", (event) => {
    const payload = event.payload;
    // Normalizujeme cesty, aby sme predišli problémom s miešanými lomkami
    const itemPath = payload.path.replace(/\\/g, "/");
    const parentPath = payload.parent_path ? payload.parent_path.replace(/\\/g, "/") : null;
    
    liveTicker.textContent = `Spracovávam: ${itemPath}`;

    // Uložíme uzol do pamäte
    if (!memoryTree[itemPath]) {
      memoryTree[itemPath] = { children: [] };
    }
    
    Object.assign(memoryTree[itemPath], {
      name: payload.name,
      path: itemPath,
      size: payload.size,
      is_dir: payload.is_dir,
      dir_count: payload.dir_count,
      file_count: payload.file_count
    });

    if (parentPath) {
      if (!memoryTree[parentPath]) {
        memoryTree[parentPath] = { children: [] };
      }
      // Pridáme dieťa do rodiča, len ak tam ešte nie je
      if (!memoryTree[parentPath].children.some(c => c.path === itemPath)) {
        memoryTree[parentPath].children.push(memoryTree[itemPath]);
      }
    }

    // Ak prišla udalosť pre samotný koreňový priečinok, priamo mu nastavíme jeho celkovú veľkosť.
    // Pre všetky ostatné (vnorené) priečinky prepočítame súčet pre rodiča, aby sme videli priebežný nárast.
    // OPRAVA: Už nepotrebujeme zložité prepočítavanie. Stačí zobraziť veľkosť posledného spracovaného priečinka.
    // Finálnu veľkosť nastavíme až na konci.
    updateCenterHUD("📁", payload.name, formatBytes(payload.size));
  });

  unlistenFinished = await listen("scan-finished", () => {
    liveTicker.textContent = "✅ Skenovanie dokončené úspešne.";
    if (memoryTree[rootPath]) {
      // OPRAVA: Rekurzívne poskladáme celý strom z `memoryTree` do jedného objektu.
      // Táto funkcia zaistí, že každý uzol bude mať správne vyplnené pole `children`.
      function buildHierarchy(nodePath) {
        const sourceNode = memoryTree[nodePath];
        // Vytvoríme kópiu uzla, aby sme neprepisovali pôvodné dáta v memoryTree
        const newNode = { ...sourceNode }; 
        if (sourceNode && sourceNode.children && sourceNode.children.length > 0) {
          const files = sourceNode.children.filter(c => !c.is_dir);
          const dirs = sourceNode.children.filter(c => c.is_dir);

          // Zoskupíme malé súbory pre lepšiu prehľadnosť
          const threshold = sourceNode.size * 0.001; // 0.1% prah
          let smallFilesSize = 0;
          let smallFilesCount = 0;
          const largeFiles = [];

          files.forEach(file => {
            if (file.size < threshold) {
              smallFilesSize += file.size;
              smallFilesCount++;
            } else {
              largeFiles.push(buildHierarchy(file.path));
            }
          });

          if (smallFilesCount > 0) {
            largeFiles.push({ name: `Ostatné súbory (${smallFilesCount})`, path: `${sourceNode.path}/other_files`, size: smallFilesSize, is_dir: false, children: [] });
          }

          newNode.children = [...largeFiles, ...dirs.map(childRef => buildHierarchy(childRef.path))];
        }
        return newNode;
      }
      const finalTree = buildHierarchy(rootPath);

      updateCenterHUD("📁", finalTree.name, formatBytes(finalTree.size));
      drawSunburst(finalTree);
    } else {
      liveTicker.textContent = "❌ Nepodarilo sa načítať štruktúru disku.";
    }
    if(unlistenProgress) unlistenProgress();
    if(unlistenFinished) unlistenFinished();
  });

  // Zavoláme Rust príkaz na spustenie vlákna (nečakáme naň cez await!)
  invoke("start_async_scan", { path });
}

function showDiskScreen() {
  if(unlistenProgress) unlistenProgress();
  if(unlistenFinished) unlistenFinished();
  scanScreen.classList.add("hidden");
  diskScreen.classList.remove("hidden");
  loadDisks();
}

function updateCenterHUD(icon, name, size) {
  centerIcon.textContent = icon;
  centerName.textContent = name;
  centerSize.textContent = size;
}

// ... (začiatok súboru main.js zostáva rovnaký až po funkciu drawSunburst)

// 3. Vykreslenie Sunburst grafu (Opravená hĺbka, rezy a plná responzivita)
function drawSunburst(data) {
  if (!data || !data.children || data.children.length === 0) return;
  
  const chartContainer = document.getElementById("chart-container");

  // Použijeme virtuálny súradnicový systém 600x600, SVG sa samo prispôsobí veľkosti okna!
  const baseSize = 600;
  const radius = baseSize / 2;
  const innerHoleRadius = 80; // Veľkosť stredovej diery pre HUD text
  const maxDepth = 5; // Koľko vrstiev chceme vidieť na obrazovke

  const root = d3.hierarchy(data) // Vytvoríme hierarchiu
    .sum(d => d.size) // Namiesto rekurzívneho sčítavania použijeme priamo veľkosť uzla (d.size)
    .sort((a, b) => b.value - a.value);

  const partition = d3.partition().size([2 * Math.PI, radius]);

  // OPRAVA: Prejdeme stromom a aktualizujeme `size` v pôvodných dátach (`d.data`)
  // hodnotou, ktorú vypočítalo D3 (`d.value`). Tým zaistíme konzistenciu.
  root.each(d => { d.data.size = d.value; });

  partition(root);

  let focus = root;

  // OPRAVA 1: scaleY dynamicky mapuje hĺbku voči aktuálnemu focusu.
  // Zabezpečíme, aby prvá viditeľná vrstva začínala hneď na okraji innerHoleRadius.
  function getScaleY(depth) {
    if (depth < 0) return 0;
    const availableRadius = radius - innerHoleRadius;
    const step = availableRadius / maxDepth;
    return innerHoleRadius + (depth * step);
  }

  // Generátor oblúkov berie do úvahy našu novú scaleY funkciu
  const arc = d3.arc()
    .startAngle(d => d.x0)
    .endAngle(d => d.x1)
    .innerRadius(d => getScaleY(d.depth - focus.depth))
    .outerRadius(d => getScaleY(d.depth - focus.depth + 1) - 1);

  const yellowScale = d3.scaleLinear()
    .domain([1, maxDepth + 2])
    .range(["#ffcc00", "#7a6200"]); // Pekný plynulý prechod z jasnej žltej do temnej zložkovej zlatožltej

  // OPRAVA 2: Nastavíme viewBox namiesto fixných pixelov pre automatické 4K škálovanie
  d3.select("#sunburst-chart").selectAll("*").remove(); // Vyčistíme len pred prvým kreslením
  const svg = d3.select("#sunburst-chart")
    .attr("viewBox", `0 0 ${baseSize} ${baseSize}`)
    .attr("width", "100%")
    .attr("height", "100%")
    .append("g")
    .attr("id", "sunburst-group") // Pridáme ID pre ľahší výber
    .attr("transform", `translate(${radius},${radius})`);

  const path = svg.append("g")
    .selectAll("path")
    .data(root.descendants().filter(d => d.depth > 0 && d.depth <= maxDepth && d.value > 0))
    .join("path")
    .attr("fill", d => d.data.is_dir ? yellowScale(d.depth) : "#89b4fa") // Modrá pre súbory
    .attr("d", arc)
    .style("cursor", "pointer");

  // Neviditeľný stredový kruh pre klikanie "Hore"
  const centerClickTarget = svg.append("circle")
    .attr("r", innerHoleRadius)
    .attr("fill", "#1e1e2e")
    .style("pointer-events", "auto")
    .style("cursor", focus.parent ? "pointer" : "default")
    .on("click", () => {
      if (focus.parent) zoomTo(focus.parent);
    });

  updateCenterHUD(focus.parent ? "⬆" : "📁", focus.data.name, formatBytes(focus.value));

  // HOVER EFEKTY
  path.on("mouseover", (event, d) => {
    hoverPath.textContent = d.data.path;
    hoverSize.textContent = formatBytes(d.data.size); // Použijeme opravenú veľkosť z dát
    if (d.data.is_dir) {
      hoverStats.textContent = `Obsahuje: ${d.data.dir_count || 0} priečinkov, ${d.data.file_count || 0} súborov`;
    } else {
      hoverStats.textContent = `Typ: Súbor`;
    }
  }).on("mouseout", () => {
    hoverPath.textContent = "Ukaž myšou na priečinok...";
    hoverSize.textContent = "";
    hoverStats.textContent = "";
  });

  // KLIKNUTIE (ZOOM)
  path.on("click", (event, d) => {
    if (d.children && d.children.length > 0) zoomTo(d);
  });

  function zoomTo(p) {
    focus = p;
    const descendants = p.descendants();
    const visibleDescendants = descendants.filter(d => d.depth > p.depth && d.depth <= p.depth + maxDepth && d.value > 0);

    centerClickTarget.style("cursor", p.parent ? "pointer" : "default");
    updateCenterHUD(p.parent ? "⬆ Hore" : "📁", p.data.name, formatBytes(p.data.size));

    const t = svg.transition().duration(750);

    // Aktualizujeme oblúky plynulou animáciou
    const paths = svg.selectAll("path").data(visibleDescendants, d => d.data.path);

    paths
      .join(
        enter => enter.append("path") // Pri vstupe nových elementov
          .attr("fill", d => d.data.is_dir ? yellowScale(d.depth) : "#89b4fa") // Modrá pre súbory
          .style("cursor", "pointer")
          .attr("opacity", 0),
        update => update,
        exit => exit.transition(t).attr("opacity", 0).remove()
      )
      .transition(t)
      .attr("opacity", 1)
      .attrTween("d", d => () => arc(d));

    // Pre istotu znova naviažeme hover eventy na novo vytvorené elementy v grafe
    svg.selectAll("path")
      .on("mouseover", (event, d) => {
        hoverPath.textContent = d.data.path;
        hoverSize.textContent = formatBytes(d.data.size);
        hoverStats.textContent = d.data.is_dir ? `Obsahuje: ${d.data.dir_count || 0} priečinkov, ${d.data.file_count || 0} súborov` : `Typ: Súbor`; // Použijeme opravenú veľkosť z dát
      })
      .on("mouseout", () => {
        hoverPath.textContent = "Ukaž myšou na priečinok...";
        hoverSize.textContent = "";
        hoverStats.textContent = "";
      })
      .on("click", (event, d) => {
        if (d.children && d.children.length > 0) zoomTo(d);
      });
  }
}

backBtn.onclick = showDiskScreen;
window.addEventListener("DOMContentLoaded", loadDisks);