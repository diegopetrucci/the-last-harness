# Web-Search Spec (tlha-s6xu)

> **Historical/planning reference.** Durable web-search / web-scout decisions
> for this work now live in repo-local Gnosis (entries `ywsuwh` and `gbmehw`).
> This document remains the working note for pinned fork/tag details, tool and
> config snapshots, and other actionable implementation context tied to tickets
> tlha-1xp0, tlha-bw2g, tlha-wbrc, tlha-nelh, tlha-sqox, tlha-kkye, and
> tlha-7jwh. When those durable decisions or these implementation notes change,
> keep the related tickets and this file aligned.

---

## Pinned tag

- Upstream: `nicobailon/pi-web-access@v0.10.7` (commit SHA: `076bf0db5e739b200286ca37486e4edd8d19123c`)
- Fork tag: `tlh-v0.10.7-1` (annotated, unsigned — gpg not available)
- Tag SHA: `863cb9fa1746eb2cb35543e20440508fd57fc85b` (Tagged 2026-05-22)
- Branch HEAD at tag: `cf224b77ed45bb4826f30898dfb8f559fb69622f`

---

## Fork target & tag style

- Fork: `github.com/diegopetrucci/pi-web-access` from `nicobailon/pi-web-access`.
- Release tag style: `tlh-vX.Y.Z-N` (mirrors the convention used by
  `pi-subagents`, `pi-intercom`, and `pi-rtk`).

---

## Tool surface (kept / dropped)

**Kept:**

- `web_search`
- `fetch_content`
- `get_search_content`

**Dropped:** `code_search` and all non-Exa providers/features (see tlha-1xp0).

---

## Tool-name policy

Keep upstream tool names as-is — no `_pa` or `_tlh` suffix.

Running the upstream `pi-web-access` alongside the TLH fork simultaneously is
**unsupported**. Document this constraint wherever the extension is described.

---

## Subagent

| Parameter | Value |
|---|---|
| Name | `web-scout` |
| Delegation style | Free delegation — no oracle-style user-confirmation gate |
| Model (Anthropic) | `anthropic/claude-haiku-4-5` |
| Models (OpenAI / `tlhOpenaiModels`) | `openai-codex/gpt-5.4-mini`, `openai/gpt-5.4-mini` |
| Thinking | `high` |
| `systemPromptMode` | `replace` |
| `inheritProjectContext` | `true` |
| `inheritSkills` | `false` |
| `defaultContext` | `fresh` |

### Tools allowlist

`web_search`, `fetch_content`, `get_search_content`, `read`, `grep`, `find`,
`ls`, `contact_supervisor`.

**Not allowed:** `bash`, subagent delegation tools.

---

## Config paths & no-migration policy

- **Settings:** `PI_CODING_AGENT_DIR/extensions/pi-web-access/`
- **Cache:** `PI_CODING_AGENT_DIR/cache/pi-web-access/`

The fork must never read from or write to `~/.pi/`. There is **no automatic
migration** from `~/.pi/web-search.json`. Provide a manual one-liner in the
README for users who want to copy an existing key.

---

## EXA key precedence

1. Explicit setting in the isolated profile settings
2. `EXA_API_KEY` environment variable
3. Exa MCP fallback

The API key must **never** be persisted during settings merges unless it was
explicitly set by the user.

---

## Default-extensions entry policy

- `critical: false`
- No `replaces` field
- No `migrateReplacements` field
- Standard `tlh.disabledDefaultExtensions` opt-out applies

---

## Architect routing rule

> Use librarian for GitHub repositories, issues, pull requests, releases, and
> project docs; use web-scout for general web research outside GitHub. If both
> could apply, prefer librarian for code/source-history questions.

---

## README opt-out copy

> `tlh defaults disable pi-web-access`

Include a privacy note that queries leave the machine.
