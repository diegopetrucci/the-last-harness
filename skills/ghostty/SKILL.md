---
name: ghostty
description: "Drive Ghostty.app on macOS through its AppleScript dictionary: list windows, tabs and terminals, open a window, tab or split, type text, send keys, focus and close. Use only when the user explicitly mentions Ghostty or Ghostty.app; macOS only. TERM_PROGRAM=ghostty is not proof you are inside Ghostty.app (Herdr.app sets it too) — for tmux, cmux, or the Herdr GUI/TUI use those skills."
---

# Ghostty

Ghostty is scriptable only on macOS, through its AppleScript dictionary (Ghostty 1.3+; checked against 1.4.0). Always target windows and terminals by `id`: a real session has other windows, tabs, and panes that are not yours.

## Preflight

```sh
osascript -e 'tell application "Ghostty" to get version'
```

Anything older than 1.3 lacks this dictionary. The first call may raise a macOS Automation prompt the user must approve. If the command fails, times out, or prints nothing, say Ghostty is not scriptable from here and stop.

## Version-matched reference

Do not copy AppleScript docs; ask the installed app instead:

```sh
sdef /Applications/Ghostty.app || cat /Applications/Ghostty.app/Contents/Resources/Ghostty.sdef
/Applications/Ghostty.app/Contents/MacOS/ghostty +list-actions --docs
```

The first line needs Xcode Command Line Tools and falls back to the installed dictionary file; the second lists the action strings `perform action` accepts (`increase_font_size:1`, `write_screen_file:copy`, …). Never run bare `ghostty`: with no action it opens another terminal.

## Inspect

```applescript
tell application "Ghostty" -- windows: id, name, selected tab; terminals: id, name, working directory, tty, pid
  set out to ""
  repeat with w in windows
    set out to out & "W " & (id of w) & " " & (name of w) & linefeed
    repeat with t in terminals of w
      set out to out & "  T " & (id of t) & " " & (tty of t) & " " & (working directory of t) & linefeed
    end repeat
  end repeat
  return out
end tell
```

Tabs are `tabs of w` with `id`, `name`, `index`, `selected`, `focused terminal`. `name override` is writable on a tab or terminal; set it to `""` to clear it. To find your own shell's terminal, compare `tty` with `tty of every terminal`; never assume the front window is yours.

## Create, type, send keys

```applescript
tell application "Ghostty"
  set cfg to new surface configuration
  set initial working directory of cfg to "/tmp" -- also: command, initial input, wait after command, environment variables, font size
  set t to split (first terminal whose id is "TERM-ID") direction right with configuration cfg -- right|left|down|up
  input text "echo hello" to t -- pasted, not typed
  send key "enter" to t
  send key "c" modifiers "control" to t -- shift, control, option, command
  set newTab to new tab in (first window whose id is "WINDOW-ID") with configuration cfg
end tell
```

`split` returns the new terminal, `new tab` a tab, `new window` a window; without `with configuration` the default profile applies.

## Focus, close, actions

```applescript
tell application "Ghostty"
  activate window (first window whose id is "WINDOW-ID")
  select tab (first tab of (first window whose id is "WINDOW-ID") whose id is "TAB-ID")
  focus (first terminal whose id is "TERM-ID") -- also raises the window
  close (first terminal whose id is "TERM-ID")
  close tab (first tab of (first window whose id is "WINDOW-ID") whose id is "TAB-ID") -- tabs only exist inside a window
  close window (first window whose id is "WINDOW-ID")
  perform action "ACTION-STRING" on (first terminal whose id is "TERM-ID") -- any keybind action; unknown ones return false
end tell
```

## Reading output

AppleScript has no read API. Preferred: run `tmux` inside the pane and capture output with the tmux skill.

Fallback, only with the user's explicit consent: it overwrites the clipboard, clipboard managers may record the text, and the screen may hold secrets; the save/restore is text-only, so images, files, and rich text on the clipboard are lost, and anything the user copies while the read runs is overwritten.

```sh
if before=$(mktemp) && pbpaste > "$before"; then # text only: images, files, rich text are lost
  printf '' | pbcopy # clear it, so a stale path cannot pass for Ghostty's file
  osascript -e 'tell application "Ghostty" to perform action "write_screen_file:copy" on (first terminal whose id is "TERM-ID")' >/dev/null || true
  file=$(pbpaste); pbcopy < "$before"; rm -f "$before" # restore even when the action failed
  tmp=$(cd "${TMPDIR:-/tmp}" && pwd -P) # Ghostty writes <tmp>/<random>/{screen,history,selection}.txt
  dir=$(cd "$(dirname "$file")" 2>/dev/null && pwd -P) || dir=""
  case $file in */screen.txt|*/history.txt|*/selection.txt) ;; *) file="" ;; esac
  case ${dir#"$tmp"/} in ""|*/*) file="" ;; esac # the resolved parent must be one level under tmp
  if [ -n "$file" ] && [ ! -L "$file" ] && [ -f "$file" ]; then # no symlinks; prints true even when nothing was written
    cat "$file"; rm -f "$file"; rmdir "$dir" 2>/dev/null || true # Ghostty leaves the dir behind
  fi
else
  echo "clipboard backup failed; nothing read" >&2; rm -f "$before" # never clear it without a backup
fi
```

`write_scrollback_file:copy` and `write_selection_file:copy` (no-op without a selection) work the same way; a no-op leaves the clipboard empty, so nothing is read. `:paste` pastes the path into the terminal instead of the clipboard; `:open` opens it in the default editor.

## Rules

- Delegation stays with the TLH `subagent` tool; use Ghostty to run or watch a process only when the user asks for it there.
- Act only on terminals you created unless the user explicitly asks about an existing one: never type into, close, or focus-steal a window you did not open, and never run `quit`.
- Read only the terminals the task needs; other panes hold the user's work and possibly secrets.
