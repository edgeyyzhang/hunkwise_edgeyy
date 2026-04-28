import * as vscode from 'vscode';
import { computeHunks } from './diffEngine';

export const isNotebookFile = (fp: string): boolean => fp.toLowerCase().endsWith('.ipynb');

export interface CellRef {
  notebookPath: string;
  cellKey: string;
}

export function cellKeyOf(cell: vscode.NotebookCell, indexInNotebook: number): string {
  const id = (cell.metadata as { id?: string } | undefined)?.id;
  return id ?? `__idx_${indexInNotebook}`;
}

export function findCellRef(doc: vscode.TextDocument): CellRef | undefined {
  if (doc.uri.scheme !== 'vscode-notebook-cell') return undefined;
  for (const nb of vscode.workspace.notebookDocuments) {
    const cells = nb.getCells();
    const idx = cells.findIndex(c => c.document === doc);
    if (idx !== -1) {
      return { notebookPath: nb.uri.fsPath, cellKey: cellKeyOf(cells[idx], idx) };
    }
  }
  return undefined;
}

function locateBaselineCell(parsed: { cells?: Array<{ id?: string; source?: unknown }> }, cellKey: string): number {
  const cells = parsed.cells ?? [];
  if (cellKey.startsWith('__idx_')) {
    const i = parseInt(cellKey.slice(6), 10);
    return Number.isFinite(i) && i >= 0 && i < cells.length ? i : -1;
  }
  return cells.findIndex(c => c.id === cellKey);
}

function joinSource(src: unknown): string {
  if (Array.isArray(src)) return src.join('');
  if (typeof src === 'string') return src;
  return '';
}

export function getBaselineCellSource(baselineJson: string | null, cellKey: string): string | null {
  if (baselineJson === null) return null;
  let parsed: { cells?: Array<{ id?: string; source?: unknown }> };
  try { parsed = JSON.parse(baselineJson); } catch { return null; }
  const idx = locateBaselineCell(parsed, cellKey);
  if (idx < 0) return null;
  return joinSource(parsed.cells![idx].source);
}

// Jupyter convention: source is an array of strings, each ending in \n except the last.
function splitSourceForNbformat(text: string): string[] {
  if (text === '') return [];
  const parts = text.split(/(?<=\n)/);
  return parts;
}

export function setBaselineCellSource(baselineJson: string, cellKey: string, newSource: string): string {
  let parsed: { cells?: Array<{ id?: string; source?: unknown }> };
  try { parsed = JSON.parse(baselineJson); } catch { return baselineJson; }
  const idx = locateBaselineCell(parsed, cellKey);
  if (idx < 0) return baselineJson;
  parsed.cells![idx].source = splitSourceForNbformat(newSource);
  return JSON.stringify(parsed, null, 1);
}

export function notebookHasAnyHunks(nb: vscode.NotebookDocument, baselineJson: string | null): boolean {
  const cells = nb.getCells();
  for (let i = 0; i < cells.length; i++) {
    const key = cellKeyOf(cells[i], i);
    const baselineSource = getBaselineCellSource(baselineJson, key);
    if (computeHunks(baselineSource, cells[i].document.getText()).length > 0) return true;
  }
  return false;
}
