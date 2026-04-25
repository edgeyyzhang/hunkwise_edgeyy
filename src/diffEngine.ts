import * as Diff from 'diff';

// Sub-line range identifying changed words within a paired removed/added line.
// `lineOffset` is the 0-based index into removedContent/addedContent.
// `start`/`end` are character columns within that line (UTF-16 code units, half-open).
export interface WordRange {
  lineOffset: number;
  start: number;
  end: number;
}

// Position in the new (added) line where a word was deleted (no counterpart
// in the new line). Used to render a small inline marker so users can see
// "a word was removed here" even when nothing was added in its place.
export interface DeletionMarker {
  lineOffset: number; // index into addedContent
  column: number;     // character column in the new line where deletion occurred
}

export interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  removedContent: string[];  // lines from baseline that were removed
  addedContent: string[];    // lines in current content that were added
  removedWordRanges: WordRange[]; // sub-line spans inside removedContent
  addedWordRanges: WordRange[];   // sub-line spans inside addedContent
  deletionMarkers: DeletionMarker[]; // markers for deleted words inside paired added lines
}

// Stable id derived from hunk position — same hunk always gets the same id
// within a single review session (no random component needed).
export function hunkId(hunk: ParsedHunk): string {
  return `${hunk.newStart}:${hunk.newLines}:${hunk.oldStart}:${hunk.oldLines}`;
}

export function computeHunks(baseline: string | null, current: string): ParsedHunk[] {
  const changes = Diff.diffLines(baseline ?? '', current);

  const hunks: ParsedHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;

  while (i < changes.length) {
    const change = changes[i];

    if (!change.added && !change.removed) {
      // Context lines — advance line counters using count field
      const lineCount = change.count ?? 0;
      oldLine += lineCount;
      newLine += lineCount;
      i++;
      continue;
    }

    // Start of a changed region — collect consecutive added/removed blocks
    const hunkOldStart = oldLine;
    const hunkNewStart = newLine;
    const removed: string[] = [];
    const added: string[] = [];

    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      const c = changes[i];
      // Split into lines; the value ends with \n for most lines
      const lines = c.value.endsWith('\n')
        ? c.value.slice(0, -1).split('\n')
        : c.value.split('\n');

      if (c.removed) {
        removed.push(...lines);
        oldLine += lines.length;
      } else if (c.added) {
        added.push(...lines);
        newLine += lines.length;
      }
      i++;
    }

    if (removed.length > 0 || added.length > 0) {
      const { removedWordRanges, addedWordRanges, deletionMarkers } = computeWordRanges(removed, added);
      hunks.push({
        oldStart: hunkOldStart,
        oldLines: removed.length,
        newStart: hunkNewStart,
        newLines: added.length,
        removedContent: removed,
        addedContent: added,
        removedWordRanges,
        addedWordRanges,
        deletionMarkers,
      });
    }
  }

  return hunks;
}

// Pair removed/added lines by index (the simplest stable pairing) and compute
// word-level ranges via diffWordsWithSpace. Lines beyond min(removed, added)
// are pure additions or deletions and get no sub-line ranges.
function computeWordRanges(
  removed: string[],
  added: string[],
): { removedWordRanges: WordRange[]; addedWordRanges: WordRange[]; deletionMarkers: DeletionMarker[] } {
  const removedWordRanges: WordRange[] = [];
  const addedWordRanges: WordRange[] = [];
  const deletionMarkers: DeletionMarker[] = [];
  const pairs = Math.min(removed.length, added.length);
  for (let i = 0; i < pairs; i++) {
    const parts = Diff.diffWordsWithSpace(removed[i], added[i]);
    let oldCol = 0;
    let newCol = 0;
    let lastMarkerCol = -1;
    for (const part of parts) {
      const len = part.value.length;
      if (part.removed) {
        if (len > 0) {
          removedWordRanges.push({ lineOffset: i, start: oldCol, end: oldCol + len });
          // Record deletion marker at current new-line column. Coalesce
          // consecutive deletions at the same column so we don't draw
          // multiple stacked markers when several adjacent words were removed.
          if (newCol !== lastMarkerCol) {
            deletionMarkers.push({ lineOffset: i, column: newCol });
            lastMarkerCol = newCol;
          }
        }
        oldCol += len;
      } else if (part.added) {
        if (len > 0) addedWordRanges.push({ lineOffset: i, start: newCol, end: newCol + len });
        newCol += len;
      } else {
        oldCol += len;
        newCol += len;
      }
    }
  }
  return { removedWordRanges, addedWordRanges, deletionMarkers };
}

