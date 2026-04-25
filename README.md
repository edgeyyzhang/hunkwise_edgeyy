# hunkwise

<!-- markdownlint-disable MD033 -->
<p align="center">
  <img src="media/icon.png" width="128" alt="hunkwise logo">
</p>

<p align="center"><em>Your future self will thank you. Or blame you. It depends on the diff.</em></p>
<!-- markdownlint-enable MD033 -->

> **This is my personal adaptation of [molon/hunkwise](https://github.com/molon/hunkwise).** 

AI coding tools like [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenCode](https://github.com/anomalyco/opencode), and other CLI/plugin-based assistants lack a native IDE — unlike Cursor, Windsurf, or Copilot, they have no built-in way to review changes hunk by hunk.

**hunkwise** fills that gap by bringing per-hunk review controls directly into VSCode for any external file change.

![snapshot](media/snapshot.png)

## Features

- Tracks file changes from any source (AI tools, scripts, manual edits)
- Per-hunk `✓ Accept | ↺ Discard` controls inline in the editor
- Added lines highlighted in green, removed lines highlighted in red
- Sidebar panel lists all pending files with hunk details and batch actions
- New files and deleted files are tracked and displayed
- State persisted across VSCode restarts via a lightweight internal git repo
- Respects `.gitignore` and custom ignore patterns

## What's different from upstream

The items below are what this fork adds or changes compared to [molon/hunkwise](https://github.com/molon/hunkwise).

### Change Accept / Discard to codeLens buttons between the old/new lines

The `Accept / Discard` chip can land between wrapped rows of a single logical line. 

The button labels use a bolder sans-serif style with heavy check and cross glyphs for better visibility:

```
✔ 𝗔𝗰𝗰𝗲𝗽𝘁    ✘ 𝗗𝗶𝘀𝗰𝗮𝗿𝗱
```

### Inline deletion marker in modified lines

When a word is removed from a line without a matching replacement at the same position, upstream only indicates this in the red "deleted" inset above the line. You can see *what* was removed but not *where* in the modified line the removal occurred.

This fork adds a thin vertical marker directly in the modified line at the exact column of each deletion, so the location of the removal is visible inline. The marker's color matches the added-text highlight color in the same row, so it sits within the line's existing visual palette. Consecutive deletions at the same spot are collapsed into a single marker.

### Accept All / Discard All keyboard shortcuts

Upstream only exposes Accept All / Discard All through the sidebar panel. This fork adds first-class commands with keybindings so you can run them from anywhere in VS Code without opening the panel.

| Command | Mac | Win / Linux | Notes |
| ------- | --- | ----------- | ----- |
| `hunkwise: Accept All` | `Cmd+K Cmd+A` | `Ctrl+K Ctrl+A` | No confirmation — accepting is non-destructive |
| `hunkwise: Discard All` | `Cmd+K Cmd+D` | `Ctrl+K Ctrl+D` | Modal confirmation with file count before proceeding |

Chord bindings (`Cmd+K` prefix) were chosen to reduce the chance of an accidental Discard All. Both commands also appear in the Command Palette.

### Single-undo Discard All

In upstream, running Discard All applies the revert file-by-file — each `Cmd+Z` / `Ctrl+Z` only undoes the most recent file. This fork bundles the whole operation so that **one undo restores every modified and new file at once**.

Note: files that were externally deleted and get restored by Discard All are outside the VS Code undo system; those aren't covered by the single-undo behavior.

### Accept / Discard hunk at cursor

Two additional commands let you act on the hunk containing (or nearest to) the cursor without using the mouse:

| Command | What it does |
| ------- | ------------ |
| `hunkwise: Accept Hunk at Cursor` | Accepts the hunk under the cursor |
| `hunkwise: Discard Hunk at Cursor` | Discards the hunk under the cursor |

Useful for assigning your own keybindings to accept/discard individual hunks from the keyboard.

### Customizable diff colors

The extension's settings panel (gear icon → Settings) exposes color overrides for the added-line background, added-word highlight, removed-line background, and removed-word highlight. Empty values fall back to VS Code's `diffEditor.*` theme tokens, so by default everything follows your theme.

## Installation

hunkwise uses a [proposed VSCode API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api) (`editorInsets`) and cannot be installed from the marketplace.

Just tell your AI tool:

> Run this skill: <https://github.com/molon/hunkwise/blob/main/skills/install-hunkwise/SKILL.md>

## Usage

### Enable hunkwise

Click **Enable** in the hunkwise sidebar panel. hunkwise will snapshot all current workspace files as baselines.

### Automatic tracking

Once enabled, any external tool (AI assistant, script, etc.) that writes to a file will automatically trigger review mode for that file.

### Reviewing changes

- Click `✓` or `↺` above each hunk in the editor
- Use the **hunkwise** sidebar panel to:
  - See all files with pending changes
  - Accept or discard individual hunks
  - Accept or discard all changes in a file
  - Accept or discard all changes across all files
- Click a file name in the panel to open it
- Deleted files show a diff view with the original content

### Disable hunkwise

Open **Settings** (gear icon in the panel title bar) and click **Disable** at the bottom. All tracked state is cleared.

### Tip: Stack with Chat panel

You can drag both the hunkwise panel and the Claude Code panel into the Chat panel to stack them as tabs in the same panel group — keeping Claude Code chat and hunk review at a glance.

## Commands

| Command | Description |
| ------- | ----------- |
| `hunkwise: Enable` | Enable hunkwise and snapshot the workspace |
| `hunkwise: Disable` | Disable hunkwise and clear all state |
| `hunkwise: Settings` | Open the settings panel |
| `hunkwise: Accept Hunk at Cursor` | Accept the hunk containing (or nearest to) the cursor |
| `hunkwise: Discard Hunk at Cursor` | Discard the hunk containing (or nearest to) the cursor |
| `hunkwise: Accept All` | Accept every pending hunk across all files (no confirmation) — `Cmd+K Cmd+A` / `Ctrl+K Ctrl+A` |
| `hunkwise: Discard All` | Discard every pending hunk across all files (confirmation modal) — `Cmd+K Cmd+D` / `Ctrl+K Ctrl+D` |

## Settings

Settings are stored in `.vscode/hunkwise/settings.json` and can be changed via the settings panel:

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `ignorePatterns` | `[".git"]` | Glob patterns to exclude from tracking |
| `respectGitignore` | `true` | Whether to honor `.gitignore` rules |
| `clearOnBranchSwitch` | `false` | Automatically clear all pending hunks when git branch changes |

## .gitignore

When enabled, hunkwise automatically adds `.vscode/hunkwise/` to your `.gitignore`.

## How it works

### Baseline tracking

When hunkwise is enabled, it snapshots all workspace files into a private git repository at `.vscode/hunkwise/git/`. This repo stores **baselines** — the content of each file at the moment hunkwise starts tracking. The repo always has exactly one commit (each mutation does `--amend`).

When an external tool modifies a file, hunkwise diffs the current content against the stored baseline to produce hunks. Accepting a hunk updates the baseline; discarding a hunk restores the baseline content.

### External vs manual change detection

hunkwise distinguishes between:

- **External changes** (AI tools, scripts): Detected when the file content on disk differs from the open editor buffer. These trigger review mode with inline hunks.
- **Manual edits** (user typing in VSCode): The editor buffer matches the disk content after save. These silently update the baseline — no hunks shown.

This means you can freely edit files while hunkwise is enabled, and only tool-generated changes will produce hunks.

### File rename and delete handling

- **Manual rename** (via VSCode explorer/API): hunkwise migrates the baseline to the new path. No spurious deletion hunk is shown.
- **Manual delete** (via VSCode explorer/API): hunkwise removes the baseline. No deletion hunk is shown.
- **External delete** (tool deletes a file): Shows a deletion hunk so you can review and restore if needed.

### Ignore rules

Files can be excluded from tracking via two mechanisms:

1. **ignorePatterns** in `.vscode/hunkwise/settings.json` — custom patterns (default: `[".git"]`, plus `".DS_Store"` on macOS)
2. **`.gitignore`** — when `respectGitignore` is true (default), workspace `.gitignore` rules are honored

When ignore rules change (`.gitignore` modified, or patterns updated via settings), hunkwise automatically:

- Removes baselines for files that are now ignored
- Adds baselines for files that are newly allowed

### State persistence

All baseline data is stored in the git repo and survives VSCode restarts. On reactivation, hunkwise reads baselines from `git ls-tree HEAD` + `git show :path` to restore in-memory state.

## Development

```bash
npm run compile          # compile TypeScript
npm run watch            # watch mode
npm test                 # run unit tests (node:test runner)
npm run test:integration # run VSCode integration tests
```

Unit tests cover `diffEngine`, `hunkwiseGit`, and `gitignoreManager`. They run with Node's built-in test runner and require no additional dependencies.

Integration tests run in a real VSCode extension host via `@vscode/test-cli` and cover rename/delete handling, .gitignore sync, file watching, and enable/disable lifecycle.
