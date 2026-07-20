/**
 * Zdieľané utility funkcie pre Scanner Reloaded.
 * Formátovanie veľkostí, HTML escape, truncácia ciest, toast notifikácie.
 */

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Jednoduchý HTML escape na prevenciu XSS v path stringoch.
 * Používa String.fromCharCode(38) namiesto priameho '&' aby sa zabránilo
 * formátovačom/syntax highlighterom konvertovať '&' späť na '&'.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  var a = String.fromCharCode(38);
  return str.replace(/&/g, a + 'amp;').replace(/</g, a + 'lt;').replace(/>/g, a + 'gt;').replace(/"/g, a + 'quot;');
}

/**
 * Middle-truncate file path: zachová začiatok (disk/root) a koniec (názov súboru),
 * nahradí stred zvýrazneným "...".
 * Vracia HTML string. Ak cesta nie je skrátená, vracia plain text (bezpečný pre textContent).
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
 * Extrahuje používateľsky čitateľnú chybovú správu z rôznych typov err objektov.
 * @param {*} err - Chybový objekt (string, Error, Tauri error, ...)
 * @param {string} [fallbackKey] - Voliteľný prekladový kľúč, ak err nemá správu
 * @returns {string} Čitateľná chybová správa
 */
function extractErrorMessage(err, fallbackKey) {
  if (typeof err === 'string') return err;
  if (err && err.userMessage) return err.userMessage;
  if (err && err.message) return err.message;
  if (err && typeof err.toString === 'function' && err.toString() !== '[object Object]') return err.toString();
  return fallbackKey || 'Neznáma chyba';
}

/**
 * Zavolá Tauri invoke s timeoutom. Ak operácia trvá dlhšie ako timeoutMs,
 * promise sa rejectne s chybou 'IPC_TIMEOUT:<nazov_komandy>'.
 * @param {string} command - názov Tauri commandy
 * @param {object} [args={}] - argumenty pre commandu
 * @param {number} timeoutMs - timeout v milisekundách
 * @returns {Promise<any>}
 */
function invokeWithTimeout(command, args = {}, timeoutMs) {
  const { invoke } = window.__TAURI__.core;
  return Promise.race([
    invoke(command, args),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('IPC_TIMEOUT:' + command)), timeoutMs)
    )
  ]);
}

function showToast(message, type = "info", duration = 4000) {
  const toastContainer = document.getElementById("toast-container");
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

// Export for use in other modules
window.Utils = {
  formatBytes,
  escapeHtml,
  middleTruncatePath,
  extractErrorMessage,
  invokeWithTimeout,
  showToast,
};
