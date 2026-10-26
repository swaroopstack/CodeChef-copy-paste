/*
 * End-to-end test for the CodeChef Clipboard Unlocker.
 *
 * - Creates a temporary copy of the extension whose manifest also matches
 *   http://127.0.0.1/* (the shipped manifest only targets CodeChef).
 * - Serves test/fixture.html, which reproduces CodeChef's clipboard lockdown
 *   around a real Ace editor.
 * - Launches Brave with the extension, drives real keyboard/mouse input, and
 *   verifies copy/cut/paste/select-all through the system clipboard.
 *
 * Requires puppeteer-core:
 *   npm install puppeteer-core
 * Run:
 *   node test/run-tests.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;
const BUILD_DIR = path.join(TEST_DIR, '.build');
const PROFILE_DIR = path.join(TEST_DIR, '.profile');
const UI_ID = 'codechef-clipboard-unlocker';
const BRAVE =
  process.env.BRAVE_PATH ||
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ctrlKey(page, key) {
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
}

async function altShiftKey(page, key) {
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.press(key);
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
}

async function toastText(page) {
  return page.evaluate((id) => {
    const host = document.getElementById(id);
    const toast = host && host.shadowRoot && host.shadowRoot.querySelector('.toast');
    return toast ? toast.textContent : '';
  }, UI_ID);
}

function prepareBuild() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(BUILD_DIR, 'icons'), { recursive: true });

  for (const file of ['content-main.js', 'content-isolated.js']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(BUILD_DIR, file));
  }
  for (const size of [16, 32, 48, 128]) {
    fs.copyFileSync(
      path.join(ROOT, 'icons', `icon${size}.png`),
      path.join(BUILD_DIR, 'icons', `icon${size}.png`)
    );
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  for (const script of manifest.content_scripts) {
    script.matches.push('http://127.0.0.1/*');
  }
  fs.writeFileSync(path.join(BUILD_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function startServer() {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8'
  };

  const server = http.createServer((request, response) => {
    const urlPath = decodeURIComponent((request.url || '/').split('?')[0]);
    const name = path.basename(urlPath === '/' ? 'fixture.html' : urlPath);
    const file = path.join(TEST_DIR, name);

    fs.readFile(file, (error, data) => {
      if (error) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }
      response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      response.end(data);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function launchBrave(headless) {
  return puppeteer.launch({
    executablePath: BRAVE,
    headless,
    userDataDir: PROFILE_DIR,
    defaultViewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${BUILD_DIR}`,
      `--load-extension=${BUILD_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-breakpad',
      '--metrics-recording-only',
      '--mute-audio',
      '--window-size=1280,900'
    ]
  });
}

async function buttonRect(page, action) {
  return page.evaluate(
    ({ id, action }) => {
      const host = document.getElementById(id);
      if (!host || !host.shadowRoot) throw new Error('toolbar not found');
      const button = host.shadowRoot.querySelector(`[data-action="${action}"]`);
      if (!button) throw new Error('button not found: ' + action);
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    { id: UI_ID, action }
  );
}

async function toolbarDisplay(page) {
  return page.evaluate((id) => {
    const host = document.getElementById(id);
    return host ? getComputedStyle(host).display : 'missing';
  }, UI_ID);
}

async function clearPasteTarget(blank) {
  await blank.bringToFront();
  await blank.evaluate(() => {
    const target = document.querySelector('#paste-target');
    target.value = '';
    target.focus();
  });
}

async function readClipboard(page, blank) {
  await clearPasteTarget(blank);
  await ctrlKey(blank, 'v');
  await sleep(120);
  const value = await blank.$eval('#paste-target', (target) => target.value);
  await page.bringToFront();
  return value;
}

async function writeClipboard(page, blank, text) {
  await blank.bringToFront();
  await blank.evaluate((value) => {
    const target = document.querySelector('#paste-target');
    target.value = value;
    target.focus();
    target.select();
  }, text);
  await ctrlKey(blank, 'c');
  await sleep(80);
  await page.bringToFront();
}

async function assertClipboard(page, blank, expected, label) {
  const actual = await readClipboard(page, blank);
  assert.strictEqual(actual, expected, `${label}: clipboard mismatch`);
  console.log(`ok - ${label}`);
}

async function main() {
  prepareBuild();
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });

  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const errors = [];
  let browser;

  try {
    const headed = !!process.env.HEADED;
    browser = await launchBrave(!headed);
    console.log(`Brave launched (${headed ? 'headed' : 'headless'})`);

    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.goto(base + '/fixture.html', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForFunction(() => window.editor && typeof window.editor.getValue === 'function');

    const injected = await page.evaluate((id) => !!document.getElementById(id), UI_ID);
    if (!injected) {
      throw new Error(
        'The extension did not inject. Brave may not support --load-extension in headless mode; run with HEADED=1.'
      );
    }

    await page.waitForFunction(
      ({ id }) => {
        const host = document.getElementById(id);
        return !!host && host.style.display === 'block' && !!host.shadowRoot;
      },
      { timeout: 8000 },
      { id: UI_ID }
    );
    console.log('ok - extension injected and toolbar visible');

    // The fixture applies the lockdown before Ace mounts. The extension must
    // repair the patched APIs before the editor's own handlers are needed.
    const repaired = await page.evaluate(() => ({
      applied: window.__lockdownApplied === true,
      addRestored: EventTarget.prototype.addEventListener !== window.__lockdownAdd,
      execRestored: document.execCommand !== window.__lockdownExec
    }));
    assert.strictEqual(repaired.applied, true, 'fixture should apply the lockdown');
    assert.strictEqual(repaired.addRestored, true, 'extension should restore addEventListener');
    assert.strictEqual(repaired.execRestored, true, 'extension should restore execCommand');
    console.log('ok - extension repaired the lockdown APIs');

    const dragEnabled = await page.evaluate(() => window.editor.getOption('dragEnabled'));
    assert.strictEqual(dragEnabled, true, 'Ace drag-and-drop should be enabled');
    console.log('ok - Ace drag-and-drop is enabled');

    const blank = await browser.newPage();
    blank.on('pageerror', (error) => errors.push(String(error)));
    await blank.goto(base + '/blank.html', { waitUntil: 'domcontentloaded' });
    assert.strictEqual(await toolbarDisplay(blank), 'none', 'toolbar should be hidden without an editor');
    console.log('ok - toolbar hidden on pages without an editor');

    // 1. Copy a selection with Ctrl+C.
    await page.bringToFront();
    await page.evaluate(() => {
      window.editor.setValue('AAA\nBBB\nCCC', -1);
      window.selectCode(1, 0, 1, 3);
    });
    await ctrlKey(page, 'c');
    await assertClipboard(page, blank, 'BBB', 'Ctrl+C copies the selection');

    // 2. Paste at the cursor with Ctrl+V.
    await page.evaluate(() => window.scrollToEnd());
    await ctrlKey(page, 'v');
    await sleep(200);
    let value = await page.evaluate(() => window.editor.getValue());
    assert.strictEqual(value, 'AAA\nBBB\nCCCBBB', 'Ctrl+V should paste at the cursor');
    console.log('ok - Ctrl+V pastes at the cursor');

    // 3. Ctrl+C with no selection copies the whole file.
    await page.evaluate(() => {
      window.editor.clearSelection();
      window.editor.focus();
    });
    await ctrlKey(page, 'c');
    await sleep(120);
    await assertClipboard(page, blank, 'AAA\nBBB\nCCCBBB', 'Ctrl+C with no selection copies the whole file');

    // 4. Ctrl+A selects the whole file.
    await page.bringToFront();
    await ctrlKey(page, 'a');
    const selected = await page.evaluate(() => window.editor.getSelectedText());
    assert.strictEqual(selected, 'AAA\nBBB\nCCCBBB', 'Ctrl+A should select all');
    console.log('ok - Ctrl+A selects the whole file');

    // 5. Ctrl+X cuts the selection.
    await page.evaluate(() => window.selectCode(0, 0, 0, 3));
    await ctrlKey(page, 'x');
    await sleep(150);
    value = await page.evaluate(() => window.editor.getValue());
    assert.strictEqual(value, '\nBBB\nCCCBBB', 'Ctrl+X should remove the selection');
    await assertClipboard(page, blank, 'AAA', 'Ctrl+X copies the selection');
    console.log('ok - Ctrl+X cuts the selection');

    // 6. Toolbar "Copy" button.
    await page.evaluate(() => {
      window.editor.setValue('toolbar-copy-value', -1);
      window.editor.navigateFileEnd();
      window.editor.clearSelection();
      window.editor.focus();
    });
    const copyRect = await buttonRect(page, 'copy');
    await page.mouse.click(copyRect.x, copyRect.y);
    await sleep(300);
    await assertClipboard(page, blank, 'toolbar-copy-value', 'toolbar Copy button (whole file)');
    value = await page.evaluate(() => window.editor.getValue());
    assert.strictEqual(value, 'toolbar-copy-value', 'Copy should not modify the editor');

    await page.evaluate(() => {
      window.editor.setValue('one two three', -1);
      window.selectCode(0, 4, 0, 7);
    });
    const copyRect2 = await buttonRect(page, 'copy');
    await page.mouse.click(copyRect2.x, copyRect2.y);
    await sleep(300);
    await assertClipboard(page, blank, 'two', 'toolbar Copy button (selection)');

    // 7. Toolbar "Paste" button (uses the real Clipboard API from the
    // isolated world, because the page stubbed it in the main world).
    await writeClipboard(page, blank, 'PASTED-BY-BUTTON');
    await page.evaluate(() => {
      window.editor.setValue('toolbar-copy-value', -1);
      window.editor.navigateFileEnd();
      window.editor.clearSelection();
      window.editor.focus();
    });
    const pasteRect = await buttonRect(page, 'paste');
    await page.mouse.click(pasteRect.x, pasteRect.y);
    await sleep(700);
    value = await page.evaluate(() => window.editor.getValue());
    assert.strictEqual(value, 'toolbar-copy-valuePASTED-BY-BUTTON', 'toolbar Paste did not insert the clipboard text');
    console.log('ok - toolbar Paste button');

    // 7b. Ace must preserve a multi-line block's indentation too. Ace's own
    // paste path inserts the text verbatim; this guards against a future
    // adapter accidentally routing through a typing/auto-indent path.
    const aceIndentedPaste = [
      'async function main() {',
      '  try {',
      '    console.log("Connected");',
      '  } finally {',
      '    console.log("closed");',
      '  }',
      '}',
      '',
      'main();'
    ].join('\n');
    await writeClipboard(page, blank, aceIndentedPaste);
    await page.evaluate(() => {
      window.editor.setValue('START\n', -1);
      window.editor.navigateFileEnd();
      window.editor.clearSelection();
      window.editor.focus();
    });
    const aceIndentedRect = await buttonRect(page, 'paste');
    await page.mouse.click(aceIndentedRect.x, aceIndentedRect.y);
    await sleep(700);
    value = await page.evaluate(() => window.editor.getValue());
    assert.ok(
      value.endsWith(aceIndentedPaste),
      'Ace toolbar Paste should preserve the block indentation'
    );
    console.log('ok - Ace toolbar Paste preserves indentation');

    // 8. Alt+Shift+C / Alt+Shift+V work even when the page owns the keyboard.
    await page.evaluate(() => {
      window.editor.setValue('shortcut-value', -1);
      window.editor.navigateFileEnd();
      window.editor.clearSelection();
      window.editor.focus();
    });
    await altShiftKey(page, 'c');
    await sleep(250);
    await assertClipboard(page, blank, 'shortcut-value', 'Alt+Shift+C copies the whole file');

    await writeClipboard(page, blank, 'ALT-SHIFT-PASTE');
    await page.evaluate(() => {
      window.editor.navigateFileEnd();
      window.editor.clearSelection();
      window.editor.focus();
    });
    await altShiftKey(page, 'v');
    await sleep(500);
    value = await page.evaluate(() => window.editor.getValue());
    assert.strictEqual(value, 'shortcut-valueALT-SHIFT-PASTE', 'Alt+Shift+V did not paste');
    console.log('ok - Alt+Shift+V pastes');

    // 9. Right-click inside the editor opens the browser menu: the editor
    // container's capture-phase contextmenu suppressor must not cancel it.
    const contextMenuAllowed = await page.evaluate(() => {
      const target = document.querySelector('.ace_content');
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        view: window
      });
      return target.dispatchEvent(event);
    });
    assert.strictEqual(contextMenuAllowed, true, 'contextmenu was canceled inside the editor');
    console.log('ok - right-click is allowed inside the editor');

    // 10. Scoped behaviour: the page's blocker still protects fields outside
    // the code editor, so copying there must not overwrite the clipboard.
    await writeClipboard(page, blank, 'SENTINEL');
    await page.evaluate(() => window.updateOutside());
    await ctrlKey(page, 'c');
    await sleep(150);
    await assertClipboard(page, blank, 'SENTINEL', 'page blocker still applies outside the editor');

    assert.strictEqual(await toolbarDisplay(blank), 'none', 'toolbar should stay hidden on blank page');
    console.log('ok - toolbar stays hidden on pages without an editor');

    // 11. VS Code-style lab editor: the lockdown is applied before the editor
    // mounts. The extension repairs the APIs, shows the bar, and the editor
    // can register its own drag handlers again.
    const lab = await browser.newPage();
    lab.on('pageerror', (error) => errors.push(String(error)));
    await lab.goto(base + '/lab-fixture.html', { waitUntil: 'networkidle2', timeout: 30000 });
    await lab.waitForFunction(
      (id) => {
        const editor = document.querySelector('.monaco-editor[data-ready="1"]');
        const host = document.getElementById(id);
        return !!editor && !!host && host.style.display === 'block';
      },
      { timeout: 10000 },
      UI_ID
    );

    const labState = await lab.evaluate(() => {
      const wrap = document.querySelector('.monaco-editor');
      const event = new DragEvent('dragstart', { bubbles: true, cancelable: true });
      wrap.dispatchEvent(event);
      return {
        applied: window.__lockdownApplied === true,
        addRestored: EventTarget.prototype.addEventListener !== window.__lockdownAdd,
        execRestored: document.execCommand !== window.__lockdownExec,
        dragEvents: window.__dragEvents.length
      };
    });
    assert.strictEqual(labState.applied, true, 'lab fixture should apply the lockdown');
    assert.strictEqual(labState.addRestored, true, 'lab: addEventListener should be restored');
    assert.strictEqual(labState.execRestored, true, 'lab: execCommand should be restored');
    assert.ok(labState.dragEvents > 0, 'lab: drag handlers should register after the repair');
    console.log('ok - lab lockdown repaired and drag handlers work');

    await writeClipboard(lab, blank, 'SENTINEL');
    const labCopyRect = await buttonRect(lab, 'copy');
    await lab.mouse.click(labCopyRect.x, labCopyRect.y);
    await sleep(250);
    const labKeys = await lab.evaluate(() => window.__keys);
    assert.deepStrictEqual(labKeys, ['a'], 'lab: toolbar Copy should select all');
    const labCopied = await lab.evaluate(() => window.__copied);
    assert.strictEqual(labCopied, 'AAA\nBBB\nCCC', 'lab: copy event should carry the whole file');
    await assertClipboard(lab, blank, 'AAA\nBBB\nCCC', 'lab toolbar Copy writes the clipboard');

    // Ctrl+C with no selection must copy the whole file in the lab too.
    await writeClipboard(lab, blank, 'SENTINEL-2');
    await lab.evaluate(() => {
      const marker = document.querySelector('.monaco-editor .selected-text');
      if (marker) marker.remove();
      document.querySelector('.monaco-editor textarea').focus();
      window.__keys = [];
      window.__copied = '';
    });
    await ctrlKey(lab, 'c');
    await sleep(300);
    const labCtrlKeys = await lab.evaluate(() => window.__keys);
    assert.deepStrictEqual(labCtrlKeys, ['a'], 'lab: Ctrl+C with no selection should select all');
    const labCtrlCopied = await lab.evaluate(() => window.__copied);
    assert.strictEqual(labCtrlCopied, 'AAA\nBBB\nCCC', 'lab: Ctrl+C should copy the whole file');
    await assertClipboard(lab, blank, 'AAA\nBBB\nCCC', 'lab Ctrl+C with no selection copies the whole file');

    // A real Ctrl+V fires a native paste event, which is the path Monaco uses.
    await writeClipboard(lab, blank, 'NATIVE-PASTE');
    await lab.evaluate(() => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      window.__pasted = '';
    });
    await ctrlKey(lab, 'v');
    await sleep(300);
    const labPasted = await lab.evaluate(() => window.__pasted);
    assert.strictEqual(labPasted, 'NATIVE-PASTE', 'lab: Ctrl+V should fire a native paste event');
    const labPasteValue = await lab.evaluate(
      () => document.querySelector('.monaco-editor textarea').value
    );
    assert.ok(labPasteValue.includes('NATIVE-PASTE'), 'lab: Ctrl+V should insert the clipboard text');
    console.log('ok - lab Ctrl+C / Ctrl+V work');

    // Toolbar Paste must use Monaco's paste path, not execCommand('insertText').
    // The latter is treated as typing and Monaco auto-indents every line, so a
    // multi-line block drifts to the right. The fixture records the paste event
    // text, which is only set by the paste path.
    const indentedPaste = [
      'const mongoose = require("mongoose");',
      '',
      'async function main() {',
      '  try {',
      '    console.log("Connected");',
      '  } finally {',
      '    console.log("closed");',
      '  }',
      '}',
      '',
      'main();'
    ].join('\n');
    await writeClipboard(lab, blank, indentedPaste);
    await lab.evaluate(() => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      window.__pasted = '';
    });
    const labPasteRect = await buttonRect(lab, 'paste');
    await lab.mouse.click(labPasteRect.x, labPasteRect.y);
    await sleep(600);
    const labPaste = await lab.evaluate(() => ({
      pasted: window.__pasted,
      value: document.querySelector('.monaco-editor textarea').value
    }));
    assert.strictEqual(
      labPaste.pasted,
      indentedPaste,
      'lab: toolbar Paste should fire a paste event with the exact text'
    );
    assert.ok(
      labPaste.value.endsWith(indentedPaste),
      'lab: toolbar Paste should preserve the pasted indentation'
    );
    console.log('ok - lab toolbar Paste works without auto-indenting');

    // Native fallback: some workbench builds ignore synthetic (untrusted)
    // paste events. The isolated world's real paste command must still reach
    // Monaco's paste handler instead of falling through to insertText.
    await writeClipboard(lab, blank, indentedPaste);
    await lab.evaluate(() => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      window.__pasted = '';
      window.__ccSkipSyntheticPaste = true;
    });
    const nativePasteRect = await buttonRect(lab, 'paste');
    await lab.mouse.click(nativePasteRect.x, nativePasteRect.y);
    await sleep(900);
    const nativePaste = await lab.evaluate(() => ({
      pasted: window.__pasted,
      value: document.querySelector('.monaco-editor textarea').value
    }));
    await lab.evaluate(() => {
      window.__ccSkipSyntheticPaste = false;
    });
    // The browser's native paste command uses the platform's line endings
    // (CRLF on Windows). Monaco normalizes them to LF in its model, so compare
    // after normalizing here as well.
    const nativePasted = nativePaste.pasted.replace(/\r\n?/g, '\n');
    const nativeValue = nativePaste.value.replace(/\r\n?/g, '\n');
    assert.strictEqual(
      nativePasted,
      indentedPaste,
      'native fallback should fire a paste event with the exact text'
    );
    assert.ok(
      nativeValue.endsWith(indentedPaste),
      'native fallback should preserve the pasted indentation'
    );
    console.log('ok - native fallback paste preserves indentation');

    // Exact real-world sequence: the workbench ignores synthetic paste events,
    // so the extension must fall back to the browser's real paste command.
    // It must fire exactly one trusted paste event, not zero or two.
    const ignore = await browser.newPage();
    ignore.on('pageerror', (error) => errors.push(String(error)));
    await ignore.goto(base + '/lab-fixture.html?ignore-synthetic=1', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await ignore.waitForFunction(
      (id) => {
        const editor = document.querySelector('.monaco-editor[data-ready="1"]');
        const host = document.getElementById(id);
        return !!editor && !!host && host.style.display === 'block';
      },
      { timeout: 10000 },
      UI_ID
    );
    await writeClipboard(ignore, blank, indentedPaste);
    await ignore.evaluate(() => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      window.__pasted = '';
      window.__pasteCount = 0;
    });
    const ignorePasteRect = await buttonRect(ignore, 'paste');
    await ignore.mouse.click(ignorePasteRect.x, ignorePasteRect.y);
    await sleep(900);
    const ignorePaste = await ignore.evaluate(() => ({
      pasted: window.__pasted,
      count: window.__pasteCount,
      value: document.querySelector('.monaco-editor textarea').value
    }));
    assert.strictEqual(
      ignorePaste.count,
      1,
      'ignored synthetic paste should fall back to exactly one native paste'
    );
    assert.strictEqual(
      ignorePaste.pasted.replace(/\r\n?/g, '\n'),
      indentedPaste,
      'native fallback should carry the exact text'
    );
    assert.ok(
      ignorePaste.value.replace(/\r\n?/g, '\n').endsWith(indentedPaste),
      'native fallback should preserve indentation after an ignored synthetic event'
    );
    await ignore.close();
    console.log('ok - ignored synthetic paste falls back to one native paste');

    // The diagnostic shortcut reports the loaded version and the last paste
    // path, so a stale build or a fallback paste is visible without DevTools.
    await altShiftKey(lab, 'd');
    await sleep(150);
    const diagnostic = await toastText(lab);
    assert.ok(diagnostic.includes('v1.1.8'), 'diagnostic should report version 1.1.8: ' + diagnostic);
    assert.ok(diagnostic.includes('monaco-dom'), 'diagnostic should report the adapter: ' + diagnostic);
    assert.ok(
      /paste: (paste|native)/.test(diagnostic),
      'diagnostic should report the paste path: ' + diagnostic
    );
    console.log('ok - diagnostic reports version and paste path');

    // 12. VS Code workbench with an accessible service collection. The
    // extension should find the code editor service and insert through
    // executeEdits, which is a direct model edit. It must not use a paste
    // event or insertText, because both can run Monaco's auto-indent and
    // corrupt brace-heavy blocks.
    const workbench = await browser.newPage();
    workbench.on('pageerror', (error) => errors.push(String(error)));
    await workbench.goto(base + '/workbench-fixture.html', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await workbench.waitForFunction(
      (id) => {
        const editor = document.querySelector('.monaco-editor[data-ready="1"]');
        const host = document.getElementById(id);
        return !!editor && !!host && host.style.display === 'block';
      },
      { timeout: 10000 },
      UI_ID
    );

    await writeClipboard(workbench, blank, indentedPaste);
    await workbench.evaluate(() => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      window.__workbenchEdits = [];
      window.__pasteFired = false;
    });
    const workbenchPasteRect = await buttonRect(workbench, 'paste');
    await workbench.mouse.click(workbenchPasteRect.x, workbenchPasteRect.y);
    await sleep(700);
    const workbenchPaste = await workbench.evaluate(() => ({
      edits: window.__workbenchEdits,
      pasteFired: window.__pasteFired,
      value: document.querySelector('.monaco-editor textarea').value
    }));
    assert.strictEqual(
      workbenchPaste.edits.length,
      1,
      'workbench: toolbar Paste should use executeEdits once'
    );
    assert.strictEqual(
      workbenchPaste.edits[0].source,
      'codechef-clipboard',
      'workbench: executeEdits should use the extension source id'
    );
    assert.strictEqual(
      workbenchPaste.edits[0].text,
      indentedPaste,
      'workbench: executeEdits should receive the exact text'
    );
    assert.strictEqual(
      workbenchPaste.pasteFired,
      false,
      'workbench: toolbar Paste must not use a paste event'
    );
    assert.ok(
      workbenchPaste.value.endsWith(indentedPaste),
      'workbench: toolbar Paste should preserve indentation'
    );
    console.log('ok - workbench toolbar Paste uses exact executeEdits');

    // Ctrl+V must route through the workbench adapter too.
    await workbench.evaluate(() => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      window.__workbenchEdits = [];
      window.__pasteFired = false;
    });
    await ctrlKey(workbench, 'v');
    await sleep(700);
    const workbenchCtrlV = await workbench.evaluate(() => ({
      edits: window.__workbenchEdits,
      pasteFired: window.__pasteFired,
      value: document.querySelector('.monaco-editor textarea').value
    }));
    assert.strictEqual(
      workbenchCtrlV.edits.length,
      1,
      'workbench: Ctrl+V should use executeEdits once'
    );
    assert.strictEqual(
      workbenchCtrlV.edits[0].text,
      indentedPaste,
      'workbench: Ctrl+V should receive the exact text'
    );
    assert.strictEqual(
      workbenchCtrlV.pasteFired,
      false,
      'workbench: Ctrl+V must not use a paste event'
    );
    assert.ok(
      workbenchCtrlV.value.endsWith(indentedPaste),
      'workbench: Ctrl+V should preserve indentation'
    );
    console.log('ok - workbench Ctrl+V uses exact executeEdits');

    // Alt+Shift+V must use the same exact-edit path.
    await workbench.evaluate(() => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      window.__workbenchEdits = [];
      window.__pasteFired = false;
    });
    await altShiftKey(workbench, 'v');
    await sleep(700);
    const workbenchAltV = await workbench.evaluate(() => ({
      edits: window.__workbenchEdits,
      pasteFired: window.__pasteFired,
      value: document.querySelector('.monaco-editor textarea').value
    }));
    assert.strictEqual(
      workbenchAltV.edits.length,
      1,
      'workbench: Alt+Shift+V should use executeEdits once'
    );
    assert.strictEqual(
      workbenchAltV.edits[0].text,
      indentedPaste,
      'workbench: Alt+Shift+V should receive the exact text'
    );
    assert.ok(
      workbenchAltV.value.endsWith(indentedPaste),
      'workbench: Alt+Shift+V should preserve indentation'
    );
    console.log('ok - workbench Alt+Shift+V uses exact executeEdits');

    // A non-empty selection must be replaced exactly, not expanded.
    await workbench.evaluate(() => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.value = 'AAA\nSTART\nBBB';
      textarea.focus();
      const start = textarea.value.indexOf('START');
      textarea.setSelectionRange(start, start + 'START'.length);
      window.__workbenchEdits = [];
      window.__pasteFired = false;
    });
    const workbenchReplaceRect = await buttonRect(workbench, 'paste');
    await workbench.mouse.click(workbenchReplaceRect.x, workbenchReplaceRect.y);
    await sleep(700);
    const workbenchReplace = await workbench.evaluate(() => ({
      edits: window.__workbenchEdits,
      value: document.querySelector('.monaco-editor textarea').value
    }));
    assert.strictEqual(
      workbenchReplace.edits.length,
      1,
      'workbench: replace should use executeEdits once'
    );
    assert.strictEqual(
      workbenchReplace.value,
      'AAA\n' + indentedPaste + '\nBBB',
      'workbench: executeEdits should replace exactly the selected range'
    );
    console.log('ok - workbench Paste replaces the selection exactly');

    // The diagnostic should identify the workbench adapter and exact path.
    await altShiftKey(workbench, 'd');
    await sleep(150);
    const workbenchDiagnostic = await toastText(workbench);
    assert.ok(
      workbenchDiagnostic.includes('monaco-workbench'),
      'workbench diagnostic should report the adapter: ' + workbenchDiagnostic
    );
    assert.ok(
      workbenchDiagnostic.includes('paste: workbench'),
      'workbench diagnostic should report the exact paste path: ' + workbenchDiagnostic
    );
    console.log('ok - workbench diagnostic reports the exact paste path');

    await workbench.close();

    // 13. Live workbench embedder shape: window.workbench is the embedder API
    // ({ commands, env, ... }), not a DI service collection. The extension
    // must use the workbench's low-level paste command, which triggers
    // Monaco's exact paste edit path, instead of falling back to the DOM
    // adapter's native paste (which can hit Monaco's auto-indenting typing
    // path).
    const commandWorkbench = await browser.newPage();
    commandWorkbench.on('pageerror', (error) => errors.push(String(error)));
    await commandWorkbench.goto(base + '/workbench-command-fixture.html', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await commandWorkbench.waitForFunction(
      (id) => {
        const editor = document.querySelector('.monaco-editor[data-ready="1"]');
        const host = document.getElementById(id);
        return !!editor && !!host && host.style.display === 'block';
      },
      { timeout: 10000 },
      UI_ID
    );

    await writeClipboard(commandWorkbench, blank, indentedPaste);
    await commandWorkbench.evaluate(() => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.value = 'START';
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      window.__workbenchCommands = [];
      window.__pasteFired = false;
    });
    const commandPasteRect = await buttonRect(commandWorkbench, 'paste');
    await commandWorkbench.mouse.click(commandPasteRect.x, commandPasteRect.y);
    await sleep(700);
    const commandPaste = await commandWorkbench.evaluate(() => ({
      commands: window.__workbenchCommands,
      pasteFired: window.__pasteFired,
      value: document.querySelector('.monaco-editor textarea').value
    }));
    assert.strictEqual(
      commandPaste.commands.length,
      1,
      'command workbench: toolbar Paste should invoke the paste command once'
    );
    assert.strictEqual(
      commandPaste.commands[0].id,
      'paste',
      'command workbench: the extension should use the paste command'
    );
    assert.strictEqual(
      commandPaste.commands[0].args.text,
      indentedPaste,
      'command workbench: the paste command should receive the exact text'
    );
    assert.strictEqual(
      commandPaste.commands[0].args.pasteOnNewLine,
      false,
      'command workbench: pasteOnNewLine must stay off'
    );
    assert.strictEqual(
      commandPaste.pasteFired,
      false,
      'command workbench: toolbar Paste must not use a DOM paste event'
    );
    assert.ok(
      commandPaste.value.endsWith(indentedPaste),
      'command workbench: toolbar Paste should preserve indentation'
    );
    const commandToast = await toastText(commandWorkbench);
    assert.ok(
      commandToast.includes('workbench-command'),
      'command workbench: success toast should name the command path: ' + commandToast
    );
    console.log('ok - workbench command toolbar Paste preserves indentation exactly');

    // Native Ctrl+V must also route through the workbench command path.
    await commandWorkbench.evaluate(() => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.value = 'START';
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      window.__workbenchCommands = [];
      window.__pasteFired = false;
    });
    await ctrlKey(commandWorkbench, 'v');
    await sleep(700);
    const commandCtrlV = await commandWorkbench.evaluate(() => ({
      commands: window.__workbenchCommands,
      pasteFired: window.__pasteFired,
      value: document.querySelector('.monaco-editor textarea').value
    }));
    assert.strictEqual(
      commandCtrlV.commands.length,
      1,
      'command workbench: Ctrl+V should invoke the paste command once'
    );
    assert.strictEqual(
      commandCtrlV.commands[0].args.text,
      indentedPaste,
      'command workbench: Ctrl+V should pass the exact text'
    );
    assert.strictEqual(
      commandCtrlV.pasteFired,
      false,
      'command workbench: Ctrl+V must not use the DOM paste path'
    );
    assert.ok(
      commandCtrlV.value.endsWith(indentedPaste),
      'command workbench: Ctrl+V should preserve indentation'
    );
    console.log('ok - workbench command Ctrl+V preserves indentation exactly');

    // Alt+Shift+V must use the same command path.
    await commandWorkbench.evaluate(() => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.value = 'START';
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      window.__workbenchCommands = [];
      window.__pasteFired = false;
    });
    await altShiftKey(commandWorkbench, 'v');
    await sleep(700);
    const commandAltV = await commandWorkbench.evaluate(() => ({
      commands: window.__workbenchCommands,
      value: document.querySelector('.monaco-editor textarea').value
    }));
    assert.strictEqual(
      commandAltV.commands.length,
      1,
      'command workbench: Alt+Shift+V should invoke the paste command once'
    );
    assert.strictEqual(
      commandAltV.commands[0].args.text,
      indentedPaste,
      'command workbench: Alt+Shift+V should pass the exact text'
    );
    assert.ok(
      commandAltV.value.endsWith(indentedPaste),
      'command workbench: Alt+Shift+V should preserve indentation'
    );
    console.log('ok - workbench command Alt+Shift+V preserves indentation exactly');

    // Toolbar Copy must use the workbench's own select-all and copy commands.
    // The plain textarea fixture stands in for the editor model: the old DOM
    // path would press a synthetic Ctrl+A and copy the rendered selection
    // instead of invoking these commands. A real workbench copy action reads
    // the model selection, so folded lines are included and no `…` marker can
    // leak into the clipboard.
    const commandCopyText = 'alpha\nbeta\ngamma\n';
    await commandWorkbench.evaluate((text) => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.value = text;
      textarea.focus();
      textarea.setSelectionRange(text.length, text.length);
      window.__workbenchCommands = [];
      window.__copied = '';
    }, commandCopyText);
    const commandCopyRect = await buttonRect(commandWorkbench, 'copy');
    await commandWorkbench.mouse.click(commandCopyRect.x, commandCopyRect.y);
    await sleep(300);
    const commandCopy = await commandWorkbench.evaluate(() => ({
      commands: window.__workbenchCommands,
      copied: window.__copied,
      value: document.querySelector('.monaco-editor textarea').value
    }));
    assert.deepStrictEqual(
      commandCopy.commands.map((entry) => entry.id),
      ['editor.action.selectAll', 'editor.action.clipboardCopyAction'],
      'command workbench: toolbar Copy should use the workbench copy commands'
    );
    assert.strictEqual(
      commandCopy.copied,
      commandCopyText,
      'command workbench: toolbar Copy should copy the whole model text'
    );
    assert.strictEqual(
      commandCopy.value,
      commandCopyText,
      'command workbench: toolbar Copy must not modify the editor'
    );
    await assertClipboard(
      commandWorkbench,
      blank,
      commandCopyText,
      'workbench command toolbar Copy writes the whole file'
    );
    const commandCopyToast = await toastText(commandWorkbench);
    assert.ok(
      commandCopyToast.includes('workbench-command'),
      'command workbench: copy toast should name the command path: ' + commandCopyToast
    );
    console.log('ok - workbench command toolbar Copy uses the model copy path');

    // With a selection, Copy must not select all. It should keep the model
    // selection and run only the workbench copy action.
    await commandWorkbench.evaluate(() => {
      const container = document.querySelector('.monaco-editor');
      const textarea = container.querySelector('textarea');
      textarea.value = 'alpha\nbeta\ngamma';
      textarea.focus();
      textarea.setSelectionRange(6, 10);
      const marker = document.createElement('span');
      marker.className = 'selected-text';
      marker.textContent = 'beta';
      container.appendChild(marker);
      window.__workbenchCommands = [];
      window.__copied = '';
    });
    const commandSelectionCopyRect = await buttonRect(commandWorkbench, 'copy');
    await commandWorkbench.mouse.click(commandSelectionCopyRect.x, commandSelectionCopyRect.y);
    await sleep(300);
    const commandSelectionCopy = await commandWorkbench.evaluate(() => ({
      commands: window.__workbenchCommands,
      copied: window.__copied
    }));
    assert.deepStrictEqual(
      commandSelectionCopy.commands.map((entry) => entry.id),
      ['editor.action.clipboardCopyAction'],
      'command workbench: Copy with a selection should not select all'
    );
    assert.strictEqual(
      commandSelectionCopy.copied,
      'beta',
      'command workbench: Copy with a selection should copy only the selection'
    );
    await assertClipboard(
      commandWorkbench,
      blank,
      'beta',
      'workbench command toolbar Copy writes the selection'
    );
    await commandWorkbench.evaluate(() => {
      const marker = document.querySelector('.monaco-editor .selected-text');
      if (marker) marker.remove();
    });
    console.log('ok - workbench command toolbar Copy preserves a selection');

    // Ctrl+C with a selection must also use the command path, without
    // selecting all. This is the Ctrl+A then Ctrl+C case.
    await commandWorkbench.evaluate(() => {
      const container = document.querySelector('.monaco-editor');
      const textarea = container.querySelector('textarea');
      textarea.value = 'alpha\nbeta\ngamma';
      textarea.focus();
      textarea.setSelectionRange(6, 10);
      const marker = document.createElement('span');
      marker.className = 'selected-text';
      marker.textContent = 'beta';
      container.appendChild(marker);
      window.__workbenchCommands = [];
      window.__copied = '';
    });
    await ctrlKey(commandWorkbench, 'c');
    await sleep(300);
    const commandSelectionCtrlC = await commandWorkbench.evaluate(() => ({
      commands: window.__workbenchCommands,
      copied: window.__copied
    }));
    assert.deepStrictEqual(
      commandSelectionCtrlC.commands.map((entry) => entry.id),
      ['editor.action.clipboardCopyAction'],
      'command workbench: Ctrl+C with a selection should not select all'
    );
    assert.strictEqual(
      commandSelectionCtrlC.copied,
      'beta',
      'command workbench: Ctrl+C with a selection should copy only the selection'
    );
    await assertClipboard(
      commandWorkbench,
      blank,
      'beta',
      'workbench command Ctrl+C writes the selection'
    );
    await commandWorkbench.evaluate(() => {
      const marker = document.querySelector('.monaco-editor .selected-text');
      if (marker) marker.remove();
    });
    console.log('ok - workbench command Ctrl+C preserves a selection');

    // Ctrl+C with no selection must use the same command path, not the
    // synthetic Ctrl+A + DOM copy fallback.
    await commandWorkbench.evaluate((text) => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.value = text;
      textarea.focus();
      textarea.setSelectionRange(text.length, text.length);
      window.__workbenchCommands = [];
      window.__copied = '';
    }, commandCopyText);
    await ctrlKey(commandWorkbench, 'c');
    await sleep(300);
    const commandCtrlC = await commandWorkbench.evaluate(() => ({
      commands: window.__workbenchCommands,
      copied: window.__copied
    }));
    assert.deepStrictEqual(
      commandCtrlC.commands.map((entry) => entry.id),
      ['editor.action.selectAll', 'editor.action.clipboardCopyAction'],
      'command workbench: Ctrl+C with no selection should use the workbench copy commands'
    );
    assert.strictEqual(
      commandCtrlC.copied,
      commandCopyText,
      'command workbench: Ctrl+C with no selection should copy the whole model text'
    );
    await assertClipboard(
      commandWorkbench,
      blank,
      commandCopyText,
      'workbench command Ctrl+C with no selection writes the whole file'
    );
    console.log('ok - workbench command Ctrl+C with no selection copies the whole file');

    // The clickable version label must show the same diagnostic as the
    // shortcut. The live page has no usable Alt+Shift+D on Windows, so the
    // label is the reliable way to report the adapter and paste/copy path.
    const versionRect = await buttonRect(commandWorkbench, 'diag');
    await commandWorkbench.mouse.click(versionRect.x, versionRect.y);
    await sleep(200);
    const commandDiagnostic = await toastText(commandWorkbench);
    assert.ok(
      commandDiagnostic.includes('monaco-workbench-command'),
      'command workbench: diagnostic should report the command adapter: ' + commandDiagnostic
    );
    assert.ok(
      commandDiagnostic.includes('workbench: yes'),
      'command workbench: diagnostic should report workbench presence: ' + commandDiagnostic
    );
    assert.ok(
      commandDiagnostic.includes('commands: yes'),
      'command workbench: diagnostic should report command availability: ' + commandDiagnostic
    );
    assert.ok(
      commandDiagnostic.includes('paste: workbench-command'),
      'command workbench: diagnostic should report the command paste path: ' + commandDiagnostic
    );
    assert.ok(
      commandDiagnostic.includes('copy: workbench-command'),
      'command workbench: diagnostic should report the command copy path: ' + commandDiagnostic
    );
    console.log('ok - workbench version label reports the command diagnostic');

    await commandWorkbench.close();

    // 14. Worst-case timing: the editor registers its clipboard handlers in the
    // same task as the lockdown, before the 50 ms repair poll can run. The
    // page's patched addEventListener would normally drop those handlers and
    // leave native paste to Monaco's auto-indenting typing path.
    const race = await browser.newPage();
    race.on('pageerror', (error) => errors.push(String(error)));
    await race.goto(base + '/lab-fixture.html?immediate=1', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await race.waitForFunction(
      (id) => {
        const editor = document.querySelector('.monaco-editor[data-ready="1"]');
        const host = document.getElementById(id);
        return !!editor && !!host && host.style.display === 'block';
      },
      { timeout: 10000 },
      UI_ID
    );

    await writeClipboard(race, blank, indentedPaste);
    await race.evaluate(() => {
      const textarea = document.querySelector('.monaco-editor textarea');
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      window.__pasted = '';
    });
    const racePasteRect = await buttonRect(race, 'paste');
    await race.mouse.click(racePasteRect.x, racePasteRect.y);
    await sleep(600);
    const racePaste = await race.evaluate(() => ({
      pasted: window.__pasted,
      value: document.querySelector('.monaco-editor textarea').value
    }));
    assert.strictEqual(
      racePaste.pasted,
      indentedPaste,
      'race: editor paste handler should register during the lockdown'
    );
    assert.ok(
      racePaste.value.endsWith(indentedPaste),
      'race: toolbar Paste should preserve indentation even with immediate mount'
    );
    console.log('ok - editor clipboard handlers survive an immediate mount');

    await race.close();
    await lab.close();

    const extensionErrors = errors.filter(
      (text) => /content-main\.js|content-isolated\.js|Uncaught/.test(text)
    );
    assert.deepStrictEqual(extensionErrors, [], 'extension logged errors: ' + extensionErrors.join('\n'));

    console.log('\nAll tests passed.');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error('\nTest failure:', error);
  process.exitCode = 1;
});
