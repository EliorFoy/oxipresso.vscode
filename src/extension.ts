import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Oxipresso Live Preview: spawns the oxipresso render server next to a .tex
// document, speaks the TeXpresso editor wire protocol over its stdio, and
// shows the pages the server renders into OXIPRESSO_PAGES_OUT inside a
// webview. The editor->preview page sync maps the edited source line through
// the lines.json breakpoint map the server writes after every pass.
// ─────────────────────────────────────────────────────────────────────────────

let child: ChildProcess | undefined;
let outChannel: vscode.OutputChannel | undefined;
let panel: vscode.WebviewPanel | undefined;
let pagesWatcher: fs.FSWatcher | undefined;
let pagesPoll: NodeJS.Timeout | undefined;
let disposables: vscode.Disposable[] = [];

let docUri: vscode.Uri | undefined;
let wireName = '';
let engineLen = 0;
let lastSent = '';
let pendingText: string | undefined;
let inFlight = false;
let lastSendAt = 0;

let pagesDir = '';
let generation = 0;
let pageCount = 0;
let editPage = 0;
let breakpoints: Array<[number, number]> = [];

const escapeWireString = (text: string): string =>
    text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');

const firstDiff = (previous: string, current: string): number => {
    const prev = Buffer.from(previous, 'utf8');
    const cur = Buffer.from(current, 'utf8');
    const common = Math.min(prev.length, cur.length);
    let i = 0;
    while (i < common && prev[i] === cur[i]) {
        i += 1;
    }
    return i;
};

const lineOfOffset = (text: string, byteOffset: number): number => {
    const buf = Buffer.from(text, 'utf8');
    let boundary = Math.min(byteOffset, buf.length);
    while (boundary > 0 && (buf[boundary] & 0xc0) === 0x80) {
        boundary -= 1; // land on a UTF-8 char boundary
    }
    const prefix = buf.subarray(0, boundary).toString('utf8');
    return 1 + (prefix.match(/\n/g) || []).length;
};

// lines.json breakpoints are [line, page] pairs sorted by line; the page for
// a cursor line is the page of the greatest breakpoint at or below it.
const pageForLine = (line: number): number => {
    if (breakpoints.length === 0) {
        return 0;
    }
    let lo = 0;
    let hi = breakpoints.length - 1;
    let page = breakpoints[0][1];
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (breakpoints[mid][0] <= line) {
            page = breakpoints[mid][1];
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return page;
};

const sendLine = (line: string): void => {
    if (child && child.stdin && child.stdin.writable) {
        child.stdin.write(line + '\n');
        outChannel?.appendLine('>> ' + line.slice(0, 120));
    }
};

const pushPagesToWebview = (): void => {
    if (!panel) {
        return;
    }
    const uris: string[] = [];
    for (let i = 1; i <= pageCount; i += 1) {
        const file = path.join(pagesDir, 'page-' + i + '.png');
        uris.push(panel.webview.asWebviewUri(vscode.Uri.file(file)).toString());
    }
    panel.webview.postMessage({
        type: 'pages',
        uris,
        width: pagesWidth,
        height: pagesHeight,
    });
    if (editPage > 0) {
        panel.webview.postMessage({ type: 'scrollTo', page: editPage });
    }
};

let pagesWidth = 0;
let pagesHeight = 0;

const adoptManifest = (dir: string): void => {
    try {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
        );
        if (manifest.generation === generation) {
            return; // nothing new since the last adoption
        }
        generation = manifest.generation;
        pageCount = manifest.pages || 0;
        pagesWidth = manifest.pageWidth || 0;
        pagesHeight = manifest.pageHeight || 0;
        editPage = manifest.editPage || 0;
        pushPagesToWebview();
    } catch {
        // a half-written manifest is rare (tmp+rename); retry on the next tick
    }
    try {
        const lines = JSON.parse(
            fs.readFileSync(path.join(dir, 'lines.json'), 'utf8')
        );
        if (lines.input && lines.breakpoints) {
            breakpoints = lines.breakpoints;
        }
    } catch {
        // lines.json is optional for rendering
    }
};

const adoptPagesDir = (dir: string): void => {
    pagesDir = dir;
    adoptManifest(dir);
    if (pagesWatcher) {
        pagesWatcher.close();
    }
    try {
        pagesWatcher = fs.watch(dir, (_event, file) => {
            if (file === 'manifest.json' || file === 'lines.json') {
                setTimeout(() => adoptManifest(dir), 60);
            }
        });
    } catch {
        // the dir may not exist yet; the poll below catches up
    }
    if (pagesPoll) {
        clearInterval(pagesPoll);
    }
    pagesPoll = setInterval(() => {
        if (fs.existsSync(path.join(dir, 'manifest.json'))) {
            adoptManifest(dir);
        }
    }, 700);
};

const stopServer = (): void => {
    if (pagesWatcher) {
        pagesWatcher.close();
        pagesWatcher = undefined;
    }
    if (pagesPoll) {
        clearInterval(pagesPoll);
        pagesPoll = undefined;
    }
    if (child) {
        try {
            child.stdin?.write('(pause)\n');
            child.stdin?.end();
        } catch {
            // already gone
        }
        const dying = child;
        child = undefined;
        setTimeout(() => dying.kill(), 300);
    }
    panel?.dispose();
};

const openPreview = async (): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document.fileName.endsWith('.tex')) {
        vscode.window.showErrorMessage('Oxipresso: open a .tex file first');
        return;
    }
    const doc = editor.document;
    docUri = doc.uri;
    wireName = path.basename(doc.fileName);
    const cfg = vscode.workspace.getConfiguration('oxipresso');
    const enginePath = cfg.get<string>('enginePath', 'oxipresso');
    const renderScale = cfg.get<number>('renderScale', 2);
    const formatPath = cfg.get<string>('formatPath', '');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oxipresso-'));
    pagesDir = path.join(tmp, 'pages');

    if (panel) {
        panel.dispose();
    }
    panel = vscode.window.createWebviewPanel(
        'oxipressoPreview',
        'Oxipresso Preview — ' + path.basename(doc.fileName),
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(pagesDir)],
        }
    );
    panel.webview.html = webviewHtml(panel.webview);
    panel.onDidDispose(() => stopServer());

    outChannel = outChannel ?? vscode.window.createOutputChannel('Oxipresso');
    outChannel.show(true);

    const initial = fs.readFileSync(doc.fileName);
    engineLen = initial.length;
    lastSent = doc.getText();

    const env = {
        ...process.env,
        OXIPRESSO_RESIDENT: '1',
        OXIPRESSO_ARTIFACT_OUT: path.join(tmp, 'document.xdv'),
        OXIPRESSO_SYNCTEX_OUT: path.join(tmp, 'document.synctex'),
        OXIPRESSO_PAGES_OUT: pagesDir,
        ...(renderScale !== 2 ? { OXIPRESSO_RENDER_SCALE: String(renderScale) } : {}),
        ...(formatPath ? { OXIPRESSO_XETEX_FORMAT: formatPath } : {}),
    };
    child = spawn(enginePath, ['-stream', doc.fileName], {
        cwd: path.dirname(doc.fileName),
        env,
    });
    child.stderr?.on('data', (chunk: Buffer) => {
        outChannel?.append(chunk.toString());
    });
    child.on('exit', (code) => {
        outChannel?.appendLine(`[oxipresso] server exited (${code})`);
        panel?.webview.postMessage({ type: 'serverExited', code });
    });

    // The init dance: register → open (base64) → resume.
    sendLine(`(register ${escapeWireString(wireName)})`);
    sendLine(
        `(open-base64 ${escapeWireString(wireName)} "${initial.toString('base64')}")`
    );
    sendLine('(resume)');

    // The wire: line-framed notices. `(flush)` marks the end of a pass —
    // the in-flight throttle releases there so a typing burst costs one pass.
    let stdoutBuf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        let index: number;
        while ((index = stdoutBuf.indexOf('\n')) >= 0) {
            const line = stdoutBuf.slice(0, index);
            stdoutBuf = stdoutBuf.slice(index + 1);
            outChannel?.appendLine('<< ' + line.slice(0, 160));
            if (line.trim() === '(flush)') {
                inFlight = false;
            }
        }
    });

    adoptPagesDir(pagesDir);

    // Coalesced edits: the latest buffer text wins; send when the previous
    // pass finished (its `(flush)` arrived) or after a 1.2s deadline.
    const sendTimer = setInterval(() => {
        if (pendingText === undefined || !panel) {
            return;
        }
        const maySend = !inFlight || Date.now() - lastSendAt > 1200;
        if (!maySend) {
            return;
        }
        const text = pendingText;
        pendingText = undefined;
        const oldLen = engineLen;
        const editOffset = firstDiff(lastSent, text);
        const editLine = lineOfOffset(text, editOffset);
        engineLen = Buffer.from(text, 'utf8').length;
        lastSent = text;
        inFlight = true;
        lastSendAt = Date.now();
        void editLine; // the server derives editLine/editPage itself
        sendLine(
            `(change ${escapeWireString(wireName)} 0 ${oldLen} ${escapeWireString(text)})`
        );
    }, 150);
    disposables.push({ dispose: () => clearInterval(sendTimer) });

    // The editor->preview page sync: the cursor's line maps through the
    // lines.json breakpoints; the webview scrolls to that page.
    disposables.push(
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (docUri && event.textEditor.document.uri.fsPath === docUri.fsPath) {
                const line = (event.selections[0]?.active.line ?? 0) + 1;
                const target = pageForLine(line);
                if (target > 0 && panel) {
                    panel.webview.postMessage({ type: 'scrollTo', page: target });
                }
            }
        })
    );
};

const webviewHtml = (webview: vscode.Webview): string => {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  body { background: #1e1e2e; color: #cdd6f4; margin: 0; padding: 0; font-family: sans-serif; }
  .page { display: block; width: 92%; margin: 12px auto; box-shadow: 0 2px 14px rgba(0,0,0,.5); background: #fff; }
  #empty { color: #6c7086; text-align: center; margin-top: 40vh; }
</style></head>
<body>
<div id="empty">waiting for the first pass…</div>
<div id="pages"></div>
<script>
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'pages') {
      document.getElementById('empty').style.display = msg.uris.length ? 'none' : 'block';
      const holder = document.getElementById('pages');
      holder.innerHTML = '';
      msg.uris.forEach((uri, i) => {
        const img = document.createElement('img');
        img.className = 'page';
        img.id = 'page-' + (i + 1);
        img.src = uri;
        img.width = msg.width;
        img.height = msg.height;
        holder.appendChild(img);
      });
    } else if (msg.type === 'scrollTo') {
      const el = document.getElementById('page-' + msg.page);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    } else if (msg.type === 'serverExited') {
      const el = document.getElementById('empty');
      el.style.display = 'block';
      el.textContent = 'render server exited (code ' + msg.code + ')';
    }
  });
</script>
</body></html>`;
};

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('oxipresso.openPreview', openPreview),
        vscode.commands.registerCommand('oxipresso.stop', () => stopServer()),
        { dispose: () => stopServer() }
    );
}

export function deactivate(): void {
    stopServer();
}