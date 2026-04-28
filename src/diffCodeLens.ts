import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { computeHunks, hunkId } from './diffEngine';
import { findCellRef, getBaselineCellSource, isNotebookFile } from './notebookCells';

export class DiffCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private stateManager: StateManager) {}

  fire(): void {
    this._onDidChangeCodeLenses.fire();
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.stateManager.enabled) return [];

    if (document.uri.scheme === 'vscode-notebook-cell') {
      return this.provideCellLenses(document);
    }
    if (document.uri.scheme !== 'file') return [];
    // Notebook file is rendered as a notebook; per-hunk lenses live on cell documents.
    if (isNotebookFile(document.uri.fsPath)) return [];

    const fileState = this.stateManager.getFile(document.uri.fsPath);
    if (!fileState || fileState.status !== 'reviewing') return [];

    const hunks = computeHunks(fileState.baseline, document.getText());
    const lenses: vscode.CodeLens[] = [];

    for (const hunk of hunks) {
      // CodeLens renders above its anchor line. Anchor at the first green line
      // (newStart - 1, 0-based) so the lens row appears just above the green
      // block — directly below any deleted-content inset. This places the lens
      // adjacent to the change and avoids "phantom gap" issues when the line
      // immediately above the hunk happens to be empty.
      const line = Math.max(0, Math.min(hunk.newStart - 1, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const id = hunkId(hunk);

      lenses.push(
        new vscode.CodeLens(range, {
          title: '✔ 𝗔𝗰𝗰𝗲𝗽𝘁',
          command: 'hunkwise.codeLensAcceptHunk',
          arguments: [document.uri.fsPath, id],
        }),
        new vscode.CodeLens(range, {
          title: '✘ 𝗗𝗶𝘀𝗰𝗮𝗿𝗱',
          command: 'hunkwise.codeLensDiscardHunk',
          arguments: [document.uri.fsPath, id],
        }),
      );
    }

    return lenses;
  }

  private provideCellLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const ref = findCellRef(document);
    if (!ref) return [];
    if (!isNotebookFile(ref.notebookPath)) return [];

    const fileState = this.stateManager.getFile(ref.notebookPath);
    if (!fileState || fileState.status !== 'reviewing') return [];

    const baselineSource = getBaselineCellSource(fileState.baseline, ref.cellKey);
    const hunks = computeHunks(baselineSource, document.getText());
    const lenses: vscode.CodeLens[] = [];

    for (const hunk of hunks) {
      const line = Math.max(0, Math.min(hunk.newStart - 1, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const id = hunkId(hunk);

      lenses.push(
        new vscode.CodeLens(range, {
          title: '✔ 𝗔𝗰𝗰𝗲𝗽𝘁',
          command: 'hunkwise.codeLensAcceptCellHunk',
          arguments: [ref.notebookPath, ref.cellKey, id],
        }),
        new vscode.CodeLens(range, {
          title: '✘ 𝗗𝗶𝘀𝗰𝗮𝗿𝗱',
          command: 'hunkwise.codeLensDiscardCellHunk',
          arguments: [ref.notebookPath, ref.cellKey, id],
        }),
      );

      // Truncated removed-content preview rendered after Accept/Discard.
      // Click triggers the editor hover at this line, populated by CellRemovedHoverProvider.
      if (hunk.removedContent.length > 0) {
        const first = hunk.removedContent[0].replace(/\t/g, '  ').trimEnd();
        const truncated = first.length > 80 ? first.slice(0, 80) + '…' : first;
        const more = hunk.removedContent.length - 1;
        const suffix = more > 0 ? `  (+${more} more line${more === 1 ? '' : 's'} — click to see)` : '';
        lenses.push(new vscode.CodeLens(range, {
          title: `— ${truncated}${suffix}`,
          command: 'hunkwise.showRemovedContent',
          arguments: [line],
        }));
      }
    }

    return lenses;
  }
}
