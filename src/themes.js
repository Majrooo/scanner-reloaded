/**
 * Theme system for Scanner Reloaded.
 *
 * Each theme is a set of semantic color values mapped to CSS custom properties
 * on the <html> element. The sunburst chart colors (APP_CONFIG.colors) are
 * updated separately by consumer code via `getChartColors()`.
 *
 * Custom themes can be loaded from JSON files in the `themes/` folder next to
 * the executable (see the Rust backend). Theme choice is persisted in
 * localStorage under `scanner-theme`.
 */

const THEME_STORAGE_KEY = "scanner-theme";
const DEFAULT_THEME = "dark";
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The built-in themes.
 * Each value maps a semantic key to a color.
 */
const THEME_DEFS = {
  dark: {
    name: "Dark (Catppuccin)",
    bg: "#11111b",
    surface: "#1e1e2e",
    surface2: "#181825",
    surfaceHover: "#313244",
    surfaceHoverStrong: "#585b70",
    border: "#313244",
    borderStrong: "#45475a",
    overlayCard: "#252538",
    centerHover: "#2a2a3e",
    text: "#cdd6f4",
    textMuted: "#a6adc8",
    textFaint: "#6c7086",
    textDim: "#7f849c",
    accent: "#a6e3a1",
    accentHover: "#94d68b",
    blue: "#89b4fa",
    blueHover: "#b4d0fb",
    purple: "#cba6f7",
    red: "#f38ba8",
    redHover: "#eb6f92",
    danger: "#f38ba8",
    dangerHover: "#eb6f92",
    yellow: "#f9e2af",
    chartDirShallow: "#ffcc00",
    chartDirDeep: "#423500",
    chartFile: "#89b4fa",
    chartOthers: "#585b70",
    chartSuperSmall: "#b33a4d",
  },
  light: {
    name: "Light (Catppuccin)",
    bg: "#eff1f5",
    surface: "#e6e9ef",
    surface2: "#dce0e8",
    surfaceHover: "#ccd0da",
    surfaceHoverStrong: "#bcc0cc",
    border: "#ccd0da",
    borderStrong: "#bcc0cc",
    overlayCard: "#e6e9ef",
    centerHover: "#dce0e8",
    text: "#4c4f69",
    textMuted: "#6c6f85",
    textFaint: "#9ca0b0",
    textDim: "#acb0be",
    accent: "#40a02b",
    accentHover: "#3d8f2c",
    blue: "#1e66f5",
    blueHover: "#2768eb",
    purple: "#8839ef",
    red: "#d20f39",
    redHover: "#c3132f",
    danger: "#d20f39",
    dangerHover: "#c3132f",
    yellow: "#df8e1d",
    chartDirShallow: "#f9a03f",
    chartDirDeep: "#dda348",
    chartFile: "#1e66f5",
    chartOthers: "#8c8fa1",
    chartSuperSmall: "#d20f39",
  },
  ocean: {
    name: "Ocean",
    bg: "#0d1117",
    surface: "#161b22",
    surface2: "#0f141a",
    surfaceHover: "#21262d",
    surfaceHoverStrong: "#30363d",
    border: "#21262d",
    borderStrong: "#30363d",
    overlayCard: "#21262d",
    centerHover: "#21262d",
    text: "#c9d1d9",
    textMuted: "#8b949e",
    textFaint: "#6e7681",
    textDim: "#7d8790",
    accent: "#58a6ff",
    accentHover: "#79b8ff",
    blue: "#58a6ff",
    blueHover: "#79b8ff",
    purple: "#bc8cff",
    red: "#f85149",
    redHover: "#da3633",
    danger: "#f85149",
    dangerHover: "#da3633",
    yellow: "#e3b341",
    chartDirShallow: "#58a6ff",
    chartDirDeep: "#1f6feb",
    chartFile: "#79c0ff",
    chartOthers: "#6e7681",
    chartSuperSmall: "#f85149",
  },
  forest: {
    name: "Forest",
    bg: "#0f1a12",
    surface: "#182a1c",
    surface2: "#14251a",
    surfaceHover: "#243c29",
    surfaceHoverStrong: "#2f4d35",
    border: "#243c29",
    borderStrong: "#2f4d35",
    overlayCard: "#243c29",
    centerHover: "#243c29",
    text: "#d8e5d8",
    textMuted: "#9cb29c",
    textFaint: "#6f8a6f",
    textDim: "#7d967d",
    accent: "#7ee787",
    accentHover: "#6dd37d",
    blue: "#79c0ff",
    blueHover: "#9fd3ff",
    purple: "#d2a8ff",
    red: "#ff7b72",
    redHover: "#f06a60",
    danger: "#ff7b72",
    dangerHover: "#f06a60",
    yellow: "#e3b341",
    chartDirShallow: "#7ee787",
    chartDirDeep: "#3fb950",
    chartFile: "#79c0ff",
    chartOthers: "#6f8a6f",
    chartSuperSmall: "#ff7b72",
  },
  neon: {
    name: "Neon",
    bg: "#0a0a0f",
    surface: "#14141d",
    surface2: "#0f0f16",
    surfaceHover: "#1e1e2e",
    surfaceHoverStrong: "#3a3a54",
    border: "#2a2a3e",
    borderStrong: "#3a3a54",
    overlayCard: "#1e1e2e",
    centerHover: "#2a2a3e",
    text: "#e0e0f0",
    textMuted: "#9a9abf",
    textFaint: "#6a6a8a",
    textDim: "#7a7a9a",
    accent: "#00ffc8",
    accentHover: "#00e6b4",
    blue: "#00d4ff",
    blueHover: "#33ddff",
    purple: "#ff00ff",
    red: "#ff2d78",
    redHover: "#ff4d8c",
    danger: "#ff2d78",
    dangerHover: "#ff4d8c",
    yellow: "#ffe600",
    chartDirShallow: "#00ffc8",
    chartDirDeep: "#00d4ff",
    chartFile: "#ff00ff",
    chartOthers: "#7a7a9a",
    chartSuperSmall: "#ff2d78",
  },
};

/** Maps a semantic color key to its CSS custom property name. */
const CSS_VAR_MAP = {
  bg: "--bg",
  surface: "--surface",
  surface2: "--surface-2",
  surfaceHover: "--surface-hover",
  surfaceHoverStrong: "--surface-hover-strong",
  border: "--border",
  borderStrong: "--border-strong",
  overlayCard: "--overlay-card",
  centerHover: "--center-hover",
  text: "--text",
  textMuted: "--text-muted",
  textFaint: "--text-faint",
  textDim: "--text-dim",
  accent: "--accent",
  accentHover: "--accent-hover",
  blue: "--blue",
  blueHover: "--blue-hover",
  purple: "--purple",
  red: "--red",
  redHover: "--red-hover",
  danger: "--danger",
  dangerHover: "--danger-hover",
  yellow: "--yellow",
};

let activeThemeId = DEFAULT_THEME;
let customThemes = []; // loaded from themes/*.json via the Rust backend

/** Returns the list of available theme ids (built-ins + loaded customs). */
function getAvailableThemeIds() {
  const builtins = Object.keys(THEME_DEFS);
  const customs = customThemes.map((t) => t.id);
  return [...builtins, ...customs, "system"];
}

/** Returns the display name of a theme id. */
function getThemeName(themeId) {
  if (themeId === "system") return "System";
  const custom = customThemes.find((t) => t.id === themeId);
  if (custom) return custom.name || themeId;
  const def = THEME_DEFS[themeId];
  return def ? def.name : themeId;
}

/**
 * Resolves a theme id to a concrete theme definition.
 * "system" resolves to dark or light based on prefers-color-scheme.
 */
function resolveTheme(themeId) {
  if (themeId === "system") {
    const dark = window.matchMedia
      ? window.matchMedia(SYSTEM_DARK_QUERY).matches
      : true;
    return resolveTheme(dark ? "dark" : "light");
  }
  const custom = customThemes.find((t) => t.id === themeId);
  if (custom) return custom;
  return THEME_DEFS[themeId] || THEME_DEFS[DEFAULT_THEME];
}

/** Applies a theme id to the document by setting CSS custom properties. */
function applyTheme(themeId) {
  const def = resolveTheme(themeId);
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
    if (def[key] !== undefined) {
      root.style.setProperty(cssVar, def[key]);
    }
  }
  // Chart colors are exposed so scanner.js can sync APP_CONFIG.colors.
  activeThemeId = themeId;
  document.documentElement.setAttribute("data-theme", themeId === "system" ? activeThemeId : themeId);
  window.dispatchEvent(new CustomEvent("theme-changed", { detail: { themeId, colors: getChartColors() } }));
}

/** Returns the chart color map for the active theme (for APP_CONFIG.colors). */
function getChartColors() {
  const def = resolveTheme(activeThemeId);
  return {
    dirShallow: def.chartDirShallow,
    dirDeep: def.chartDirDeep,
    file: def.chartFile,
    others: def.chartOthers,
    superSmall: def.chartSuperSmall,
  };
}

/** Returns the currently selected theme id (may be "system"). */
function getActiveThemeId() {
  return activeThemeId;
}

/** Persists and applies the selected theme id. */
function setTheme(themeId) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeId);
  } catch (e) {
    /* ignore storage errors */
  }
  applyTheme(themeId);
}

/** Loads the persisted theme (or default) and applies it. */
function initTheme() {
  let saved = DEFAULT_THEME;
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored && (getAvailableThemeIds().includes(stored) || customThemes.some((t) => t.id === stored))) {
      saved = stored;
    }
  } catch (e) {
    /* ignore */
  }
  activeThemeId = saved;
  applyTheme(saved);

  // Follow system theme changes live when in "system" mode.
  if (window.matchMedia) {
    window.matchMedia(SYSTEM_DARK_QUERY).addEventListener("change", (e) => {
      if (getActiveThemeId() === "system") {
        applyTheme("system");
      }
    });
  }
}

/** Sets the list of custom themes loaded from the themes/ folder. */
function setCustomThemes(themes) {
  customThemes = Array.isArray(themes) ? themes : [];
}

/** Registers custom themes from the Rust backend and re-applies if needed. */
async function loadCustomThemeFiles() {
  try {
    if (!window.__TAURI__) return;
    const result = await window.__TAURI__.core.invoke("list_themes");
    if (Array.isArray(result)) {
      setCustomThemes(result);
      // Re-apply in case the persisted id is a custom theme.
      applyTheme(activeThemeId);
    }
  } catch (e) {
    console.warn("Failed to load custom themes:", e);
  }
}

// Public API
window.Themes = {
  getAvailableThemeIds,
  getThemeName,
  getActiveThemeId,
  setTheme,
  initTheme,
  getChartColors,
  resolveTheme,
  setCustomThemes,
  loadCustomThemeFiles,
};