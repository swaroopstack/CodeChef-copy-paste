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

  function makeAdapter(container) {
    if (!isElement(container)) return null;
    if (container.classList.contains('ace_editor')) return aceAdapter(container);
    if (container.classList.contains('CodeMirror')) return cm5Adapter(container);
    if (container.classList.contains('monaco-editor')) {
      return (
        workbenchAdapter(container) ||
        workbenchCommandAdapter(container) ||
        monacoAdapter(container) ||
        monacoDomAdapter(container)
      );
    }
    if (container.classList.contains('cm-editor')) return cm6Adapter(container);
    return null;
  }

  function containerFor(target) {
    if (!isElement(target)) return null;
    return target.closest(EDITOR_SELECTOR);
  }

  function adapterForEvent(event) {
    const container = containerFor(event.target);
    if (container) return makeAdapter(container);

    // Some browsers target document/body for clipboard events. Fall back to
    // the focused element when it lives inside an editor.
    const active = document.activeElement;
    if (isElement(active)) {
      const activeContainer = containerFor(active);
      if (activeContainer) return makeAdapter(activeContainer);
    }
    return null;
  }

  function isUiFocused() {
    return !!(ui && ui.host && document.activeElement === ui.host);
  }

  function resolveAdapter(event) {
    const direct = adapterForEvent(event);
    if (direct) return direct;
    if (isUiFocused() && lastAdapter && lastAdapter.container.isConnected) return lastAdapter;
    return null;
  }

  function findVisibleAdapter() {
    const containers = document.querySelectorAll(EDITOR_SELECTOR);

    // Prefer the editor that currently has focus.
    const active = document.activeElement;
    for (const container of containers) {
      if (isElement(active) && container.contains(active)) {
        const adapter = makeAdapter(container);
        if (adapter) return adapter;
      }
    }

    for (const container of containers) {
      if (!isVisible(container)) continue;
      const adapter = makeAdapter(container);
      if (adapter) return adapter;
    }
    return null;
  }

  function remember(event) {
    const adapter = adapterForEvent(event);
    if (adapter) lastAdapter = adapter;
    return adapter;
  }

  /* ------------------------------------------------------------------ *
   * Clipboard helpers
   * ------------------------------------------------------------------ */

  function textLength(text) {
    return text.length === 1 ? '1 character' : text.length.toLocaleString() + ' characters';
  }

  function selectedText(adapter) {
    try {
      return adapter.getSelectedText() || '';
    } catch (_) {
      return '';
    }
  }

  function editorValue(adapter) {
    try {
      return adapter.getValue() || '';
    } catch (_) {
      return '';
    }
  }

  function chooseAdapter(preferred) {
    // Recreate the adapter for the container instead of reusing a captured
    // one. The workbench service collection appears after the editor mounts,
    // so an adapter captured a moment earlier may still be the DOM fallback.
    // Recreating lets the exact executeEdits path take over as soon as it is
    // available.
    if (preferred && preferred.container && preferred.container.isConnected) {
      const fresh = makeAdapter(preferred.container);
      return fresh || preferred;
    }
    if (lastAdapter && lastAdapter.container.isConnected) {
      const fresh = makeAdapter(lastAdapter.container);
      return fresh || lastAdapter;
    }
    return findVisibleAdapter();
  }

  // Synchronous clipboard write used by buttons/shortcuts. document.execCommand
  // is saved before CodeChef replaces it, so the page's stub cannot interfere.
  function copyTextNative(text) {
    if (!nativeExec || !document.body) return false;

    const previousFocus = document.activeElement;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.cssText =
      'position:fixed;top:-10000px;left:-10000px;width:1px;height:1px;' +
      'opacity:0;pointer-events:none;font-size:12px;';

    document.body.appendChild(textarea);
    let ok = false;
    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      ok = nativeExec.call(document, 'copy');
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

  function copyThroughBridge(text) {
    return requestBridge('write', text).then((reply) => !!reply.ok);
  }

  function bridgeWrite(text) {
    if (copyTextNative(text)) return Promise.resolve(true);
    return copyThroughBridge(text);
  }

  function requestBridge(action, text) {
    return new Promise((resolve) => {
      if (!document.body) {
        resolve({ ok: false, error: 'no-body' });
        return;
      }
      const id = ++bridgeSeq;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, 2500);

      pending.set(id, { resolve, timer });
      try {
        window.postMessage({ __ccClip: 'request', id, action, text }, '*');
      } catch (_) {
        pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: 'post-failed' });
      }
    });
  }

  add(window, 'message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__ccClip !== 'reply' || typeof data.id !== 'number') return;
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    clearTimeout(request.timer);
    request.resolve({
      ok: !!data.ok,
      text: typeof data.text === 'string' ? data.text : '',
      error: data.error
    });
  });

  /* ------------------------------------------------------------------ *
   * Copy / cut / paste
   * ------------------------------------------------------------------ */

  function toastCopyResult(result) {
    if (result && typeof result.then === 'function') {
      result.then(toastCopyResult, () => toast('Could not copy'));
      return;
    }
    const path = lastCopyPath ? ' \u00b7 ' + lastCopyPath : '';
    if (result === 'whole' || result === true) toast('Copied the whole file' + path);
    else if (result === 'selection' || result === false) toast('Copied' + path);
    else toast('Could not copy');
  }

  function copyAll(adapter, options) {
    const opts = options || {};
    lastCopyFolds = 0;
    lastUnfoldPath = '';
    adapter = chooseAdapter(adapter);
    if (!adapter) {
      toast('No code editor found');
      return;
    }

    if (typeof adapter.copyAll === 'function' || typeof adapter.copy === 'function') {
      try {
        const copy = adapter.copyAll || adapter.copy;
        toastCopyResult(copy.call(adapter));
      } catch (_) {
        toast('Could not copy');
      }
      if (!opts.keepFocus && !adapter.copyKeepsFocus) {
        try {
          adapter.focus();
        } catch (_) {
          /* ignore */
        }
      }
      return;
    }

    const text = editorValue(adapter);
    if (!text) {
      toast('The editor is empty');
      return;
    }

    lastCopyPath = 'bridge';
    bridgeWrite(text).then((ok) => {
      if (ok) {
        toast('Copied the whole file \u00b7 ' + textLength(text) + ' \u00b7 bridge');
      } else {
        toast('Could not write to the clipboard');
      }
    });

    if (!opts.keepFocus) {
      try {
        adapter.focus();
      } catch (_) {
        /* ignore */
      }
    }
  }

  function copySmart(adapter) {
    adapter = chooseAdapter(adapter);
    if (!adapter) {
      toast('No code editor found');
      return;
    }

    if (typeof adapter.copy === 'function') {
      try {
        toastCopyResult(adapter.copy());
      } catch (_) {
        toast('Could not copy');
      }
      try {
        if (!adapter.copyKeepsFocus) adapter.focus();
      } catch (_) {
        /* ignore */
      }
      return;
    }

    const selected = selectedText(adapter);
    if (!selected) {
      copyAll(adapter);
      return;
    }

    lastCopyPath = 'bridge';
    bridgeWrite(selected).then((ok) => {
      toast(
        ok
          ? 'Copied \u00b7 ' + textLength(selected) + ' \u00b7 bridge'
          : 'Could not write to the clipboard'
      );
    });

    try {
      adapter.focus();
    } catch (_) {
      /* ignore */
    }
  }

  function pasteFromClipboard(adapter) {
    adapter = chooseAdapter(adapter);
    if (!adapter) {
      toast('No code editor found');
      return;
    }

    if (adapter.isReadOnly()) {
      toast('This editor is read-only');
      return;
    }

    // VS Code/Monaco without window.monaco: read the real clipboard from the
    // isolated world and insert it through Monaco's paste path. If that fails,
    // the adapter asks the isolated world for the browser's native paste
    // command before falling back to insertText.
    if (typeof adapter.paste === 'function') {
      setTimeout(() => {
        requestBridge('read').then((reply) => {
          const text =
            reply.ok && typeof reply.text === 'string' ? reply.text.replace(/\r\n?/g, '\n') : '';

          let result;
          try {
            result = adapter.paste(text);
          } catch (_) {
            result = '';
          }

          Promise.resolve(result).then((ok) => {
            if (ok && text) {
              lastPastePath = ok;
              if (ok === 'insertText') {
                toast('Pasted (fallback \u2014 may re-indent) \u00b7 ' + textLength(text), 3200);
              } else {
                toast('Pasted \u00b7 ' + textLength(text) + ' \u00b7 ' + ok);
              }
            } else if (!reply.ok) {
              toast('Press Ctrl+V to paste', 2800);
            } else if (!text) {
              toast('The clipboard is empty');
            } else {
              toast('Press Ctrl+V to paste', 2800);
            }
          });
        });
      }, 50);
      return;
    }

    if (!adapter.manual) {
      try {
        adapter.focus();
      } catch (_) {
        /* ignore */
      }
      toast('Press Ctrl+V to paste');
      return;
    }

    // Give the isolated-world helper a tick to observe the real gesture and
    // arm its one-shot clipboard-read window.
    setTimeout(() => {
      requestBridge('read').then((reply) => {
        if (!reply.ok || typeof reply.text !== 'string') {
          try {
            adapter.focus();
          } catch (_) {
            /* ignore */
          }
          toast('Clipboard access was blocked \u2014 press Ctrl+V now', 2800);
          return;
        }

        if (!reply.text) {
          toast('The clipboard is empty');
          return;
        }

        const text = reply.text.replace(/\r\n?/g, '\n');

        try {
          const result = adapter.insert(text);
          const path = typeof result === 'string' && result ? result : 'insert';
          lastPastePath = path;
          toast('Pasted \u00b7 ' + textLength(text) + ' \u00b7 ' + path);
        } catch (error) {
          toast(adapter.isReadOnly() ? 'This editor is read-only' : 'Could not paste here');
        }
      });
    }, 50);
  }

  function showDiagnostic() {
    const adapter =
      lastAdapter && lastAdapter.container && lastAdapter.container.isConnected
        ? chooseAdapter(lastAdapter)
        : findVisibleAdapter();
    const workbench = window.workbench;
    const commands = !!(
      workbench &&
      workbench.commands &&
      typeof workbench.commands.executeCommand === 'function'
    );

    if (!adapter) {
      toast(
        'v' +
          VERSION +
          ' \u00b7 no editor' +
          ' \u00b7 workbench: ' +
          (workbench ? 'yes' : 'no') +
          ' \u00b7 commands: ' +
          (commands ? 'yes' : 'no'),
        5200
      );
      return;
    }

    const extra = adapter.textareaCount > 1 ? ' \u00b7 ' + adapter.textareaCount + ' textareas' : '';
    toast(
      'v' +
        VERSION +
        ' \u00b7 ' +
        adapter.kind +
        extra +
        ' \u00b7 workbench: ' +
        (workbench ? 'yes' : 'no') +
        ' \u00b7 commands: ' +
        (commands ? 'yes' : 'no') +
        ' \u00b7 paste: ' +
        (lastPastePath || 'none') +
        ' \u00b7 copy: ' +
        (lastCopyPath || 'none') +
        (lastCopyFolds
          ? ' \u00b7 folds: ' +
            lastCopyFolds +
            ' \u00b7 unfold: ' +
            (lastUnfoldPath || 'none')
          : ''),
      5200
    );
  }

  function onKeyDown(event) {
    if (syntheticEvents.has(event)) return;

    const modifier = event.ctrlKey || event.metaKey;
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    const code = event.code || '';

    // Ctrl+Alt+D is an alternate diagnostic shortcut. Alt+Shift+D can be
    // swallowed by Windows' keyboard-layout switch, so the toolbar version
    // label is clickable too.
    if (modifier && event.altKey && !event.shiftKey && (key === 'd' || code === 'KeyD')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showDiagnostic();
      return;
    }

    if (modifier && !event.altKey) {
      const action =
        key === 'c' || code === 'KeyC'
          ? 'c'
          : key === 'v' || code === 'KeyV'
            ? 'v'
            : key === 'x' || code === 'KeyX'
              ? 'x'
              : key === 'a' || code === 'KeyA'
                ? 'a'
                : '';

      if (action) {
        const adapter = resolveAdapter(event);
        if (!adapter) return;

        // The VS Code editor handles its own shortcuts. Its key blockers were
        // released when the adapter was detected, so let the event through.
        // For the live workbench command adapter, take over every Ctrl+C:
        // the native workbench copy can still fall back to the rendered DOM
        // when a region is folded. The command path selects the model, unfolds
        // folded regions, and copies from the model selection.
        if (adapter.kind === 'monaco-workbench-command') {
          if (action === 'c') {
            event.preventDefault();
            event.stopImmediatePropagation();
            try {
              toastCopyResult(adapter.copy());
            } catch (_) {
              toast('Could not copy');
            }
          }
          return;
        }

        // The DOM-only adapter keeps its old behavior: only Ctrl+C with
        // nothing selected is turned into "select all and copy". With a
        // selection, the editor's native copy handler is reliable there.
        if (adapter.kind === 'monaco-dom') {
          if (action === 'c' && typeof adapter.hasSelection === 'function' && !adapter.hasSelection()) {
            event.preventDefault();
            event.stopImmediatePropagation();
            lastCopyFolds = 0;
            lastUnfoldPath = '';
            try {
              toastCopyResult(adapter.copy());
            } catch (_) {
              toast('Could not copy');
            }
          }
          return;
        }

        // Stop CodeChef's document-level capture blocker, but do not prevent
        // the default action: the browser still fires copy/cut/paste, which
        // our window-level handlers below handle.
        event.stopImmediatePropagation();

        if (action === 'a') {
          event.preventDefault();
          try {
            adapter.selectAll();
          } catch (_) {
            /* ignore */
          }
          return;
        }

        if (action === 'c' && !selectedText(adapter)) {
          // Ctrl+C with no selection is the common "give me my whole file"
          // case. Handle it now instead of relying on a copy event.
          event.preventDefault();
          copyAll(adapter);
          return;
        }

        // For copy/cut/paste with a selection, let the native clipboard event
        // fire. The handlers below replace the editor-specific bits.
        return;
      }
    }

    if (event.altKey && event.shiftKey && !modifier) {
      if (code !== 'KeyC' && code !== 'KeyV' && code !== 'KeyD') return;

      const adapter = resolveAdapter(event) || findVisibleAdapter();
      if (!adapter) return;

      event.preventDefault();
      if (code === 'KeyD') {
        showDiagnostic();
        return;
      }
      // Do not stop propagation here: the isolated-world helper needs to see
      // this trusted keydown to arm its one-shot clipboard read.
      if (code === 'KeyC') copyAll(adapter);
      else pasteFromClipboard(adapter);
    }
  }

  function onCopy(event) {
    const adapter = resolveAdapter(event);
    if (!adapter || !adapter.manual) return;

    const selected = selectedText(adapter);
    const text = selected || editorValue(adapter);
    if (!text) return;

    try {
      if (!event.clipboardData) return;
      event.clipboardData.setData('text/plain', text);
    } catch (_) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    toast(selected ? 'Copied \u00b7 ' + textLength(text) : 'Copied the whole file \u00b7 ' + textLength(text));
  }

  function onCut(event) {
    const adapter = resolveAdapter(event);
    if (!adapter || !adapter.manual) return;

    const text = selectedText(adapter);
    if (!text) return;

    try {
      if (!event.clipboardData) return;
      event.clipboardData.setData('text/plain', text);
    } catch (_) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    if (adapter.isReadOnly()) {
      toast('This editor is read-only');
      return;
    }

    try {
      adapter.deleteSelection();
      toast('Cut \u00b7 ' + textLength(text));
    } catch (_) {
      toast('This editor is read-only');
    }
  }

  function finishPaste(adapter, text, result) {
    if (result === '') {
      toast(
        adapter.isReadOnly() ? 'This editor is read-only' : 'Press Ctrl+V to paste',
        2800
      );
      return;
    }
    // Adapters that use a direct model edit or a workbench command return
    // their path name; the others return undefined and are using the
    // browser's paste event.
    lastPastePath = typeof result === 'string' && result ? result : 'native';
    toast('Pasted \u00b7 ' + textLength(text) + ' \u00b7 ' + lastPastePath);
  }

  function onPaste(event) {
    const adapter = resolveAdapter(event);
    if (!adapter) return;
    if (!adapter.manual) {
      // The VS Code editor handles its own paste. Record that it went through
      // the native path so the diagnostic can report it.
      lastPastePath = 'native';
      return;
    }

    const raw = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
    const text = raw.replace(/\r\n?/g, '\n');
    event.preventDefault();
    event.stopImmediatePropagation();

    if (!text) {
      toast('The clipboard is empty');
      return;
    }

    try {
      const result = adapter.insert(text);
      if (result && typeof result.then === 'function') {
        result.then(
          (ok) => finishPaste(adapter, text, ok),
          () => toast(adapter.isReadOnly() ? 'This editor is read-only' : 'Could not paste here')
        );
      } else {
        finishPaste(adapter, text, result);
      }
    } catch (_) {
      toast(adapter.isReadOnly() ? 'This editor is read-only' : 'Could not paste here');
    }
  }

  function onContextMenu(event) {
    const adapter = resolveAdapter(event);
    if (!adapter) return;

    // The page suppresses right-click with a capture listener that calls
    // preventDefault(). Stop the event before that listener runs, and let the
    // browser open its own menu (Copy / Paste / Select All then work).
    event.stopImmediatePropagation();
  }

  /* ------------------------------------------------------------------ *
   * Floating toolbar
   * ------------------------------------------------------------------ */

  function toast(message, ms) {
    if (!ui) return;
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (ui) ui.toast.classList.remove('show');
    }, typeof ms === 'number' ? ms : 1700);
  }

  function restorePosition(host) {
    let position = null;
    try {
      position = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    } catch (_) {
      position = null;
    }
    if (!position || typeof position.left !== 'number' || typeof position.top !== 'number') {
      return;
    }

    const width = host.offsetWidth || 190;
    const height = host.offsetHeight || 34;
    const left = Math.min(Math.max(4, position.left), window.innerWidth - width - 4);
    const top = Math.min(Math.max(4, position.top), window.innerHeight - height - 4);
    host.style.left = left + 'px';
    host.style.top = top + 'px';
    host.style.right = 'auto';
    host.style.bottom = 'auto';
  }

  function savePosition(left, top) {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
    } catch (_) {
      /* ignore */
    }
  }

  function makeDraggable(host, handle) {
    let drag = null;

    add(handle, 'pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = host.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (_) {
        /* ignore */
      }
      event.preventDefault();
    });

    add(handle, 'pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const width = host.offsetWidth || 190;
      const height = host.offsetHeight || 34;
      const left = Math.min(Math.max(4, event.clientX - drag.offsetX), window.innerWidth - width - 4);
      const top = Math.min(Math.max(4, event.clientY - drag.offsetY), window.innerHeight - height - 4);
      host.style.left = left + 'px';
      host.style.top = top + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    });

    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const rect = host.getBoundingClientRect();
      savePosition(rect.left, rect.top);
      drag = null;
    };

    add(handle, 'pointerup', endDrag);
    add(handle, 'pointercancel', endDrag);
  }

  const UI_STYLE = `
    :host { all: initial; }
    .bar {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 3px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 999px;
      background: rgba(17, 24, 39, 0.94);
      color: #e5e7eb;
      font: 12px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(8px);
      user-select: none;
      -webkit-user-select: none;
    }
    .grip {
      width: 16px;
      align-self: stretch;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #6b7280;
      cursor: grab;
      font-size: 11px;
      letter-spacing: -2px;
      touch-action: none;
    }
    .grip:active { cursor: grabbing; }
    button {
      appearance: none;
      border: 0;
      margin: 0;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 6px 10px;
      border-radius: 999px;
      background: transparent;
      color: inherit;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover { background: rgba(255, 255, 255, 0.1); }
    button:active { background: rgba(255, 255, 255, 0.16); }
    button:focus-visible { outline: 2px solid #4ade80; outline-offset: 1px; }
    button:disabled { opacity: 0.4; cursor: default; }
    button.primary { color: #86efac; }
    button.version {
      padding: 4px 6px;
      font-size: 10px;
      font-weight: 500;
      opacity: 0.55;
      letter-spacing: 0.02em;
    }
    button.version:hover { opacity: 1; }
    svg { width: 14px; height: 14px; flex: none; }
    .toast {
      position: fixed;
      left: 50%;
      bottom: 26px;
      transform: translate(-50%, 12px);
      padding: 7px 12px;
      border-radius: 8px;
      background: rgba(17, 24, 39, 0.96);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #f3f4f6;
      font: 12px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      opacity: 0;
      pointer-events: none;
      transition: opacity 140ms ease, transform 140ms ease;
      max-width: min(92vw, 720px);
      text-align: center;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
  `;

  const COPY_ICON =
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="5.25" y="5.25" width="8" height="8" rx="1.6" stroke="currentColor" stroke-width="1.4"/>' +
    '<path d="M10.75 3.25v-.6a1.4 1.4 0 0 0-1.4-1.4H3.65a1.4 1.4 0 0 0-1.4 1.4v6.7a1.4 1.4 0 0 0 1.4 1.4h.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '</svg>';

  const PASTE_ICON =
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M6 3.25H4.6A1.6 1.6 0 0 0 3 4.85v8.1a1.6 1.6 0 0 0 1.6 1.6h6.8a1.6 1.6 0 0 0 1.6-1.6v-8.1a1.6 1.6 0 0 0-1.6-1.6H10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '<rect x="6" y="2" width="4" height="2.8" rx="1" stroke="currentColor" stroke-width="1.4"/>' +
    '</svg>';

  function createUi() {
    if (ui || !document.body) return;

    const host = document.createElement('div');
    host.id = UI_ID;
    host.title = 'CodeChef Clipboard Unlocker v' + VERSION;
    host.dataset.version = VERSION;
    host.style.cssText =
      'position:fixed;right:18px;bottom:18px;z-index:2147483647;display:none;';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' + UI_STYLE + '</style>' +
      '<div class="bar" role="toolbar" aria-label="CodeChef clipboard tools">' +
      '<span class="grip" title="Drag to move" aria-hidden="true">\u283f</span>' +
      '<button type="button" class="primary" data-action="copy" title="Copy selection, or the whole file (Alt+Shift+C)">' +
      COPY_ICON + '<span>Copy</span></button>' +
      '<button type="button" data-action="paste" title="Paste at the cursor (Alt+Shift+V)">' +
      PASTE_ICON + '<span>Paste</span></button>' +
      '<button type="button" class="version" data-action="diag" title="Show diagnostics (Ctrl+Alt+D)">v' +
      VERSION +
      '</button>' +
      '</div>' +
      '<div class="toast" role="status" aria-live="polite"></div>';

    const copyButton = shadow.querySelector('[data-action="copy"]');
    const pasteButton = shadow.querySelector('[data-action="paste"]');
    const versionButton = shadow.querySelector('[data-action="diag"]');
    const toastElement = shadow.querySelector('.toast');
    const grip = shadow.querySelector('.grip');

    add(copyButton, 'click', () => {
      copySmart(lastAdapter || findVisibleAdapter());
    });

    add(pasteButton, 'click', () => {
      pasteFromClipboard(lastAdapter || findVisibleAdapter());
    });

    add(versionButton, 'click', () => {
      showDiagnostic();
    });

    makeDraggable(host, grip);
    document.body.appendChild(host);

    ui = { host, shadow, copyButton, pasteButton, versionButton, toast: toastElement };

    // Wait for layout, then restore a previously dragged position.
    requestAnimationFrame(() => {
      if (ui) restorePosition(host);
    });
  }

  function refreshUi() {
    // Some SPAs replace the body; recreate the bar if ours was removed.
    if (ui && ui.host && !ui.host.isConnected) ui = null;
    if (!document.body) return;
    createUi();
    if (!ui) return;

    const adapter = findVisibleAdapter();
    if (!adapter) {
      ui.host.style.display = 'none';
      return;
    }

    ui.host.style.display = 'block';
    ui.pasteButton.disabled = adapter.isReadOnly();

    if (!ui.host.dataset.positioned) {
      ui.host.dataset.positioned = '1';
      restorePosition(ui.host);
    }
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  add(window, 'keydown', onKeyDown, true);
  add(window, 'copy', onCopy, true);
  add(window, 'cut', onCut, true);
  add(window, 'paste', onPaste, true);
  add(window, 'contextmenu', onContextMenu, true);

  add(document, 'mousedown', (event) => {
    remember(event);
  }, true);

  add(document, 'focusin', (event) => {
    remember(event);
  }, true);

  add(window, 'resize', () => {
    if (!ui || ui.host.style.display === 'none') return;
    const rect = ui.host.getBoundingClientRect();
    ui.host.style.left = Math.min(rect.left, window.innerWidth - rect.width - 4) + 'px';
    ui.host.style.top = Math.min(rect.top, window.innerHeight - rect.height - 4) + 'px';
    ui.host.style.right = 'auto';
    ui.host.style.bottom = 'auto';
  }, { passive: true });

  function start() {
    repairLockdown();
    clearInterval(repairTimer);
    repairTimer = setInterval(watchLockdown, 50);

    refreshUi();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshUi, 1000);
  }

  if (document.readyState === 'loading') {
    add(document, 'DOMContentLoaded', start);
  } else {
    start();
  }
})();
