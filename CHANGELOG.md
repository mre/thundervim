# Changelog

## v0.3.10

### Fixed

- **The status line no longer appears in Markdown Here Revival previews.** Its
  labels are rendered without DOM text, so whole-document HTML consumers cannot
  mistake Thundervim UI for message content.

## v0.3.9

This release improves navigation in long messages and list formatting.

### Changed

- **Vim motions keep the block cursor visible.** Long-distance jumps such as
  `gg`, `G`, and counted `G` motions now scroll the compose window, including
  jumps to an empty final line.
- **Visual `gq` formats lists with hanging indents.** Wrapped bullet and numbered
  items remain separate, and continuation text aligns beneath each item body.

## v0.3.8

This release fixes rich HTML editing and keeps diagnostics out of saved drafts.

### Fixed

- **Rich messages keep their rendered line structure.** Caret movement and edits
  now agree on line breaks between block elements, raw text, and inline content.
- **Rich drafts no longer expose source indentation as visible whitespace.**
  Thundervim preserves explicitly preformatted content while normalizing only
  whitespace that HTML would ordinarily collapse.
- **Structural Vim edits remain in Thunderbird's native undo history.** Range
  boundaries, block rewrites, and Gecko's ordinary-space/NBSP normalization no
  longer cause false transaction failures or flatten rich content.
- **Diagnostic traces open in a separate extension window.** Debug UI can no
  longer be autosaved into a draft, and legacy diagnostic nodes are removed
  when editing or sending affected messages.

## v0.3.7

### Changed

- **Vim and Thunderbird now share one undo history.** Single-cursor Vim text commands are recorded as native editor transactions, so `u`, `Ctrl-r`, `Cmd-Z` / `Ctrl-Z`, native typing, paste, and formatting traverse the same timeline.
- **Multi-cursor sessions retain Vim snapshot history.** Gecko cannot group disjoint ranges into one native transaction, so activating an extra cursor switches that compose window to the existing snapshot-based fallback.

## v0.3.6

This release keeps Vim and Thunderbird's native undo histories from interfering with each other.

### Fixed

- **Mixing Vim `u` / `Ctrl-r` with native `Cmd-Z` / `Ctrl-Z` no longer restores stale text.** Native text changes start a fresh Vim history boundary, while formatting-only actions preserve Vim history.
- **Unrelated application shortcuts no longer disturb Visual mode.** Send, Save, Find, and other untracked shortcuts pass directly to Thunderbird without selection or history side effects.

## v0.3.5

This release prevents plaintext replies from losing their quoted-message formatting when sent.

### Fixed

- **Wrapped quoted replies retain their `>` prefixes, line breaks, and paragraph spacing.** Send-time cleanup now modifies only `plainTextBody` for plaintext messages and only the HTML `body` for HTML messages, as required by Thunderbird's compose API.

## v0.3.4

This release prevents send-time cleanup from corrupting outgoing messages.

### Fixed

- **Plain-text URLs at the end of a message are preserved.** Legacy status cleanup now recognizes only complete status lines instead of mistaking the `//` in a URL for a Vim search prompt.
- **HTML messages retain their formatting and line breaks when sent.** Cleanup now removes only Thundervim's own status elements and never replaces the message body with flattened text.

## v0.3.3

Multi-cursor editing and platform-native shortcuts.

### Added

- **Multi-cursor editing MVP:** `Cmd-Option-Up/Down` on macOS or `Ctrl-Alt-Up/Down` on Windows/Linux add cursors above / below; vim motions move every cursor, and Insert-mode typing mirrors text at each cursor.
- **Platform-aware Thundervim shortcuts:** macOS uses `Cmd` as the primary modifier, while Windows/Linux use `Ctrl`.

## v0.3.2

This release focuses on making Thundervim feel native in Thunderbird while keeping outgoing mail clean.

### Added

- **Configurable preferences UI** for startup mode, enable/disable behavior, the platform-aware toggle chord, optional insert-mode escape sequence, `shiftwidth`, and `textwidth`.
- **Compose toolbar button** with a compact `Vim` label and a one-character status badge. Click it to enable or disable Thundervim in the current compose window.
- **Production packaging** with TypeScript, esbuild, a Makefile, add-on icons, an MIT license, a stable extension ID, CI, and add-on linting.

### Fixed

- **The vim status line is visible again without leaking into sent mail.** The mode/ruler line is shown at the bottom of the compose window, removed before send, and scrubbed again via `compose.onBeforeSend` using an invisible Thundervim marker.
- **Plain-text emails no longer contain status footer text** such as `-- INSERT --`, `1,6 All`, or similar ruler fragments.
- **Preferences layout in Thunderbird is compact and valid**, avoiding the oversized padding caused by malformed options-page markup.
- **Toolbar badge clipping** is avoided by using short one-character mode badges (`I`, `N`, `V`, `L`, `/`).

## v0.3.0

A sentence motion plus a major rich-text (HTML) reliability fix.

### Added

- **Sentence motions** `(` and `)` move to the previous / next sentence start.
  A sentence ends at `.`, `!`, or `?` (with any trailing `)`, `]`, `"`, `'`)
  followed by whitespace, and never crosses a blank line — matching the `is` /
  `as` text object added in v0.2.0.
- **Diagnostic dump** on `Ctrl-Alt-D` (macOS: `Ctrl`+`Option`+`D`) opens a
  copyable view of the live DOM and linear buffer model. Handy for reporting a
  round-trip bug on a complex message.

### Fixed

- **Joining across paragraphs no longer destroys the message.** In HTML compose,
  a `J` (or any edit) that merged two block elements used to fall back to a flat
  rewrite that flattened the *entire* body — collapsing blank lines and wiping
  the formatting of the quoted reply and signature. Structural edits now
  re-render only the blocks they actually touch, leaving quoted replies and
  other siblings fully intact.

## v0.2.0

New editing commands and a batch of rich-text (HTML) fixes.

### Added

- **Sentence text object** `s`: `das`, `dis`, `cas`, `cis`, `yas`, and Visual
  `as` / `is`. A sentence ends at `.`, `!`, or `?` (with any trailing `)`, `]`,
  `"`, `'`) followed by whitespace, and never crosses a blank line.
- **`r<Enter>`** replaces the character under the cursor with a newline, so you
  can break a line in place (e.g. turn a space into a line break). Works with a
  count (`3r<Enter>` collapses several characters into one break).

### Fixed

- Formatting shortcuts and the toolbar work again in HTML compose windows.
  `Cmd`/`Ctrl` + B/I/U now apply to the vim Visual selection, and clicking a
  toolbar button no longer stops working after a vim edit.
- Clipboard and undo shortcuts (`Cmd`/`Ctrl` + C/V/X/Z) pass through cleanly in
  every mode, with the engine resyncing after a native edit so vim motions stay
  accurate.

## v0.1.0 — first release

**Welcome to ThunderVIM!**

If you've ever finished writing an email and instinctively reached for `dd` or
`ciw`, this one's for you. Thundervim brings vim keybindings into Thunderbird's
compose window, so you can write mail the same way you write code — Normal,
Insert, and Visual modes, motions, operators, text objects, search, and all.

This is the very first public build. It's been in daily use and the plain-text
path is well tested, but you're among the first to try it — feedback and bug
reports are hugely appreciated.

### What you get

- **Modes** — Normal / Insert / Visual (and Visual-line), with a pinned status
  bar and a block cursor so you always know where you are.
- **Motions** — `h j k l`, `w W b B e E`, `ge`/`gE`, `0 ^ $`, `gg G`, `{ }`,
  `f F t T` with `;`/`,`, and `%` to hop between brackets. Counts work
  everywhere (`3w`, `2dd`, `d3w`).
- **Operators & text objects** — `d c y`, `x s`, the `D C S` line forms, and the
  full `i`/`a` text objects (`ciw`, `di"`, `ci(`, `daw`, `dip`, …).
- **Editing niceties** — join (`J`), indent (`>>` / `<<` / `>ip`), case
  (`~`, `gu`, `gU`, `g~`), replace (`r`), and repeat with `.`.
- **Reflow** — `gq` wraps paragraphs at column 72 and keeps quote markers
  (`> `) intact, which is exactly what you want in a reply.
- **Search** — `/` and `?` with smartcase, `*` / `#` for the word under the
  cursor, and `n` / `N` to step. Matches highlight as you type.
- **Undo / redo** — vim's own `u` and `Ctrl-r`, with an independent undo stack.
- **Private by design** — `y` / `p` use an internal register, so nothing you
  edit ever touches the system clipboard or leaves your machine. The status bar
  and cursor live outside the message body and are never sent.

### Rich text (HTML)

Thundervim works in both plain-text and HTML compose windows. In HTML, it edits
the text in place while leaving your existing formatting — quoted replies,
signatures, bold, links — untouched. Thunderbird's own shortcuts (Cmd/Ctrl-B,
-I, -U) keep working for bold/italic/underline, including over a Visual
selection. Vim itself doesn't author new rich formatting, since that isn't a vim
concept.

### Getting started

- **Insert mode is the default** when a compose window opens, so you can just
  start typing. Press `Esc` to drop into Normal mode.
- Toggle Thundervim on and off any time with `Ctrl-Alt-V`.
- `Ctrl-Enter` (Send), `Ctrl-S` (Save), and other app shortcuts pass straight
  through.

To try it now, grab `thundervim-0.1.0.xpi` from the release assets and load it
via **Tools → Developer Tools → Debug Add-ons → Load Temporary Add-on…**. See
the [README](README.md) for full install instructions and the complete command
reference.

### Good to know

- There's no options screen yet — settings live as constants at the top of
  `src/compose.js` (wrap column, toggle chord, optional `jk` escape, …).
- Search is a literal substring match, not regex, and isn't operator-pending
  (`d/pat` isn't supported yet).
- `.` doesn't repeat Visual-mode operations or searches.
- No `:` ex-commands, marks, named registers, or macros.
- HTML support is newer than the plain-text path; if a structural edit ever
  misbehaves on a complex message, please file an issue.

Happy editing — and may you never touch the mouse again.
