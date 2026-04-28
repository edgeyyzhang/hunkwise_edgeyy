import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { computeHunks } from './diffEngine';
import { findCellRef, getBaselineCellSource, isNotebookFile } from './notebookCells';

export class CellRemovedHoverProvider implements vscode.HoverProvider {
  constructor(private stateManager: StateManager) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (document.uri.scheme !== 'vscode-notebook-cell') return undefined;
    if (!this.stateManager.enabled) return undefined;

    const ref = findCellRef(document);
    if (!ref || !isNotebookFile(ref.notebookPath)) return undefined;

    const fileState = this.stateManager.getFile(ref.notebookPath);
    if (!fileState || fileState.status !== 'reviewing') return undefined;

    const baselineSource = getBaselineCellSource(fileState.baseline, ref.cellKey);
    const hunks = computeHunks(baselineSource, document.getText());

    const line = position.line;
    for (const h of hunks) {
      if (h.removedContent.length === 0) continue;
      const start0 = h.newStart - 1;
      const end0 = h.newLines > 0 ? start0 + h.newLines - 1 : start0;
      if (line < start0 || line > end0) continue;
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**hunkwise — removed (${h.removedContent.length} line${h.removedContent.length === 1 ? '' : 's'}):**\n\n`);
      md.appendCodeblock(h.removedContent.join('\n'), document.languageId);
      return new vscode.Hover(md, new vscode.Range(start0, 0, end0, 0));
    }
    return undefined;
  }
}
