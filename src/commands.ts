import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { ReviewPanel } from './reviewPanel';
import { computeHunks, hunkId, ParsedHunk } from './diffEngine';
import { upsertGitignore } from './gitignoreManager';
import { log } from './log';

export function registerCommands(
  context: vscode.ExtensionContext,
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  reviewPanel: ReviewPanel,
  onStateChanged: () => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('hunkwise.enable', () =>
      enableHunkwise(stateManager, fileWatcher, reviewPanel, onStateChanged)
    ),
    vscode.commands.registerCommand('hunkwise.disable', () =>
      disableHunkwise(stateManager, onStateChanged)
    ),
    vscode.commands.registerCommand('hunkwise.setIgnorePatterns', async (patterns: string[]) => {
      stateManager.setIgnorePatterns(patterns);
      onStateChanged();
      await stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
      onStateChanged();
    }),
    vscode.commands.registerCommand('hunkwise.setRespectGitignore', async (value: boolean) => {
      stateManager.setRespectGitignore(value);
      onStateChanged();
      await stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
      onStateChanged();
    }),
    vscode.commands.registerCommand('hunkwise.setClearOnBranchSwitch', (value: boolean) => {
      stateManager.setClearOnBranchSwitch(value);
    }),
    vscode.commands.registerCommand('hunkwise.clearHunks', async () => {
      await stateManager.clearHunksOnBranchSwitch(
        (fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)
      );
      onStateChanged();
    }),
    vscode.commands.registerCommand('hunkwise.acceptHunkAtCursor', () => {
      const target = resolveHunkAtCursor(stateManager);
      if (!target) return;
      acceptHunk(stateManager, target.filePath, hunkId(target.hunk), onStateChanged, 'cursor-shortcut');
    }),
    vscode.commands.registerCommand('hunkwise.discardHunkAtCursor', async () => {
      const target = resolveHunkAtCursor(stateManager);
      if (!target) return;
      await discardHunk(stateManager, fileWatcher, target.filePath, hunkId(target.hunk), onStateChanged, 'cursor-shortcut');
    }),
    vscode.commands.registerCommand('hunkwise.acceptAll', async () => {
      const fileCount = stateManager.getAllFiles().size;
      if (fileCount === 0) {
        vscode.window.showInformationMessage('hunkwise: no pending changes.');
        return;
      }
      await acceptAllFiles(stateManager, onStateChanged);
    }),
    vscode.commands.registerCommand('hunkwise.discardAll', async () => {
      const fileCount = stateManager.getAllFiles().size;
      if (fileCount === 0) {
        vscode.window.showInformationMessage('hunkwise: no pending changes.');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Discard all changes in ${fileCount} file${fileCount === 1 ? '' : 's'}? This cannot be undone.`,
        { modal: true },
        'Discard All'
      );
      if (choice !== 'Discard All') return;
      await discardAllFiles(stateManager, fileWatcher, onStateChanged);
    }),
    vscode.commands.registerCommand('hunkwise.openDiffForCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        vscode.window.showInformationMessage('hunkwise: no active file to diff.');
        return;
      }
      const filePath = editor.document.uri.fsPath;
      if (!stateManager.getFile(filePath)) {
        vscode.window.showInformationMessage('hunkwise: this file has no pending changes.');
        return;
      }
      await reviewPanel.openDiffEditor(filePath);
    }),
  );
}

async function enableHunkwise(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  reviewPanel: ReviewPanel,
  onStateChanged: () => void
): Promise<void> {
  log('enable');
  reviewPanel.setLoading(true);
  try {
    await Promise.all([
      new Promise(resolve => setTimeout(resolve, 750)),
      (async () => {
        await stateManager.setEnabled(true);
        try { upsertGitignore(); } catch (err) { log(`upsertGitignore failed: ${err}`); }
        await stateManager.snapshotWorkspace((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
      })(),
    ]);
  } finally {
    reviewPanel.setLoading(false);
  }
  onStateChanged();
}

async function disableHunkwise(
  stateManager: StateManager,
  onStateChanged: () => void
): Promise<void> {
  log('disable');
  stateManager.setEnabled(false);
  onStateChanged();
}

export async function acceptAllFiles(
  stateManager: StateManager,
  onStateChanged: () => void
): Promise<void> {
  for (const filePath of Array.from(stateManager.getAllFiles().keys())) {
    acceptFileByPath(stateManager, filePath, () => {});
  }
  onStateChanged();
}

export async function discardAllFiles(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  onStateChanged: () => void
): Promise<void> {
  const allFiles = Array.from(stateManager.getAllFiles().entries());
  if (allFiles.length === 0) return;

  for (const [filePath] of allFiles) {
    fileWatcher.markSelfEdit(filePath);
  }

  try {
    const edit = new vscode.WorkspaceEdit();
    const docsToSave: vscode.TextDocument[] = [];
    const externalRestores: { filePath: string; baseline: string }[] = [];
    const filesToRemove: string[] = [];
    const filesToExitReviewing: string[] = [];

    for (const [filePath, fileState] of allFiles) {
      const uri = vscode.Uri.file(filePath);

      if (fileState.baseline === null) {
        // New file (didn't exist in baseline) — delete via WorkspaceEdit.
        if (fs.existsSync(filePath)) {
          edit.deleteFile(uri, { ignoreIfNotExists: true });
        }
        filesToRemove.push(filePath);
        continue;
      }

      if (!fs.existsSync(filePath)) {
        // Externally deleted file — restore via fs (doc is closed; can't go through WorkspaceEdit cleanly).
        externalRestores.push({ filePath, baseline: fileState.baseline });
        filesToExitReviewing.push(filePath);
        continue;
      }

      // Normal case: replace contents with baseline. Bundled into the single WorkspaceEdit
      // so all per-file replacements collapse into one undo entry.
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
      );
      edit.replace(uri, fullRange, fileState.baseline);
      docsToSave.push(doc);
      filesToExitReviewing.push(filePath);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    log(`discardAllFiles: applyEdit=${applied}`);
    if (!applied) {
      log('discardAllFiles: applyEdit failed');
      return;
    }

    for (const doc of docsToSave) {
      try { await doc.save(); } catch (err) { log(`discardAllFiles: save failed for ${doc.uri.fsPath}: ${err}`); }
    }

    for (const { filePath, baseline } of externalRestores) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, baseline, 'utf-8');
      } catch (err) {
        log(`discardAllFiles: restore failed for ${filePath}: ${err}`);
      }
    }

    for (const filePath of filesToRemove) stateManager.removeFile(filePath);
    for (const filePath of filesToExitReviewing) stateManager.exitReviewing(filePath);
  } finally {
    for (const [filePath] of allFiles) {
      fileWatcher.clearSelfEdit(filePath);
    }
  }

  onStateChanged();
}

export function acceptFileByPath(
  stateManager: StateManager,
  filePath: string,
  onStateChanged: () => void
): void {
  if (!stateManager.getFile(filePath)) return;
  const basename = path.basename(filePath);
  if (!fs.existsSync(filePath)) {
    // File was deleted — remove from tracking entirely
    log(`acceptFileByPath(${basename}): file not on disk, removeFile`);
    stateManager.removeFile(filePath);
  } else {
    // File exists (possibly empty) — accept current content as new baseline
    const content = fs.readFileSync(filePath, 'utf-8');
    log(`acceptFileByPath(${basename}): file exists, exitReviewing with content.len=${content.length}`);
    stateManager.exitReviewing(filePath, content);
  }
  onStateChanged();
}

export async function discardFileByPath(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  filePath: string,
  onStateChanged: () => void
): Promise<void> {
  const fileState = stateManager.getFile(filePath);
  if (!fileState) return;

  fileWatcher.markSelfEdit(filePath);
  try {
    if (fileState.baseline === null) {
      // New file (didn't exist before) — delete it
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } else if (fileState.baseline === '' && fs.existsSync(filePath)) {
      // Existed as empty file — restore to empty
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
      );
      edit.replace(uri, fullRange, '');
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    } else if (!fs.existsSync(filePath)) {
      // File was deleted — restore from baseline
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, fileState.baseline ?? '', 'utf-8');
      await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    } else {
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
      );
      edit.replace(uri, fullRange, fileState.baseline ?? '');
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    }
  } finally {
    fileWatcher.clearSelfEdit(filePath);
  }
  if (fileState.baseline === null) {
    // Discarding a new file means it was deleted — remove from tracking
    stateManager.removeFile(filePath);
  } else {
    stateManager.exitReviewing(filePath);
  }
  onStateChanged();
}


export function acceptHunk(
  stateManager: StateManager,
  filePath: string,
  id: string,
  onStateChanged: () => void,
  source: string = 'unknown'
): void {
  const basename = path.basename(filePath);
  log(`acceptHunk(${basename}): hunkId=${id}, source=${source}`);

  const fileState = stateManager.getFile(filePath);
  if (!fileState) { log(`acceptHunk(${basename}): no fileState, skip`); return; }

  const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === filePath);
  if (!doc) { log(`acceptHunk(${basename}): no doc found, skip`); return; }
  const baselineStr = fileState.baseline ?? '';
  log(`acceptHunk(${basename}): doc.scheme=${doc.uri.scheme}, doc.len=${doc.getText().length}, baseline.len=${baselineStr.length}`);

  const hunks = computeHunks(fileState.baseline, doc.getText());
  log(`acceptHunk(${basename}): total hunks=${hunks.length}`);
  const hunk = hunks.find(h => hunkId(h) === id);
  if (!hunk) { log(`acceptHunk(${basename}): hunk not found, skip`); return; }

  const originalNewStart = hunk.newStart;

  const currentLines = doc.getText().split('\n');
  const baselineLines = baselineStr.split('\n');
  const newBaseline = [
    ...baselineLines.slice(0, hunk.oldStart - 1),
    ...currentLines.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newLines),
    ...baselineLines.slice(hunk.oldStart - 1 + hunk.oldLines),
  ].join('\n');

  const remainingHunks = computeHunks(newBaseline, doc.getText());
  log(`acceptHunk(${basename}): remainingHunks=${remainingHunks.length}`);
  if (remainingHunks.length === 0) {
    log(`acceptHunk(${basename}): last hunk, exitReviewing`);
    stateManager.exitReviewing(filePath, doc.getText());
  } else {
    stateManager.setFile(filePath, { status: 'reviewing', baseline: newBaseline });
    revealNextHunk(filePath, remainingHunks, originalNewStart);
  }
  onStateChanged();
  log(`acceptHunk(${basename}): done`);
}

// Locate the hunk most relevant to the active editor's cursor. Picks a hunk
// whose green block (added lines) contains the cursor line; otherwise the
// nearest hunk by line distance. Returns undefined and surfaces a friendly
// message if there's no active file, no fileState, or no hunks.
function resolveHunkAtCursor(
  stateManager: StateManager,
): { filePath: string; hunk: ParsedHunk } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    vscode.window.showInformationMessage('hunkwise: no active file.');
    return undefined;
  }
  const filePath = editor.document.uri.fsPath;
  const fileState = stateManager.getFile(filePath);
  if (!fileState) {
    vscode.window.showInformationMessage('hunkwise: this file has no pending changes.');
    return undefined;
  }
  const hunks = computeHunks(fileState.baseline, editor.document.getText());
  if (hunks.length === 0) {
    vscode.window.showInformationMessage('hunkwise: no hunks in this file.');
    return undefined;
  }
  const cursorLine = editor.selection.active.line; // 0-based
  for (const h of hunks) {
    const start0 = h.newStart - 1;
    const end0 = h.newLines > 0 ? start0 + h.newLines - 1 : start0;
    if (cursorLine >= start0 && cursorLine <= end0) return { filePath, hunk: h };
  }
  let best: ParsedHunk | undefined;
  let bestDist = Infinity;
  for (const h of hunks) {
    const start0 = h.newStart - 1;
    const end0 = h.newLines > 0 ? start0 + h.newLines - 1 : start0;
    const dist = cursorLine < start0 ? start0 - cursorLine : cursorLine - end0;
    if (dist < bestDist) { bestDist = dist; best = h; }
  }
  return best ? { filePath, hunk: best } : undefined;
}

/** Reveal the next hunk in the editor after an accept/discard operation. */
function revealNextHunk(filePath: string, remainingHunks: ReturnType<typeof computeHunks>, originalNewStart: number): void {
  const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === filePath);
  if (!editor) return;

  // Find the first remaining hunk at or after the original position
  const next = remainingHunks.find(h => h.newStart >= originalNewStart) ?? remainingHunks[0];
  if (!next) return;

  const pos = new vscode.Position(Math.max(0, next.newStart - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

export async function discardHunk(
  stateManager: StateManager,
  fileWatcher: FileWatcher,
  filePath: string,
  id: string,
  onStateChanged: () => void,
  source: string = 'unknown'
): Promise<void> {
  const basename = path.basename(filePath);
  log(`discardHunk(${basename}): hunkId=${id}, source=${source}`);

  const fileState = stateManager.getFile(filePath);
  if (!fileState) { log(`discardHunk(${basename}): no fileState, skip`); return; }

  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);

  const allHunks = computeHunks(fileState.baseline, doc.getText());
  log(`discardHunk(${basename}): total hunks=${allHunks.length}`);
  const hunk = allHunks.find(h => hunkId(h) === id);
  if (!hunk) { log(`discardHunk(${basename}): hunk not found, skip`); return; }

  const originalNewStart = hunk.newStart;

  const baselineStr = fileState.baseline ?? '';
  const baselineLines = baselineStr.split('\n');
  const originalLines = baselineLines.slice(hunk.oldStart - 1, hunk.oldStart - 1 + hunk.oldLines);

  const startPos = new vscode.Position(hunk.newStart - 1, 0);
  let endPos: vscode.Position;
  if (hunk.newLines === 0) {
    endPos = startPos;
  } else {
    const lastNewLine = hunk.newStart - 1 + hunk.newLines - 1;
    endPos = lastNewLine < doc.lineCount - 1
      ? new vscode.Position(lastNewLine + 1, 0)
      : new vscode.Position(lastNewLine, doc.lineAt(lastNewLine).text.length);
  }

  const replacement = originalLines.length > 0 ? originalLines.join('\n') + '\n' : '';
  log(`discardHunk(${basename}): replacing lines ${startPos.line}-${endPos.line} with ${originalLines.length} original lines`);

  fileWatcher.markSelfEdit(filePath);
  try {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(startPos, endPos), replacement);
    const applied = await vscode.workspace.applyEdit(edit);
    log(`discardHunk(${basename}): applyEdit=${applied}`);
    if (!applied) {
      log(`discardHunk(${basename}): applyEdit failed, aborting`);
      return;
    }
    const saved = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === filePath);
    if (saved) await saved.save();
    log(`discardHunk(${basename}): saved, doc.scheme=${saved?.uri.scheme ?? 'N/A'}, doc.len=${saved?.getText().length ?? 'N/A'}`);
    const currentText = saved?.getText() ?? doc.getText();
    const remainingHunks = computeHunks(fileState.baseline, currentText);
    log(`discardHunk(${basename}): remainingHunks=${remainingHunks.length}`);
    if (remainingHunks.length === 0) {
      if (fileState.baseline === null && fs.existsSync(filePath)) {
        // New file (didn't exist before) fully discarded — remove from disk
        log(`discardHunk(${basename}): new file fully discarded, deleting`);
        try { fs.unlinkSync(filePath); } catch (err) { log(`discardHunk(${basename}): unlink failed: ${err}`); }
      }
      log(`discardHunk(${basename}): no hunks left, exitReviewing`);
      stateManager.exitReviewing(filePath);
    } else {
      revealNextHunk(filePath, remainingHunks, originalNewStart);
    }
    onStateChanged();
    log(`discardHunk(${basename}): done`);
  } finally {
    fileWatcher.clearSelfEdit(filePath);
  }
}

