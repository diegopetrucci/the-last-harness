# Launch telemetry

Release builds with TelemetryDeck identifiers configured send at most one pseudonymous launch event when an interactive `tlh` process starts.

## What is sent

The event contains:

- a hashed random install ID,
- event type,
- TLH version,
- a privacy-filtered model value,
- OS name and version,
- OS architecture,
- current `on`/`off` state for each registered TLH experimental feature.

Only registered TLH experimental feature IDs are reported. Unknown, custom, or legacy `tlh.experimental.enabledFeatures` values in settings are ignored and not sent.

TelemetryDeck also receives normal network metadata such as source IP address and request time.

## What is not sent

The event does **not** include:

- prompts,
- current working directory,
- command arguments,
- repo names,
- hostname,
- username,
- file contents,
- settings contents,
- full environment variables,
- extension or package lists,
- API keys,
- provider base URLs,
- auth state,
- headers,
- account identifiers.

## Opting out

Opt out persistently by adding this to `~/.the-last-harness/agent/settings.json`:

```json
{
  "tlh": {
    "telemetry": {
      "enabled": false
    }
  }
}
```

That settings opt-out is preserved by `tlh update` and installer reruns.

For a single run, set one of:

- `PI_OFFLINE=1`
- `TLH_SKIP_TELEMETRY=1`
- `TLH_TELEMETRY_DISABLED=1`
- `PI_TELEMETRY=0`

To reset only the pseudonymous install ID, remove `~/.the-last-harness/agent/tlh/telemetry-state.json`.
