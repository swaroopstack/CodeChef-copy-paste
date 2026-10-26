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

  function monacoAdapter(container) {
    const monaco = window.monaco;
    if (!monaco || !monaco.editor || typeof monaco.editor.getEditors !== 'function') return null;

    let editors = [];
    try {
      editors = monaco.editor.getEditors();
    } catch (_) {
      return null;
    }

    const editor =
      editors.find((candidate) => {
        try {
          const dom = candidate.getDomNode && candidate.getDomNode();
          return !!dom && (dom === container || container.contains(dom) || dom.contains(container));
        } catch (_) {
          return false;
        }
      }) || (editors.length === 1 ? editors[0] : null);

    if (!editor || typeof editor.getValue !== 'function') return null;

    return {
      kind: 'monaco',
      container,
      manual: true,
      getValue() {
        return editor.getValue();
      },
      getSelectedText() {
        try {
          const model = editor.getModel();
          const selection = editor.getSelection();
          return model && selection ? model.getValueInRange(selection) || '' : '';
        } catch (_) {
          return '';
        }
      },
      focus() {
        editor.focus();
      },
      selectAll() {
        const model = editor.getModel();
        if (!model) return;
        editor.setSelection(model.getFullModelRange());
        editor.focus();
      },
      isReadOnly() {
        try {
          const option = monaco.editor.EditorOption && monaco.editor.EditorOption.readOnly;
          return option !== undefined ? !!editor.getOption(option) : false;
        } catch (_) {
          return false;
        }
      },
      insert(text) {
        if (this.isReadOnly()) throw new Error('read-only');
        const selection = editor.getSelection();
        if (!selection) throw new Error('no selection');
        editor.executeEdits('codechef-clipboard', [
          { range: selection, text, forceMoveMarkers: true }
        ]);
        editor.focus();
        return 'monaco';
      },
      deleteSelection() {
        if (this.isReadOnly()) return;
        const selection = editor.getSelection();
        if (selection) {
          editor.executeEdits('codechef-clipboard', [
            { range: selection, text: '', forceMoveMarkers: true }
          ]);
        }
      }
    };
  }
  // VS Code's web workbench (used by CodeChef's assessment lab) embeds Monaco
  // but does not expose window.monaco. It does expose the workbench instance
  // as window.workbench, and that instance holds the DI service collection.
  // Find the code editor service in it and insert through executeEdits. That
  // is a direct model edit: it bypasses Monaco's typing path (which auto-
  // indents after `{`), the paste path's indentation normalization, and any
  // workbench paste listener that might rewrite the block.
  let workbenchServiceCache = null;
  let workbenchMissUntil = 0;

  function isCodeEditorService(value) {
    return !!(
      value &&
      (typeof value.getFocusedCodeEditor === 'function' ||
        typeof value.getActiveCodeEditor === 'function' ||
        typeof value.listCodeEditors === 'function')
    );
  }

  function collectServiceMaps(root) {
    const maps = [];
    const seen = new Set();

    const visit = (obj, depth) => {
      if (!obj || depth > 1 || seen.has(obj)) return;
      if (typeof obj !== 'object' && typeof obj !== 'function') return;
      seen.add(obj);

      if (obj instanceof Map) {
        maps.push(obj);
        return;
      }

      let names;
      try {
        names = Object.getOwnPropertyNames(obj);
      } catch (_) {
        return;
      }

      for (const name of names) {
        if (
          name === 'window' ||
          name === 'document' ||
          name === 'parent' ||
          name === 'top' ||
          name === 'self' ||
          name === 'ownerDocument' ||
          name === 'location' ||
          name === 'constructor' ||
          name === 'prototype'
        ) {
          continue;
        }
        let value;
        try {
          value = obj[name];
        } catch (_) {
          continue;
        }
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
        if (typeof Node !== 'undefined' && value instanceof Node) continue;
        if (value instanceof Map) {
          maps.push(value);
          continue;
        }
        if (depth < 1) visit(value, depth + 1);
      }
    };

    visit(root, 0);
    return maps;
  }

  function findServiceInObject(root, maxDepth) {
    const seen = new Set();
    const queue = [{ value: root, depth: 0 }];
    const skip = new Set([
      'window',
      'document',
      'parent',
      'top',
      'self',
      'ownerDocument',
      'location',
      'constructor',
      'prototype'
    ]);

    while (queue.length && seen.size < 800) {
      const item = queue.shift();
      const value = item.value;
      const depth = item.depth;
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
      if (seen.has(value)) continue;
      seen.add(value);

      if (isCodeEditorService(value)) return value;
      if (typeof value === 'function') continue;
      if (typeof Node !== 'undefined' && value instanceof Node) continue;

      if (value instanceof Map || value instanceof Set) {
        try {
          for (const entry of value.values()) {
            queue.push({ value: entry, depth: depth + 1 });
          }
        } catch (_) {
          /* ignore */
        }
        continue;
      }

      if (depth >= maxDepth) continue;

      let names;
      try {
        names = Object.getOwnPropertyNames(value);
      } catch (_) {
        continue;
      }
      for (const name of names) {
        if (skip.has(name)) continue;
        let child;
        try {
          child = value[name];
        } catch (_) {
          continue;
        }
        if (!child || (typeof child !== 'object' && typeof child !== 'function')) continue;
        queue.push({ value: child, depth: depth + 1 });
      }
    }
    return null;
  }

  function findWorkbenchEditorService() {
    const workbench = window.workbench;
    if (!workbench) return null;
    if (workbenchServiceCache && workbenchServiceCache.workbench === workbench) {
      return workbenchServiceCache.service;
    }
    if (workbenchMissUntil && Date.now() < workbenchMissUntil) return null;

    const roots = [];
    for (const key of ['hc', 'serviceCollection', 'services', 'container', 'di']) {
      let value;
      try {
        value = workbench[key];
      } catch (_) {
        value = null;
      }
      if (value) roots.push(value);
    }
    roots.push(workbench);

    let service = null;
    for (const root of roots) {
      if (isCodeEditorService(root)) {
        service = root;
        break;
      }

      const maps = collectServiceMaps(root);
      for (const map of maps) {
        try {
          for (const value of map.values()) {
            if (isCodeEditorService(value)) {
              service = value;
              break;
            }
          }
        } catch (_) {
          /* ignore */
        }
        if (service) break;
      }
      if (service) break;

      // Some collections keep SyncDescriptors in the map. Resolve the tokens
      // so a not-yet-instantiated service can still be found.
      if (typeof root.get === 'function') {
        for (const map of maps) {
          let keys;
          try {
            keys = Array.from(map.keys());
          } catch (_) {
            keys = [];
          }
          for (const key of keys) {
            let value;
            try {
              value = root.get(key);
            } catch (_) {
              continue;
            }
            if (isCodeEditorService(value)) {
              service = value;
              break;
            }
          }
          if (service) break;
        }
      }
      if (service) break;
    }

    // Last resort for a workbench build whose service collection is not a
    // plain Map under one of the names above. This is a bounded graph walk,
    // not a general object crawl.
    if (!service) {
      service = findServiceInObject(workbench, 3);
    }

    // Only cache a hit. The workbench may still be starting up when the first
    // adapter is created; a cached miss would permanently pin the extension to
    // the DOM fallback. Retry a miss after a short delay instead of walking the
    // workbench graph on every toolbar refresh.
    if (service) {
      workbenchServiceCache = { workbench, service };
      workbenchMissUntil = 0;
    } else {
      workbenchServiceCache = null;
      workbenchMissUntil = Date.now() + 2000;
    }
    return service;
  }

  function workbenchEditorFor(container, service) {
    if (!service) return null;

    const candidates = [];
    const add = (editor) => {
      if (editor && candidates.indexOf(editor) === -1) candidates.push(editor);
    };

    try {
      if (typeof service.getFocusedCodeEditor === 'function') {
        add(service.getFocusedCodeEditor());
      }
    } catch (_) {
      /* ignore */
    }
    try {
      if (typeof service.getActiveCodeEditor === 'function') {
        add(service.getActiveCodeEditor());
      }
    } catch (_) {
      /* ignore */
    }
    try {
      if (typeof service.listCodeEditors === 'function') {
        for (const editor of service.listCodeEditors()) add(editor);
      }
    } catch (_) {
      /* ignore */
    }

    for (let editor of candidates) {
      if (typeof editor.getModifiedEditor === 'function') {
        try {
          editor = editor.getModifiedEditor() || editor;
        } catch (_) {
          /* ignore */
        }
      }
      if (!editor || typeof editor.getModel !== 'function' || typeof editor.executeEdits !== 'function') {
        continue;
      }
      let dom = null;
      try {
        dom = editor.getDomNode && editor.getDomNode();
      } catch (_) {
        dom = null;
      }
      if (dom && (dom === container || container.contains(dom) || dom.contains(container))) {
        return editor;
      }
    }
    return null;
  }

  function workbenchAdapter(container) {
    const service = findWorkbenchEditorService();
    const editor = workbenchEditorFor(container, service);
    if (!editor) return null;

    const model = () => {
      try {
        return editor.getModel();
      } catch (_) {
        return null;
      }
    };

    const selection = () => {
      try {
        return editor.getSelection();
      } catch (_) {
        return null;
      }
    };

    const isEmptyRange = (range) => {
      if (!range) return true;
      if (typeof range.isEmpty === 'function') return range.isEmpty();
      return (
        range.startLineNumber === range.endLineNumber &&
        range.startColumn === range.endColumn
      );
    };

    const insertRange = () => {
      const selected = selection();
      if (selected) return selected;

      let position = null;
      try {
        position = editor.getPosition && editor.getPosition();
      } catch (_) {
        position = null;
      }
      if (position) {
        return {
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        };
      }

      // Never replace the whole file just because the cursor could not be
      // read. Insert at the very start instead; the caller can still ask for
      // Ctrl+V if this is not the right place.
      const textModel = model();
      if (!textModel) return null;
      const full = textModel.getFullModelRange();
      return {
        startLineNumber: full.startLineNumber,
        startColumn: full.startColumn,
        endLineNumber: full.startLineNumber,
        endColumn: full.startColumn
      };
    };

    return {
      kind: 'monaco-workbench',
      container,
      manual: true,
      getValue() {
        try {
          return editor.getValue() || '';
        } catch (_) {
          return '';
        }
      },
      getSelectedText() {
        const selected = selection();
        const textModel = model();
        if (!selected || !textModel || isEmptyRange(selected)) return '';
        try {
          return textModel.getValueInRange(selected) || '';
        } catch (_) {
          return '';
        }
      },
      focus() {
        try {
          editor.focus();
        } catch (_) {
          /* ignore */
        }
      },
      selectAll() {
        const textModel = model();
        if (!textModel) return;
        try {
          editor.setSelection(textModel.getFullModelRange());
          editor.focus();
        } catch (_) {
          /* ignore */
        }
      },
      isReadOnly() {
        try {
          const raw = editor.getRawOptions && editor.getRawOptions();
          if (raw && typeof raw.readOnly === 'boolean') return raw.readOnly;
          // EditorOption.readOnly is 94 in this Monaco build.
          if (typeof editor.getOption === 'function' && editor.getOption(94)) return true;
        } catch (_) {
          /* ignore */
        }
        return false;
      },
      paste(text) {
        if (!text || this.isReadOnly()) return '';
        const range = insertRange();
        if (!range) return '';

        const textModel = model();
        let originalText = '';
        if (textModel) {
          try {
            originalText = textModel.getValueInRange(range) || '';
          } catch (_) {
            originalText = '';
          }
        }

        try {
          if (typeof editor.pushUndoStop === 'function') editor.pushUndoStop();
          const applied = editor.executeEdits('codechef-clipboard', [
            { range, text, forceMoveMarkers: true }
          ]);
          if (typeof editor.popUndoStop === 'function') editor.popUndoStop();
          if (applied === false) return '';

          // executeEdits is a direct model edit and should be verbatim. Verify
          // that this workbench build did not transform the text. If it did,
          // restore the original selection instead of leaving a corrupted
          // brace block behind.
          if (textModel) {
            let startOffset = null;
            try {
              startOffset = textModel.getOffsetAt({
                lineNumber: range.startLineNumber,
                column: range.startColumn
              });
            } catch (_) {
              startOffset = null;
            }
            if (startOffset !== null) {
              try {
                const startPosition = textModel.getPositionAt(startOffset);
                const endPosition = textModel.getPositionAt(startOffset + text.length);
                const insertedRange = {
                  startLineNumber: startPosition.lineNumber,
                  startColumn: startPosition.column,
                  endLineNumber: endPosition.lineNumber,
                  endColumn: endPosition.column
                };
                if (textModel.getValueInRange(insertedRange) !== text) {
                  editor.executeEdits('codechef-clipboard-verify', [
                    { range: insertedRange, text: originalText, forceMoveMarkers: true }
                  ]);
                  try {
                    editor.setSelection(range);
                    editor.focus();
                  } catch (_) {
                    /* ignore */
                  }
                  return '';
                }
              } catch (_) {
                /* verification is best-effort */
              }
            }
          }

          // Put the cursor after the inserted block. This is cosmetic; the
          // inserted text itself has already been verified.
          try {
            if (textModel) {
              const start = textModel.getOffsetAt({
                lineNumber: range.startLineNumber,
                column: range.startColumn
              });
              const end = textModel.getPositionAt(start + text.length);
              editor.setPosition(end);
              if (typeof editor.revealPositionInCenterIfOutsideViewport === 'function') {
                editor.revealPositionInCenterIfOutsideViewport(end);
              }
            }
          } catch (_) {
            /* ignore */
          }

          editor.focus();
          return 'workbench';
        } catch (_) {
          return '';
        }
      },
      insert(text) {
        return this.paste(text);
      },
      deleteSelection() {
        const selected = selection();
        if (!selected || isEmptyRange(selected)) return;
        try {
          editor.executeEdits('codechef-clipboard', [
            { range: selected, text: '', forceMoveMarkers: true }
          ]);
        } catch (_) {
          /* ignore */
        }
      }
    };
  }
  // DOM fallback for workbench builds where the service collection cannot be
  // reached. It focuses the hidden textarea, uses Monaco's select-all
  // keybinding, and fires the restored copy / insertText commands. Its
  // copy/paste/drag handlers exist because the extension restored the native
  // addEventListener before the workbench loaded.
  function pickTextarea(container) {
    const all = Array.from(container.querySelectorAll('textarea'));
    if (!all.length) return null;

    // The real Monaco input is the textarea that currently has focus. Prefer
    // it over a hidden screen-reader textarea or a widget's textarea.
    const active = document.activeElement;
    if (active && all.includes(active)) return active;

    const inputareas = all.filter((ta) => ta.classList.contains('inputarea'));
    const pool = inputareas.length ? inputareas : all;
    const visible = pool.filter((ta) => {
      try {
        const rect = ta.getBoundingClientRect();
        const style = getComputedStyle(ta);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      } catch (_) {
        return false;
      }
    });
    return (visible.length ? visible : pool)[0];
  }

  function monacoDomAdapter(container) {
    const textarea = pickTextarea(container);
    const findEditContext = () => {
      try {
        return container.querySelector('.native-edit-context');
      } catch (_) {
        return null;
      }
    };
    if (!textarea && !findEditContext()) return null;

    // The VS Code editor needs to receive the shortcuts itself.
    releaseBlockers();

    const focus = () => {
      // Alt+Shift+V is pressed while the editor's real input is focused.
      // Use that input instead of a possibly stale/hidden textarea captured
      // when the adapter was created. Recent workbench builds can use an
      // EditContext div instead of a textarea.
      const active = document.activeElement;
      const activeIsInput =
        active &&
        container.contains(active) &&
        ((active.classList &&
          (active.classList.contains('inputarea') ||
            active.classList.contains('native-edit-context'))) ||
          (active.tagName === 'TEXTAREA' && !active.closest('.find-widget')));
      const editContext = activeIsInput ? null : findEditContext();
      const target = activeIsInput ? active : editContext || textarea;
      try {
        target.focus({ preventScroll: true });
      } catch (_) {
        try {
          target.focus();
        } catch (_) {
          /* ignore */
        }
      }
      return target;
    };

    const press = (key, code) => {
      const target = focus();
      const upper = key.toUpperCase();
      const event = new KeyboardEvent('keydown', {
        key,
        code,
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        bubbles: true,
        cancelable: true,
        composed: true
      });
      // Let our own window listener ignore it and pass it to Monaco.
      syntheticEvents.add(event);
      // VS Code's keybinding service still reads the legacy keyCode.
      try {
        Object.defineProperty(event, 'keyCode', { get: () => upper.charCodeAt(0) });
        Object.defineProperty(event, 'which', { get: () => upper.charCodeAt(0) });
      } catch (_) {
        /* ignore */
      }
      try {
        target.dispatchEvent(event);
      } catch (_) {
        /* ignore */
      }
    };

    const hasSelection = () => {
      try {
        return !!container.querySelector('.selected-text');
      } catch (_) {
        return false;
      }
    };

    return {
      kind: 'monaco-dom',
      container,
      manual: false,
      opaque: true,
      textareaCount: container.querySelectorAll('textarea').length,
      getValue() {
        return '';
      },
      getSelectedText() {
        return '';
      },
      focus,
      hasSelection,
      selectAll() {
        press('a', 'KeyA');
      },
      isReadOnly() {
        try {
          return container.classList.contains('read-only') || !!(textarea && textarea.readOnly);
        } catch (_) {
          return false;
        }
      },
      copy() {
        lastCopyPath = 'dom';
        focus();
        const selected = hasSelection();
        if (!selected) press('a', 'KeyA');

        // In the browser workbench Monaco does not bind Ctrl+C: the browser
        // fires a native copy event. A synthetic keydown cannot trigger that,
        // so ask the restored execCommand to fire it. Monaco's own copy
        // listener fills clipboardData.
        let ok = false;
        try {
          ok = !!(nativeExec && nativeExec.call(document, 'copy'));
        } catch (_) {
          ok = false;
        }
        if (!ok) return '';
        return selected ? 'selection' : 'whole';
      },
      copyAll() {
        lastCopyPath = 'dom';
        focus();
        press('a', 'KeyA');
        let ok = false;
        try {
          ok = !!(nativeExec && nativeExec.call(document, 'copy'));
        } catch (_) {
          ok = false;
        }
        return ok ? 'whole' : '';
      },
      paste(text) {
        const target = focus();
        if (!text) return Promise.resolve('');

        // Monaco treats execCommand('insertText') as typing, so its per-line
        // auto-indent runs and a pasted block drifts to the right. A paste
        // event uses Monaco's paste path, which inserts the block exactly as
        // it was copied (indentation included).
        if (!window.__ccSkipSyntheticPaste) {
          try {
            if (typeof DataTransfer === 'function' && typeof ClipboardEvent === 'function') {
              const data = new DataTransfer();
              data.setData('text/plain', text);
              const event = new ClipboardEvent('paste', {
                clipboardData: data,
                bubbles: true,
                cancelable: true,
                composed: true
              });
              target.dispatchEvent(event);
              if (event.defaultPrevented) return Promise.resolve('paste');
            }
          } catch (_) {
            /* try the native paste command below */
          }
        }

        // Some workbench builds ignore synthetic (untrusted) paste events.
        // Ask the isolated world to run the browser's real paste command on
        // the focused editor. That produces a trusted paste instead of
        // falling through to Monaco's auto-indenting typing path.
        focus();
        return requestBridge('paste').then((reply) => {
          if (reply.ok) return 'native';

          // Last resort for a single line. Never send multi-line text through
          // insertText: Monaco treats it as typing and auto-indents lines,
          // especially after `{`, which corrupts a pasted block. Ask for a
          // real Ctrl+V instead.
          if (text.includes('\n')) return '';
          try {
            if (nativeExec && nativeExec.call(document, 'insertText', false, text)) {
              return 'insertText';
            }
          } catch (_) {
            /* the user can still press Ctrl+V, which fires a native paste event */
          }
          return '';
        });
      },
      insert() {
        throw new Error('unsupported');
      },
      deleteSelection() {
        throw new Error('unsupported');
      }
    };
  }
  // The live VS Code workbench exposes window.workbench as its embedder API
  // ({ commands, env, logger, window, workspace, shutdown }), not as a service
  // collection. The service-based adapter above therefore cannot find the
  // editor there. The embedder API does expose commands.executeCommand, and
  // the workbench registers a low-level "paste" command that triggers Monaco's
  // paste edit path with the text we pass. For a single cursor that path is a
  // plain range replace, so it preserves the copied block exactly. This adapter
  // is the reliable fallback when the DI service collection is not exposed.
  function workbenchCommandAdapter(container) {
    const workbench = window.workbench;
    const commands = workbench && workbench.commands;
    if (!commands || typeof commands.executeCommand !== 'function') return null;

    // Reuse the DOM adapter for focus, cut, select-all, and read-only
    // detection. Copy and paste are replaced with the workbench command paths.
    const dom = monacoDomAdapter(container);
    if (!dom) return null;

    const command = (id, args) => {
      try {
        return Promise.resolve(commands.executeCommand(id, args));
      } catch (error) {
        return Promise.reject(error);
      }
    };

    const tryCommand = (id, args) => command(id, args).then(() => true, () => false);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const countFolds = () => {
      try {
        return container.querySelectorAll('.inline-folded').length;
      } catch (_) {
        return 0;
      }
    };

    const hasFolds = () => countFolds() > 0;

    // Folded regions are the one case where a DOM fallback can leak a `…`
    // placeholder. Unfold before the final select-all so even a fallback copy
    // sees the hidden lines. The editor actions are tried under both IDs used
    // by different workbench builds; failure is harmless and the copy still
    // proceeds from the model selection.
    const unfoldAll = () => {
      lastUnfoldPath = '';
      const before = countFolds();
      if (!before) {
        lastUnfoldPath = 'none';
        return Promise.resolve(false);
      }

      // A command can resolve even when that build does not register it, so
      // verify against the DOM fold placeholder count instead of trusting the
      // promise. This also tells the diagnostic whether unfolding really
      // happened.
      const verify = (id) =>
        tryCommand(id).then((ok) => {
          if (!ok) return false;
          return wait(30).then(() => {
            if (countFolds() === 0) {
              lastUnfoldPath = id;
              return true;
            }
            return false;
          });
        });

      return verify('editor.action.unfoldAll').then((ok) => {
        if (ok) return true;
        return verify('editor.unfoldAll').then((ok2) => {
          if (ok2) return true;
          lastUnfoldPath = 'failed';
          return false;
        });
      });
    };

    // The workbench's own copy action writes the editor model selection to the
    // clipboard. It does not read the DOM selection, so folded lines are
    // included and no fold placeholder can leak into the copied text.
    // editor.action.selectAll also focuses the active code editor and selects
    // the whole model, which restores text focus after a toolbar click.
    const commandCopyAll = () => {
      lastCopyPath = 'workbench-command';
      lastCopyFolds = countFolds();
      lastUnfoldPath = '';
      const folded = lastCopyFolds > 0;
      const prepare = folded
        ? command('editor.action.selectAll')
            .then(() => unfoldAll())
            .then(() => command('editor.action.selectAll'))
        : command('editor.action.selectAll');
      return prepare.then(
        () =>
          command('editor.action.clipboardCopyAction').then(
            () => 'whole',
            () => {
              // The select-all command focused the real code editor, but the
              // copy action failed. Fire the restored native copy command
              // without re-focusing a guessed textarea: the model selection is
              // already in place, and the real editor still has text focus.
              lastCopyPath = 'native-fallback';
              try {
                return nativeExec && nativeExec.call(document, 'copy') ? 'whole' : '';
              } catch (_) {
                return '';
              }
            }
          ),
        () => {
          // A minimal embedder may not register the editor commands. Keep the
          // old path as an explicit, visible fallback rather than silently
          // copying a partial DOM selection.
          const result = dom.copyAll();
          lastCopyPath = 'dom-fallback';
          return result;
        }
      );
    };

    const commandCopy = () => {
      lastCopyPath = 'workbench-command';
      if (!dom.hasSelection()) return commandCopyAll();
      lastCopyFolds = countFolds();
      lastUnfoldPath = '';
      try {
        dom.focus();
      } catch (_) {
        /* ignore */
      }
      const prepare = lastCopyFolds > 0 ? unfoldAll() : Promise.resolve();
      return prepare.then(() =>
        command('editor.action.clipboardCopyAction').then(
          () => 'selection',
          () => {
            // The editor is focused and its model selection is intact. Use the
            // restored native copy command directly instead of the DOM
            // fallback, which could select all or copy a stale DOM selection.
            lastCopyPath = 'native-fallback';
            try {
              return nativeExec && nativeExec.call(document, 'copy') ? 'selection' : '';
            } catch (_) {
              return '';
            }
          }
        )
      );
    };

    const commandPaste = (text) => {
      if (!text) return Promise.resolve('');
      if (dom.isReadOnly()) return Promise.resolve('');
      // The workbench paste command acts on the focused code editor. The
      // toolbar button may have taken focus, so put it back on the real
      // Monaco textarea first. If focus cannot be restored, do not report a
      // successful paste that never happened.
      let target = null;
      try {
        target = dom.focus();
      } catch (_) {
        target = null;
      }
      if (!target || document.activeElement !== target) return Promise.resolve('');

      const run = () => {
        let result;
        try {
          result = commands.executeCommand('paste', {
            text,
            pasteOnNewLine: false,
            multicursorText: null,
            mode: null
          });
        } catch (_) {
          return Promise.resolve('');
        }
        return Promise.resolve(result).then(
          () => 'workbench-command',
          () => ''
        );
      };

      // Let the focus event reach the workbench's focus tracker before the
      // command looks up getFocusedCodeEditor().
      return new Promise((resolve) => {
        setTimeout(() => {
          run().then(resolve, () => resolve(''));
        }, 0);
      });
    };

    return Object.assign({}, dom, {
      kind: 'monaco-workbench-command',
      manual: true,
      // The command copy paths focus the real code editor themselves. A
      // second focus call from copyAll/copySmart could move focus back to a
      // guessed textarea before the asynchronous copy action runs.
      copyKeepsFocus: true,
      copy: commandCopy,
      copyAll: commandCopyAll,
      paste: commandPaste,
      insert(text) {
        return commandPaste(text);
      }
    });
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
