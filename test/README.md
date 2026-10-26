# Tests

The end-to-end test runs the real extension in Brave against four fixtures:
one around a real Ace editor, one that mounts a VS Code-style DOM editor only
after the lockdown is applied, one that exposes a workbench-shaped
`window.workbench` service collection, and one that exposes the live workbench
embedder API (`window.workbench.commands.executeCommand`).
`lab-fixture.html?immediate=1` mounts the editor in the same task as the
lockdown, which covers the worst-case timing race.
`lab-fixture.html?ignore-synthetic=1` makes the editor ignore untrusted paste
events, which reproduces the workbench builds that force the extension onto its
native-paste fallback.
`workbench-fixture.html` records `executeEdits` calls and paste events, so the
test can prove that the service-collection path is a direct model edit, not a
paste event or `insertText`.
`workbench-command-fixture.html` records `window.workbench.commands` calls and
paste events, so the test can prove that the live embedder shape uses the
workbench `paste` command and never falls through to a DOM paste event.

## Setup

From this folder:

```powershell
npm init -y
npm install puppeteer-core
```

Brave is expected at:

```text
C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe
```

Set `BRAVE_PATH` to override it.

## Run

```powershell
node run-tests.js
```

The script:

1. Builds a temporary copy of the extension in `test/.build` whose manifest
   also matches `http://127.0.0.1/*` (the shipped manifest only matches
   CodeChef).
2. Serves `fixture.html`, `lab-fixture.html`, `workbench-fixture.html`,
   `workbench-command-fixture.html` and `blank.html` on a random local port.
3. Launches Brave headless with the extension loaded.
4. Drives real keyboard/mouse input and checks the system clipboard through a
   second page.

Set `HEADED=1` to watch the test in a visible Brave window.

If Brave does not load unpacked extensions in headless mode, run with
`HEADED=1`.

## What is covered

- `Ctrl+C` on a selection
- `Ctrl+V` at the cursor
- `Ctrl+C` with no selection (whole file)
- `Ctrl+A`
- `Ctrl+X`
- Toolbar Copy (whole file and selection)
- Toolbar Paste (real Clipboard API from the isolated world)
- Ace toolbar Paste preserves a multi-line block's indentation
- `Alt+Shift+C` / `Alt+Shift+V`
- `Alt+Shift+D`, `Ctrl+Alt+D` and the toolbar version label report the loaded
  version, adapter, workbench/command availability and last paste/copy path
- Page blocker still applies outside the editor on Ace pages
- Toolbar hidden on pages without an editor
- Lockdown API repair (`addEventListener` and `execCommand` restored)
- Ace `dragEnabled` turned back on
- VS Code-style lab: toolbar appears after the lockdown, drag listeners can
  register, toolbar Copy selects all and writes the clipboard, toolbar Paste
  fires Monaco's paste path and keeps a multi-line block's indentation (it does
  not use `execCommand('insertText')`, which Monaco would auto-indent)
- VS Code-style lab: `Ctrl+C` with no selection copies the whole file, and a
  real `Ctrl+V` reaches the editor as a native paste event
- Native fallback: when synthetic paste events are skipped, the isolated-world
  `execCommand('paste')` fires one trusted paste event and preserves a
  multi-line block's indentation
- Native fallback with an ignored synthetic event: the workbench ignores the
  extension's untrusted paste event, and the native fallback still fires
  exactly one trusted paste event with the exact text
- VS Code-style lab with an immediate mount: the editor's paste handler is
  registered even when it is added in the same task as the lockdown, before the
  repair poll can run, and toolbar Paste keeps the block's indentation
- Workbench service collection: toolbar Paste, `Ctrl+V` and `Alt+Shift+V` all
  use `executeEdits` exactly once, do not fire a paste event, and preserve a
  brace-heavy multi-line block's indentation
- Workbench service collection: a non-empty selection is replaced exactly, and
  the diagnostic reports `monaco-workbench` with `paste: workbench`
- Workbench embedder API (`window.workbench.commands`): toolbar Paste, `Ctrl+V`
  and `Alt+Shift+V` all invoke the workbench `paste` command exactly once, pass
  the exact brace-heavy text, do not fire a DOM paste event, and preserve the
  block's indentation
- Workbench embedder API: toolbar Copy and `Ctrl+C` with or without a
  selection use the workbench copy path, unfold folded regions first, copy the
  full model text rather than a rendered DOM selection, and report
  `copy: workbench-command`; a selection is preserved instead of selecting all
- Workbench embedder API: the clickable version label reports
  `monaco-workbench-command`, `workbench: yes`, `commands: yes`,
  `paste: workbench-command` and `copy: workbench-command`

The Ace and lab fixtures stub `navigator.clipboard`, stub
`document.execCommand`, drop clipboard/drag event listeners via a patched
`addEventListener`, and install
the document-level keyboard blocker — the same techniques CodeChef's
`LabEditor` uses. `lab-fixture.html` mounts its editor after a delay by default,
like the VS Code workbench does; `?immediate=1` removes that delay.
