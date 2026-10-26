/*
 * CodeChef Clipboard Unlocker - isolated world helper
 * ---------------------------------------------------
 * CodeChef replaces navigator.clipboard and document.execCommand with stubs
 * inside the page's main world. Content scripts get their own JavaScript
 * world, so the real clipboard API is still available here.
 *
 * The main-world script uses this helper for the toolbar buttons and for
 * Alt+Shift+C / Alt+Shift+V. Normal Ctrl+C / Ctrl+V does not need it: those
 * use the trusted clipboard events and their clipboardData.
 */
(() => {
  'use strict';

  const UI_ID = 'codechef-clipboard-unlocker';
  let readWindowUntil = 0;
  let pasteWindowUntil = 0;

  function armReadWindow() {
    readWindowUntil = performance.now() + 2000;
    pasteWindowUntil = performance.now() + 2000;
  }

  function isOurPasteButton(node) {
    if (!(node instanceof Element) || !node.matches('[data-action="paste"]')) return false;
    try {
      const root = node.getRootNode();
      return !!(root && root.host && root.host.id === UI_ID);
    } catch (_) {
      return false;
    }
  }

  // Only a real click on our Paste button (or the real Alt+Shift+V shortcut)
  // may read the clipboard. Page scripts can post messages too, but they
  // cannot forge trusted input events.
  window.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted) return;
      let path = [];
      try {
        path = event.composedPath ? event.composedPath() : [];
      } catch (_) {
        path = [];
      }
      if (path.some(isOurPasteButton)) armReadWindow();
    },
    true
  );

  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.isTrusted) return;
      if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyV') {
        armReadWindow();
      }
    },
    true
  );

  function temporaryTextarea(value) {
    const textarea = document.createElement('textarea');
    textarea.value = value || '';
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.cssText =
      'position:fixed;top:-10000px;left:-10000px;width:1px;height:1px;' +
      'opacity:0;pointer-events:none;font-size:12px;';
    document.body.appendChild(textarea);
    return textarea;
  }

  function execCommandCopy(text) {
    if (!document.body || typeof document.execCommand !== 'function') return false;
    const previousFocus = document.activeElement;
    const textarea = temporaryTextarea(text);
    let ok = false;
    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    } finally {
      textarea.remove();
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try {
          previousFocus.focus({ preventScroll: true });
        } catch (_) {
          /* ignore */
        }
      }
    }
    return ok;
  }

  function execCommandPaste() {
    if (!document.body || typeof document.execCommand !== 'function') return null;
    const previousFocus = document.activeElement;
    const textarea = temporaryTextarea('');
    let text = null;
    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      if (document.execCommand('paste')) text = textarea.value;
    } catch (_) {
      text = null;
    } finally {
      textarea.remove();
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try {
          previousFocus.focus({ preventScroll: true });
        } catch (_) {
          /* ignore */
        }
      }
    }
    return text;
  }

  // Paste into whatever the page has focused. The MAIN world focuses the
  // editor's textarea first. Unlike a synthetic ClipboardEvent, this goes
  // through the browser's native paste command, so Monaco's real paste handler
  // receives it even when it ignores untrusted DOM events.
  function execCommandPasteFocused() {
    if (typeof document.execCommand !== 'function') return false;
    try {
      return !!document.execCommand('paste');
    } catch (_) {
      return false;
    }
  }

  async function writeClipboard(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
      /* fall through */
    }
    return execCommandCopy(text);
  }

  async function readClipboard() {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        return await navigator.clipboard.readText();
      }
    } catch (_) {
      /* fall through */
    }
    return execCommandPaste();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__ccClip !== 'request') return;

    const reply = { __ccClip: 'reply', id: data.id, ok: false };

    if (data.action === 'write') {
      writeClipboard(typeof data.text === 'string' ? data.text : String(data.text || ''))
        .then((ok) => {
          reply.ok = !!ok;
          window.postMessage(reply, '*');
        })
        .catch((error) => {
          reply.error = String((error && error.message) || error);
          window.postMessage(reply, '*');
        });
      return;
    }

    if (data.action === 'paste') {
      if (performance.now() > pasteWindowUntil) {
        reply.error = 'paste-not-armed';
        window.postMessage(reply, '*');
        return;
      }
      pasteWindowUntil = 0;
      reply.ok = execCommandPasteFocused();
      window.postMessage(reply, '*');
      return;
    }

    if (data.action === 'read') {
      if (performance.now() > readWindowUntil) {
        reply.error = 'read-not-armed';
        window.postMessage(reply, '*');
        return;
      }
      readWindowUntil = 0;
      // The toolbar/Alt+Shift+V flow may follow this read with the native
      // paste fallback. Give that follow-up its own short window.
      pasteWindowUntil = performance.now() + 2000;

      readClipboard()
        .then((text) => {
          if (typeof text === 'string') {
            reply.ok = true;
            reply.text = text;
          } else {
            reply.error = 'clipboard-unavailable';
          }
          window.postMessage(reply, '*');
        })
        .catch((error) => {
          reply.error = String((error && error.message) || error);
          window.postMessage(reply, '*');
        });
      return;
    }

    reply.error = 'unknown-action';
    window.postMessage(reply, '*');
  });
})();
