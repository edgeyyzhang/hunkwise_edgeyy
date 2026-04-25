import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { computeHunks, hunkId } from './diffEngine';

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
    if (document.uri.scheme !== 'file') return [];
    if (!this.stateManager.enabled) return [];

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
}
