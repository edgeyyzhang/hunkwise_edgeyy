import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { computeHunks, hunkId, WordRange } from './diffEngine';
import { ColorOverrides } from './hunkwiseGit';
import { log } from './log';

// Strip CSS-breaking characters so user-supplied color strings can't escape an
// inline style attribute or rule body. Allows hex, named colors, rgb/rgba,
// hsl/hsla, percentages, and whitespace.
function sanitizeCssColor(s: string): string {
  return s.replace(/[<>"';{}\\]/g, '');
}

// ── HTML helpers ─────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Render a single removed line, splicing <span class="word-changed"> around any
// sub-line ranges that diffWordsWithSpace reported as changed.
function renderRemovedLineHtml(line: string, ranges: WordRange[]): string {
  if (ranges.length === 0) return escapeHtml(line);
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const r of sorted) {
    if (r.start > cursor) out += escapeHtml(line.slice(cursor, r.start));
    out += `<span class="word-changed">${escapeHtml(line.slice(r.start, r.end))}</span>`;
    cursor = r.end;
  }
  if (cursor < line.length) out += escapeHtml(line.slice(cursor));
  return out;
}

// ── Deleted-lines inset ───────────────────────────────────────────────────────
function buildDeletedHtml(lines: string[], tabSize: number, wordRanges: WordRange[], colors: ColorOverrides): string {
  const byLine = new Map<number, WordRange[]>();
  for (const r of wordRanges) {
    const list = byLine.get(r.lineOffset);
    if (list) list.push(r); else byLine.set(r.lineOffset, [r]);
  }
  const rows = lines.map((l, i) =>
    `<div class="line">${renderRemovedLineHtml(l, byLine.get(i) ?? [])}</div>`
  ).join('');
  const lineBg = colors.removedLineBackground
    ? sanitizeCssColor(colors.removedLineBackground)
    : 'var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.1))';
  const wordBg = colors.removedWordBackground
    ? sanitizeCssColor(colors.removedWordBackground)
    : 'var(--vscode-diffEditor-removedTextBackground, rgba(255,0,0,0.35))';
  return `<!DOCTYPE html><html style="background:${lineBg}"><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  background: ${lineBg};
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: var(--vscode-editor-line-height, 1.5);
}
.line { white-space: pre; overflow: hidden; text-overflow: ellipsis; tab-size: ${tabSize}; }
.word-changed { background: ${wordBg}; }
</style>
</head><body>${rows}</body></html>`;
}

interface HunkInset {
  inset: vscode.WebviewEditorInset;
  disposable: vscode.Disposable;
  disposeListener: vscode.Disposable;
  // Cache key: used to detect whether this inset can be reused
  cacheKey: string;
  disposed: boolean;
}

function insetCacheKey(afterLine: number, height: number): string {
  return `${afterLine}:${height}`;
}

export class DecorationManager {
  // editorKey → ordered list of insets for that editor
  private insets: Map<string, HunkInset[]> = new Map();
  // Decoration types are recreated when color overrides change. We key reuse on
  // a signature so we only rebuild on real changes.
  private addedLineDecoration: vscode.TextEditorDecorationType | undefined;
  private addedWordDecoration: vscode.TextEditorDecorationType | undefined;
  private deletionMarkerDecoration: vscode.TextEditorDecorationType | undefined;
  private decorationColorSig: string = '';

  constructor(private stateManager: StateManager) {}

  private ensureDecorations(): void {
    const c = this.stateManager.colors;
    const sig = `${c.addedLineBackground}|${c.addedWordBackground}|${c.removedWordBackground}`;
    if (sig === this.decorationColorSig
      && this.addedLineDecoration
      && this.addedWordDecoration
      && this.deletionMarkerDecoration) return;
    this.addedLineDecoration?.dispose();
    this.addedWordDecoration?.dispose();
    this.deletionMarkerDecoration?.dispose();
    this.addedLineDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: c.addedLineBackground || new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      isWholeLine: true,
    });
    this.addedWordDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: c.addedWordBackground || new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    });
    // Inline marker showing where a word was deleted from the new line.
    // Colored with the inserted-text token so it visually matches the added
    // word backgrounds in the same line.
    const markerColor = c.addedWordBackground
      ? sanitizeCssColor(c.addedWordBackground)
      : 'var(--vscode-diffEditor-insertedTextBackground, rgba(137,221,255,0.5))';
    // 1/4-ch wide bar, right-aligned in the gap between the preceding char
    // and the anchor column. Implemented with an empty-content `before`
    // pseudo-element sized via `width` + `backgroundColor`; the negative
    // right margin cancels its footprint so surrounding text isn't pushed.
    // Implemented as a left-border on a zero-width range: renders as a thin
    // vertical line at the anchor column without displacing surrounding text,
    // and works correctly at column 0 (unlike a `before` pseudo-element with
    // negative left margin, which clips into the gutter at the line start).
    this.deletionMarkerDecoration = vscode.window.createTextEditorDecorationType({
      borderStyle: 'solid',
      borderWidth: '0 0 0 2px',
      borderColor: markerColor,
    });
    this.decorationColorSig = sig;
  }

  refresh(editors?: readonly vscode.TextEditor[]): void {
    const targets = editors ?? vscode.window.visibleTextEditors;
    const diffPaths = this.diffEditorFilePaths();
    for (const editor of targets) {
      this.applyToEditor(editor, diffPaths);
    }
  }

  refreshActionBar(_editor: vscode.TextEditor): void { /* buttons live in insets */ }

  private disposeInsetList(list: HunkInset[]): void {
    for (const h of list) {
      h.disposeListener.dispose();
      h.disposable.dispose();
      if (!h.disposed) h.inset.dispose();
    }
  }

  /**
   * Collect file paths that are open in any diff tab (git, hunkwise, etc.).
   */
  private diffEditorFilePaths(): Set<string> {
    const paths = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          paths.add(tab.input.modified.fsPath);
        }
      }
    }
    return paths;
  }

  private applyToEditor(editor: vscode.TextEditor, diffPaths: Set<string>): void {
    this.ensureDecorations();
    const filePath = editor.document.uri.fsPath;
    const editorKey = editor.document.uri.toString();
    const fileState = this.stateManager.getFile(filePath);

    // Skip insets: in diff editors (viewColumn undefined), or when user disabled inline decorations
    const isInDiff = editor.viewColumn === undefined && diffPaths.has(filePath);
    const skipInsets = isInDiff || !this.stateManager.showInlineDecorations;

    if (!fileState || fileState.status !== 'reviewing' || skipInsets) {
      this.disposeInsetList(this.insets.get(editorKey) ?? []);
      this.insets.delete(editorKey);
      editor.setDecorations(this.addedLineDecoration!, []);
      editor.setDecorations(this.addedWordDecoration!, []);
      editor.setDecorations(this.deletionMarkerDecoration!, []);
      return;
    }

    const addedRanges: vscode.Range[] = [];
    const addedWordRanges: vscode.Range[] = [];
    const deletionMarkerRanges: vscode.Range[] = [];
    const tabSize = editor.options.tabSize as number || 4;
    const parsed = computeHunks(fileState.baseline, editor.document.getText());

    // Build the desired inset specs first
    interface InsetSpec {
      afterLine: number;
      height: number;
      html: string;
    }
    const specs: InsetSpec[] = [];

    for (const hunk of parsed) {
      const id = hunkId(hunk);


      for (let i = 0; i < hunk.newLines; i++) {
        const lineIdx = hunk.newStart - 1 + i;
        if (lineIdx < editor.document.lineCount) {
          addedRanges.push(editor.document.lineAt(lineIdx).range);
        }
      }

      for (const wr of hunk.addedWordRanges) {
        const lineIdx = hunk.newStart - 1 + wr.lineOffset;
        if (lineIdx < editor.document.lineCount) {
          const lineLen = editor.document.lineAt(lineIdx).text.length;
          const start = Math.min(wr.start, lineLen);
          const end = Math.min(wr.end, lineLen);
          if (end > start) {
            addedWordRanges.push(new vscode.Range(lineIdx, start, lineIdx, end));
          }
        }
      }

      for (const m of hunk.deletionMarkers) {
        const lineIdx = hunk.newStart - 1 + m.lineOffset;
        if (lineIdx < editor.document.lineCount) {
          const lineLen = editor.document.lineAt(lineIdx).text.length;
          const col = Math.min(m.column, lineLen);
          deletionMarkerRanges.push(new vscode.Range(lineIdx, col, lineIdx, col));
        }
      }

      // ── Inset placement strategy ──
      //
      // Layout order (top → bottom):
      //   [deleted inset]   red lines showing removed content (afterLine = newStart - 2)
      //   [CodeLens row]    Accept / Discard (rendered by DiffCodeLensProvider, wrap-aware)
      //   [green lines]     added lines in the actual document
      //
      // The action bar is no longer an inset — it's a CodeLens, anchored at the
      // first green line of the hunk. CodeLens is wrap-aware, so it doesn't
      // exhibit the editor-insets "between visual rows" bug.
      //
      // ── afterLine semantics ──
      // createWebviewTextEditorInset takes a 0-based line number.
      // Internally VSCode does +1 before storing as afterLineNumber (1-based).
      // afterLineNumber=0 means "above line 1" (file top).
      // So to place an inset above line 1 we must pass afterLine = -1.

      const hasDeletion = hunk.removedContent.length > 0;
      if (hasDeletion) {
        specs.push({
          afterLine: Math.max(-1, hunk.newStart - 2),
          height: hunk.removedContent.length,
          html: buildDeletedHtml(hunk.removedContent, tabSize, hunk.removedWordRanges, this.stateManager.colors),
        });
      }
    }

    // Reuse existing insets when cache keys match to avoid flicker
    const existing = this.insets.get(editorKey) ?? [];
    const nextInsets: HunkInset[] = [];

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const key = insetCacheKey(spec.afterLine, spec.height);
      const prev = existing[i];
      if (prev && prev.cacheKey === key && !prev.disposed) {
        // Same position/height and still alive — reuse, just update html
        prev.inset.webview.html = spec.html;
        nextInsets.push(prev);
        existing[i] = undefined as any; // mark as consumed
      } else {
        // Position changed or inset was disposed by VSCode — recreate
        const created = this.makeInset(editorKey, editor, spec.afterLine, spec.height, spec.html, key);
        if (created) nextInsets.push(created);
      }
    }

    // Dispose leftover insets not reused
    for (const leftover of existing) {
      if (leftover) {
        leftover.disposeListener.dispose();
        leftover.disposable.dispose();
        if (!leftover.disposed) leftover.inset.dispose();
      }
    }

    editor.setDecorations(this.addedLineDecoration!, addedRanges);
    editor.setDecorations(this.addedWordDecoration!, addedWordRanges);
    editor.setDecorations(this.deletionMarkerDecoration!, deletionMarkerRanges);
    if (nextInsets.length > 0) {
      this.insets.set(editorKey, nextInsets);
    } else {
      this.insets.delete(editorKey);
    }
  }

  private makeInset(
    editorKey: string,
    editor: vscode.TextEditor,
    afterLine: number,
    height: number,
    html: string,
    cacheKey: string,
  ): HunkInset | undefined {
    try {
      const inset = (vscode.window as any).createWebviewTextEditorInset(
        editor, afterLine, height, { enableScripts: true }
      ) as vscode.WebviewEditorInset;
      inset.webview.html = html;
      // The deleted-content inset doesn't post messages; subscribe to a no-op
      // disposable so the existing HunkInset shape (with disposable) stays valid.
      const disposable = inset.webview.onDidReceiveMessage(() => { /* no-op */ });
      const entry: HunkInset = {
        inset, disposable, cacheKey, disposed: false,
        disposeListener: inset.onDidDispose(() => {
          entry.disposed = true;
          // Re-apply if editor is still visible so insets are immediately rebuilt
          const targetEditor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === editorKey
          );
          if (targetEditor) this.applyToEditor(targetEditor, this.diffEditorFilePaths());
        }),
      };
      return entry;
    } catch (err) {
      log(`createWebviewTextEditorInset failed: ${err}`);
      return undefined;
    }
  }

  dispose(): void {
    this.addedLineDecoration?.dispose();
    this.addedWordDecoration?.dispose();
    for (const list of this.insets.values()) {
      this.disposeInsetList(list);
    }
    this.insets.clear();
  }
}
