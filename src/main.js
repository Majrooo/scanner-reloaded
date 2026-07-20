/**
 * Centrálny error handler pre Scanner Reloaded.
 * Odchytáva neodchytené výnimky a unhandled Promise rejections,
 * zobrazuje ich používateľovi cez toast namiesto tichého zlyhania.
 */

(function () {
  let isHandlingError = false;

  /**
   * Vráti používateľsky čitateľnú správu z ľubovoľného error objektu.
   * Volá Utils.extractErrorMessage ak je k dispozícii, inak fallback.
   */
  function getErrorMessage(err) {
    if (typeof err === 'string') return err;
    if (err && err.userMessage) return err.userMessage;
    if (err && err.message) return err.message;
    if (err && typeof err.toString === 'function' && err.toString() !== '[object Object]') return err.toString();
    return null;
  }

  function handleGlobalError(message, source, line, col, error) {
    if (isHandlingError) return;
    isHandlingError = true;
    try {
      var detail = getErrorMessage(error) || message || 'Neznáma chyba';
      console.error('[GLOBAL ERROR]', detail, source ? '(' + source + ':' + line + ':' + col + ')' : '', error || '');
      if (typeof Utils !== 'undefined' && Utils.showToast) {
        var toastMsg = detail;
        // Skús lokalizáciu ak je I18n k dispozícii
        try {
          if (typeof I18n !== 'undefined' && I18n.getText) {
            toastMsg = I18n.getText('errors.unexpected', { message: detail });
          }
        } catch (_) { /* ignore */ }
        Utils.showToast(toastMsg, 'error', 6000);
      }
    } finally {
      isHandlingError = false;
    }
  }

  function handleUnhandledRejection(event) {
    if (isHandlingError) return;
    isHandlingError = true;
    try {
      var reason = event.reason;
      var detail = getErrorMessage(reason) || 'Unhandled Promise rejection';
      console.error('[UNHANDLED REJECTION]', detail, reason || '');
      if (typeof Utils !== 'undefined' && Utils.showToast) {
        var toastMsg = detail;
        try {
          if (typeof I18n !== 'undefined' && I18n.getText) {
            toastMsg = I18n.getText('errors.unexpected', { message: detail });
          }
        } catch (_) { /* ignore */ }
        Utils.showToast(toastMsg, 'error', 6000);
      }
    } finally {
      isHandlingError = false;
    }
  }

  window.addEventListener('error', handleGlobalError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);
})();