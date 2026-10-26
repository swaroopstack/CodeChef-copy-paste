# CodeChef Clipboard Unlocker

A small, dependency-free browser extension for Brave (and Chrome/Edge) that
restores **copy, cut, paste, select-all and drag-and-drop inside CodeChef's
code editor**.

CodeChef's lab / assessment editor ships a clipboard lockdown. It blocks
`Ctrl+C`, `Ctrl+V`, `Ctrl+X` and `Ctrl+A`, stubs `navigator.clipboard` and
`document.execCommand`, and even patches `addEventListener` so the editor
cannot register its own handlers. This extension runs before that lockdown,
repairs the patched APIs before the editor loads, and puts the normal
clipboard and drag behaviour back — without touching the page's own buttons
or the editor's content.

It works with both editor families CodeChef uses:

- the **Ace** editor on `/ide`, problem pages and submit pages;
- the **VS Code / Monaco** editor used by the assessment/lab pages (where
  `window.monaco` is not exposed, so the extension uses the workbench's
  `paste` command, or its code-editor service when that is reachable, and
  falls back to the editor's DOM only as a last resort).

## Install in Brave

1. Open `brave://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Select the folder that contains `manifest.json`.
5. Open a CodeChef problem/IDE/assessment page and click the editor once.

If you already had the extension loaded, click the **reload** (↻) icon on its
card, then reload the CodeChef tab. Do **not** reload the tab in the middle of
a timed assessment — reload it before you start, or open a fresh assessment
tab after updating the extension. The card should show version **1.1.8**; if
it shows an older version, Brave is still running the old copy.

The extension has no build step and no dependencies.

## How to use it

Inside the code editor:

| Action | Shortcut |
| --- | --- |
| Copy selection | `Ctrl+C` |
| Copy the whole file (nothing selected) | `Ctrl+C` |
| Cut selection | `Ctrl+X` |
| Paste at the cursor | `Ctrl+V` |
| Select all | `Ctrl+A` |
| Copy the whole file (from anywhere on the page) | `Alt+Shift+C` |
| Paste at the cursor (from anywhere on the page) | `Alt+Shift+V` |
| Show loaded version, adapter and last paste/copy path | `Ctrl+Alt+D` or `Alt+Shift+D` |
| Show the same diagnostic | Click the small `v1.1.8` label in the toolbar |
| Move a selection with drag-and-drop | Drag the selected text |

There is also a small floating `Copy` / `Paste` bar at the bottom-right of the
page. **Copy** copies the selection, or the whole file if nothing is selected.
Drag the bar by the dotted grip if it covers something. It only appears when
an editor is on the page, and it works in both the Ace and VS Code editors.

Paste replaces the current selection. If the editor already contains template
code, select the part you want to replace (or press `Ctrl+A`) before pasting;
otherwise the template's existing braces stay in place and can look like an
extra `}`.

In the VS Code lab, the extension uses the workbench's own low-level `paste`
command (`window.workbench.commands.executeCommand('paste', { text })`). That
command triggers Monaco's paste edit path, which for a single cursor is a plain
range replace with the text you copied. It does **not** type the block
character-by-character and it does not run paste-time indentation
normalization, so lines with `{` and `}` keep exactly the indentation that was
copied. This is the primary path for the toolbar **Paste**, `Ctrl+V`, and
`Alt+Shift+V`.

In the VS Code lab, the toolbar **Copy** and `Ctrl+C` (with or without a
selection) use the workbench's own `editor.action.selectAll` and
`editor.action.clipboardCopyAction` commands. Those commands copy the editor
model selection rather than the rendered DOM. When the editor has folded
regions, the extension unfolds all first and selects the model again, so a
folded region is copied in full and no `…` placeholder leaks into the
clipboard. If the workbench registers select-all but its copy action fails, the
toast reports `copy: native-fallback` and the restored native copy command is
used. If select-all itself is unavailable, the toast reports `copy: dom-fallback`
so the older DOM path is visible instead of silent.

If the workbench also exposes its code-editor service, the extension prefers a
direct `editor.executeEdits(...)` call instead. That is the same exact model
edit, with a verification step that restores the original selection if the
workbench build transforms the text.

If neither workbench path is available, the extension falls back to the
editor's own paste path: first a synthetic `paste` event, then the
isolated-world helper's real `document.execCommand('paste')`, which produces a
trusted paste event. `execCommand('insertText')` is only a last resort for a
single line. Multi-line text is never sent through it, because Monaco treats it
as typing and auto-indents after `{`, which corrupts the block. If none of
these paths works, the toolbar asks you to press `Ctrl+V` instead of silently
changing your code.

To see what is actually running, press `Ctrl+Alt+D` (or `Alt+Shift+D`) inside
the editor, or click the small `v1.1.8` label in the toolbar. The toast shows
the loaded version, the adapter in use, whether a workbench object was found,
whether its command API is available, and the paths used by the last paste and
copy. After a copy it also shows how many folded regions were detected and
which unfold command ran, for example `folds: 1` and
`unfold: editor.action.unfoldAll`. `monaco-workbench-command` with
`paste: workbench-command` means the workbench `paste` command was used;
`copy: workbench-command` means the workbench model copy path was used.
`monaco-workbench` with
`paste: workbench` means the direct `executeEdits` path was used. `monaco-dom`
means neither workbench path was found and the paste-event fallback was used;
`paste: paste` or `paste: native` means that fallback handled the paste, while
`insertText` is the last-resort path that can re-indent. A copy path ending in
`native-fallback` means select-all worked but the workbench copy action failed,
so the restored native copy command was used; `dom-fallback` means the workbench
copy commands were unavailable and the older DOM copy path ran. The success
toast also includes the path, so you can report it without using a shortcut.

If the diagnostic says `workbench: no` or `commands: no`, the VS Code
workbench has not finished loading yet. Wait for the editor to finish loading,
click inside it, and try again; the extension switches to the command path as
soon as `window.workbench.commands` exists.

Right-click inside the editor also works again (the browser's own menu, where
**Copy**, **Cut** and **Paste** work normally).

## Notes

- On Ace pages the change is scoped to the code editor: copying text elsewhere
  on the page is still controlled by CodeChef. In the VS Code lab editor the
  page's keyboard, clipboard and drag blockers have to be released so the
  editor itself can receive `Ctrl+C`/`Ctrl+V`/`Ctrl+X`/`Ctrl+A` and its own
  drag handlers; on that page copy/paste may also work in other text fields.
- Works with CodeChef's Ace-based editor (`/ide`, problem pages, submit pages)
  and with the VS Code-style lab/assessment editor. Adapters for CodeMirror
  5/6 are included for future changes.
- `Ctrl+C` with **no selection** copies the entire file. That is intentional:
  it is the "give me my own code" shortcut.
- The extension asks for clipboard read/write permission so the toolbar's
  **Paste** button and `Alt+Shift+V` can read your clipboard. If Brave ever
  blocks that read, the extension focuses the editor and asks you to press
  `Ctrl+V` instead — which is handled by the extension and still works.
- No AI or autonomous agent is involved. In the VS Code lab the paste is a
  deterministic workbench `paste` command or `executeEdits` call with the
  clipboard text; the extension never rewrites, reformats, or "fixes" your
  code. If the editor cannot be reached, it asks you to press `Ctrl+V` instead
  of guessing.
- Nothing is sent anywhere. There is no background service, no analytics, no
  network code.
- Assessments may have rules about browser extensions. This extension only
  restores clipboard behaviour inside the code editor; use it in line with
  your assessment's rules.

## Why this is needed

When CodeChef's assessment lockdown is active, this is roughly what happens in
the page (from CodeChef's `LabEditor` bundle):

```js
// 1. Block the shortcut at document capture phase.
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && ['c', 'x', 'v', 'a'].includes(event.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

// 2. Stub the APIs.
navigator.clipboard.writeText = () => Promise.reject(new Error('Clipboard access denied'));
document.execCommand = () => false;

// 3. Drop clipboard listeners registered after this point.
EventTarget.prototype.addEventListener = function (type, listener, options) {
  if (['copy', 'cut', 'paste', 'selectstart', 'dragstart', /* ... */].includes(type)) return;
  return nativeAddEventListener.call(this, type, listener, options);
};
```

This extension is a `MAIN`-world content script at `document_start`, so it
saves the real `addEventListener`, `removeEventListener`, `execCommand` and
clipboard methods before step 3. It then watches for CodeChef's patch and
restores the native APIs as soon as the lockdown appears — before the editor
(especially the VS Code workbench) registers its handlers.

On Ace pages it keeps CodeChef's keyboard blocker in place and handles the
shortcuts itself, so the change stays scoped to the editor. On the VS Code lab
page it releases only the blockers that were registered *before* the repair
(the editor's own handlers are registered later, directly with the native
function), so Monaco receives the real shortcuts and its own copy, paste and
drag handlers can run.

Pressing `Ctrl+C`/`Ctrl+V` still reaches the browser; the extension reads and
writes the editor through its own API (Ace) or, in the VS Code lab, through
the workbench's `paste` command (or its code editor service and `executeEdits`
when that is exposed), falling back to the editor's DOM and trusted
`copy`/`paste` events only if neither workbench path is available. The page's
stubbed clipboard methods are therefore irrelevant.

## Files

- `manifest.json` — Manifest V3 definition (CodeChef domains only).
- `content-main.js` — editor adapters, keyboard/clipboard handling, floating bar.
- `content-isolated.js` — real Clipboard API helper for the toolbar buttons.
- `icons/` — generated PNG icons.
- `tools/make-icons.js` — icon generator (dev only).
- `test/` — local fixture and Puppeteer test (dev only).

## Development / testing

The test fixtures recreate CodeChef's lockdown twice: once around a real Ace
editor (`test/fixture.html`) and once before a VS Code-style DOM editor mounts
(`test/lab-fixture.html`). `test/workbench-fixture.html` exposes a
workbench-shaped service collection and verifies that paste goes through
`executeEdits` without firing a paste event. `test/workbench-command-fixture.html`
exposes the live embedder shape (`window.workbench.commands.executeCommand`)
and verifies that paste goes through the workbench `paste` command without
firing a DOM paste event. See `test/README.md`.
