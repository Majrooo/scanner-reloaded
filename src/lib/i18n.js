/**
 * Zdieľaný i18n modul pre preklady.
 * Načíta translations.json a poskytuje funkcie getText(), applyTranslations(), loadTranslations().
 */

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
    console.error("Failed to load translations:", error);
  }
}

function setLanguage(lang) {
  if (translationsData && translationsData.languages?.[lang]) {
    currentLanguage = lang;
    localStorage.setItem("disk-scanner-language", currentLanguage);
    applyTranslations();
  }
}

function getCurrentLanguage() {
  return currentLanguage;
}

function getAvailableLanguages() {
  return translationsData ? Object.keys(translationsData.languages || {}) : [];
}

function getTranslationsData() {
  return translationsData;
}

// Export for use in other modules
window.I18n = {
  getText,
  applyTranslations,
  loadTranslations,
  setLanguage,
  getCurrentLanguage,
  getAvailableLanguages,
  getTranslationsData,
};