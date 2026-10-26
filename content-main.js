/*
 * CodeChef Clipboard Unlocker - MAIN world content script
 * ------------------------------------------------------
 * CodeChef's lab/assessment editor installs a clipboard lockdown:
 *   - a capture-phase keydown blocker on document for Ctrl+C/V/X/A
 *   - stubs for navigator.clipboard and document.execCommand
 *   - a patched EventTarget.prototype.addEventListener that drops clipboard events
 *
 * This script runs at document_start in the page's main world, before that
 * lockdown is installed. It registers its listeners with the original
 * addEventListener and performs clipboard work itself, using the trusted
 * browser copy/cut/paste events (clipboardData), which the page's stubs do
 * not affect.
 */
(() => {
  'use strict';

  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  const nativeExec = typeof document.execCommand === 'function' ? document.execCommand : null;
  const nativeClipboard = (() => {
    try {
      return navigator.clipboard || null;
    } catch (_) {
      return null;
    }
  })();
  const nativeClipboardMethods = {};
  if (nativeClipboard) {
    for (const name of ['readText', 'writeText', 'read', 'write']) {
      if (typeof nativeClipboard[name] === 'function') {
        nativeClipboardMethods[name] = nativeClipboard[name];
      }
    }
  }

  const VERSION = '1.1.8';
  const EDITOR_SELECTOR = '.ace_editor, .CodeMirror, .cm-editor, .monaco-editor';
  const UI_ID = 'codechef-clipboard-unlocker';
  const POS_KEY = 'cc-clipboard-ui-pos';
  const BLOCKED_EVENTS = new Set([
    'copy',
    'cut',
    'paste',
    'beforecopy',
    'beforecut',
    'beforepaste',
    'selectstart',
    'select',
    'dragstart',
    'drag',
    'dragenter',
    'dragover',
    'dragleave',
    'drop',
    'dragend'
  ]);
  const RELEASABLE_EVENTS = new Set([
    'keydown',
    'keyup',
    'keypress',
    'contextmenu',
    ...BLOCKED_EVENTS
  ]);

  const pending = new Map();
  const syntheticEvents = new WeakSet();
  let bridgeSeq = 0;
  let lastAdapter = null;
  let lastPastePath = '';
  let lastCopyPath = '';
  let lastCopyFolds = 0;
  let lastUnfoldPath = '';
  let ui = null;
  let toastTimer = 0;
  let refreshTimer = 0;
  let repairTimer = 0;
  let repaired = false;
  let blockersReleased = false;
  const recordedBlockers = [];

  function add(target, type, fn, options) {
    try {
      nativeAdd.call(target, type, fn, options);
    } catch (_) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * Lockdown repair
   * ------------------------------------------------------------------ *
   * CodeChef's assessment lockdown patches addEventListener so the editor
   * (VS Code / Monaco) cannot register its own clipboard, drag or context
   * menu handlers. It also stubs document.execCommand and navigator.clipboard.
   *
   * We run before the lockdown, so we can put the real APIs back as soon as
   * the page replaces them. The page's blockers are left in place for Ace
   * pages; for the VS Code editor they are released when that editor is
   * detected, because the editor needs to receive the events itself.
   */

  function isCapture(options) {
    return (
      options === true ||
      (!!options && typeof options === 'object' && options.capture === true)
    );
  }

  // Installed before CodeChef runs so the lockdown's own key registrations
  // are recorded (they are made through the native function it saved).
  function guardedAdd(type, listener, options) {
    const name = String(type).toLowerCase();
    if (!repaired && isCapture(options) && RELEASABLE_EVENTS.has(name) && recordedBlockers.length < 100) {
      recordedBlockers.push({ target: this, type: name, listener, options });
    }
    return nativeAdd.call(this, type, listener, options);
  }

  // Used while the page's lockdown is being installed. The page's Ke() runs
  // synchronously right after it replaces addEventListener. If we let its
  // patched function stay in place, it silently drops the clipboard and drag
  // listeners that the VS Code workbench registers moments later. That leaves
  // the editor with no paste handler, so the browser's native paste falls back
  // to Monaco's typing path and re-indents every line.
  //
  // Instead, keep registering with the native function during the lockdown,
  // but drop the page's global clipboard/selection/drag blockers exactly like
  // its own patch would. The editor's handlers live on its container, so they
  // are still registered and receive real and synthetic clipboard events.
  let recordingLockdown = false;
  let currentAdd = guardedAdd;
  let currentRemove = nativeRemove;

  function recordingAdd(type, listener, options) {
    const name = String(type).toLowerCase();
    if (recordingLockdown) {
      if (isGlobalTarget(this) && BLOCKED_EVENTS.has(name)) {
        return;
      }
      if (isCapture(options) && isGlobalTarget(this) && RELEASABLE_EVENTS.has(name) && recordedBlockers.length < 100) {
        recordedBlockers.push({ target: this, type: name, listener, options });
      }
    }
    return nativeAdd.call(this, type, listener, options);
  }

  function repairOtherApis() {
    repaired = true;
    try {
      EventTarget.prototype.removeEventListener = nativeRemove;
    } catch (_) {
      /* ignore */
    }
    if (nativeExec) {
      try {
        document.execCommand = nativeExec;
      } catch (_) {
        /* ignore */
      }
    }
    restoreClipboard();
  }

  function installAddAccessor() {
    try {
      Object.defineProperty(EventTarget.prototype, 'addEventListener', {
        configurable: true,
        get() {
          return currentAdd;
        },
        set(value) {
          if (value === nativeAdd || value === guardedAdd || value === recordingAdd) {
            currentAdd = value;
            return;
          }
          // The page is installing its lockdown. Switch to the recording
          // wrapper for the synchronous Ke() call, then restore the native
          // function before the editor's module loads.
          currentAdd = recordingAdd;
          recordingLockdown = true;
          repairOtherApis();
          queueMicrotask(() => {
            recordingLockdown = false;
            currentAdd = nativeAdd;
            try {
              Object.defineProperty(EventTarget.prototype, 'addEventListener', {
                configurable: true,
                writable: true,
                value: nativeAdd
              });
            } catch (_) {
              /* keep the accessor; the poll still repairs it */
            }
            repairOtherApis();
          });
        }
      });
    } catch (_) {
      EventTarget.prototype.addEventListener = guardedAdd;
    }
  }

  function installRemoveAccessor() {
    try {
      Object.defineProperty(EventTarget.prototype, 'removeEventListener', {
        configurable: true,
        get() {
          return currentRemove;
        },
        set() {
          // Ignore the page's patched removeEventListener; it would drop the
          // editor's own cleanup calls for blocked events.
          currentRemove = nativeRemove;
        }
      });
    } catch (_) {
      /* the poll still repairs it */
    }
  }

  installAddAccessor();
  installRemoveAccessor();

  function restoreClipboard() {
    let clipboard = null;
    try {
      clipboard = navigator.clipboard || null;
    } catch (_) {
      return;
    }
    if (!clipboard) return;

    for (const name of Object.keys(nativeClipboardMethods)) {
      const bound = nativeClipboardMethods[name].bind(nativeClipboard);
      try {
        clipboard[name] = bound;
      } catch (_) {
        try {
          Object.defineProperty(clipboard, name, {
            configurable: true,
            writable: true,
            value: bound
          });
        } catch (_) {
          /* the copy/paste events still work without the API */
        }
      }
    }
  }

  function repairLockdown() {
    if (repaired) return true;

    const addPatched = EventTarget.prototype.addEventListener !== guardedAdd;
    const removePatched = EventTarget.prototype.removeEventListener !== nativeRemove;
    const execPatched = !!nativeExec && document.execCommand !== nativeExec;
    if (!addPatched && !removePatched && !execPatched) return false;

    repaired = true;
    try {
      EventTarget.prototype.addEventListener = nativeAdd;
    } catch (_) {
      /* ignore */
    }
    try {
      EventTarget.prototype.removeEventListener = nativeRemove;
    } catch (_) {
      /* ignore */
    }
    if (nativeExec) {
      try {
        document.execCommand = nativeExec;
      } catch (_) {
        /* ignore */
      }
    }
    restoreClipboard();
    return true;
  }

  function watchLockdown() {
    if (repairLockdown()) {
      clearInterval(repairTimer);
      repairTimer = 0;
    }
  }

  function isGlobalTarget(target) {
    return (
      target === window ||
      target === document ||
      target === document.body ||
      target === document.documentElement
    );
  }

  // Only used for the VS Code editor. It removes the page's clipboard, drag
  // and keyboard blockers that were registered before the lockdown took over
  // addEventListener. The editor's own listeners are registered later,
  // directly with the native function, so they are never in this list.
  function releaseBlockers() {
    // Only a page that actually had the lockdown needs this. On a normal
    // (non-assessment) lab the native shortcuts already work.
    if (!repaired || blockersReleased) return;
    blockersReleased = true;

    for (const entry of recordedBlockers) {
      if (!isGlobalTarget(entry.target)) continue;
      try {
        nativeRemove.call(entry.target, entry.type, entry.listener, entry.options);
      } catch (_) {
        /* ignore */
      }
    }
    recordedBlockers.length = 0;
  }

  function isElement(value) {
    return !!value && value.nodeType === 1;
  }

  /* ------------------------------------------------------------------ *
   * Editor detection / adapters
   * ------------------------------------------------------------------ */

  function isVisible(el) {
    if (!isElement(el) || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 28) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function aceAdapter(container) {
    const editor = container.env && container.env.editor;
    if (!editor || typeof editor.getValue !== 'function' || typeof editor.insert !== 'function') {
      return null;
    }

    // CodeChef turns Ace's text drag-and-drop off. With it off, dragging a
    // selection shows the "not allowed" cursor and Ace cancels dragstart.
    try {
      if (typeof editor.getOption === 'function' && editor.getOption('dragEnabled') === false) {
        editor.setOption('dragEnabled', true);
      }
    } catch (_) {
      /* ignore */
    }

    return {
      kind: 'ace',
      container,
      manual: true,
      getValue() {
        return editor.getValue();
      },
      getSelectedText() {
        return typeof editor.getSelectedText === 'function' ? editor.getSelectedText() : '';
      },
      focus() {
        editor.focus();
      },
      selectAll() {
        editor.focus();
        editor.selectAll();
      },
      isReadOnly() {
        try {
          return typeof editor.getReadOnly === 'function' && editor.getReadOnly();
        } catch (_) {
          return false;
        }
      },
      insert(text) {
        if (this.isReadOnly()) throw new Error('read-only');
        editor.focus();
        // Same code path Ace itself uses for a normal paste. It replaces a
        // non-empty selection and records an undo step.
        editor.insert(text);
        return 'ace';
      },
      deleteSelection() {
        if (this.isReadOnly()) return;
        const range = editor.getSelectionRange();
        if (range && !range.isEmpty()) {
          editor.session.remove(range);
          editor.clearSelection();
        }
      }
    };
  }

  function cm5Adapter(container) {
    const cm = container.CodeMirror;
    if (!cm || typeof cm.getValue !== 'function') return null;

    return {
      kind: 'codemirror5',
      container,
      manual: true,
      getValue() {
        return cm.getValue();
      },
      getSelectedText() {
        return cm.getSelection() || '';
      },
      focus() {
        cm.focus();
      },
      selectAll() {
        cm.focus();
        cm.execCommand('selectAll');
      },
      isReadOnly() {
        return !!cm.getOption('readOnly');
      },
      insert(text) {
        if (this.isReadOnly()) throw new Error('read-only');
        cm.focus();
        cm.replaceSelection(text, 'end');
        return 'codemirror5';
      },
      deleteSelection() {
        if (this.isReadOnly()) return;
        cm.replaceSelection('');
      }
    };
  }

  // CodeMirror 6 does not expose its view on the DOM in a stable, public way,
  // so we let the browser handle clipboard events natively for it.
  function cm6Adapter(container) {
    const content = container.querySelector('.cm-content');
    if (!content) return null;

    return {
      kind: 'codemirror6',
      container,
      manual: false,
      getValue() {
        const lines = container.querySelectorAll('.cm-line');
        return Array.from(lines, (line) => line.textContent || '').join('\n');
      },
      getSelectedText() {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) return '';
        const anchor = selection.anchorNode;
        return anchor && container.contains(anchor) ? selection.toString() : '';
      },
      focus() {
        content.focus();
      },
      selectAll() {
        content.focus();
        document.execCommand('selectAll');
      },
      isReadOnly() {
        return content.getAttribute('contenteditable') === 'false';
      },
      insert() {
        throw new Error('unsupported');
      },
      deleteSelection() {
        throw new Error('unsupported');
      }
    };
  }
})();
