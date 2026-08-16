# TLH notify

First-party `notify` extension for The Last Harness.

Sends notifications when the agent has fully settled and is waiting for input.

## Attribution

This is vendored from [`@diegopetrucci/pi-notify`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/notify) (MIT, © Diego Petrucci), which itself started from the original `notify.ts` example in [`earendil-works/pi`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/notify.ts) (MIT). Both are MIT-licensed; see the [repository LICENSE](../../LICENSE) for the full license text.

## Supported notification channels

### Terminal notifications

- OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
- OSC 99: Kitty

### Desktop notifications

- macOS Notification Center via `osascript`
- Linux desktop notifications via `notify-send`
- Windows toast notifications via `powershell.exe` / Windows Terminal / WSL

### Bells and sounds

- terminal bell (`\a`)
- macOS sound playback via `afplay`
- Linux sound playback via `canberra-gtk-play` or `paplay`
- Windows beep via `powershell.exe`

By default, these channels are enabled:

- terminal notification
- desktop notification
- bell

Sound remains available as an opt-in option via config.

## Configuration

Config files are merged, with project config overriding global config:

- `~/.the-last-harness/agent/extensions/notify.json`
- `<project>/.pi/notify.json` (only when the project is trusted)

Example:

```json
{
  "enabled": true,
  "onlyWhenInteractive": true,
  "suppressWhileActive": true,
  "title": "tlh",
  "body": "Ready for input",
  "channels": {
    "terminal": true,
    "desktop": true,
    "bell": true,
    "sound": false
  },
  "terminal": {
    "backend": "auto"
  },
  "desktop": {
    "backend": "auto"
  },
  "sound": {
    "backend": "auto",
    "name": "Glass",
    "linuxSoundId": "complete",
    "frequencyHz": 1000,
    "durationMs": 250,
    "command": ""
  }
}
```

### Config fields

- `enabled`: master on/off switch
- `onlyWhenInteractive`: skip notifications in print / non-UI mode
- `suppressWhileActive`: when `true` (default), hold all notification channels while background subagent work is still running — a ping means the session is genuinely waiting on you, not merely between turns; notifications resume once all background work clears; has no effect when the TLH activity tracker is absent
- `title`: notification title (default: `"tlh"`)
- `body`: notification body (default: `"Ready for input"`)
- `channels.terminal`: enable terminal notification output
- `channels.desktop`: enable OS desktop notifications
- `channels.bell`: enable terminal bell
- `channels.sound`: enable sound playback (opt-in; off by default)
- `terminal.backend`: `auto`, `osc777`, `osc99`, `none`
- `desktop.backend`: `auto`, `macos`, `linux`, `windows-toast`, `none`
- `sound.backend`: `auto`, `macos`, `linux`, `windows-beep`, `command`, `none`
- `sound.name`: macOS system sound name, e.g. `Glass` or `Hero`
- `sound.linuxSoundId`: freedesktop sound id, e.g. `complete`
- `sound.frequencyHz`: Windows beep frequency
- `sound.durationMs`: Windows beep duration
- `sound.command`: custom shell command when `sound.backend` is `command`

## Notes

- Hooks the `agent_settled` event so automatic retries, compaction retries, and queued follow-ups do not trigger intermediate notifications.
- Terminal, desktop, bell, and sound channels can be enabled independently.
