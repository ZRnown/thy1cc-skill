# skillCollection

Portable Codex/OpenClaw skills.

## Included Skills

- `skills/thy1cc-post-to-baijiahao`
  - Browser-driven Baijiahao article draft/publish skill
  - Also supports browser-led `list` / `get` / `delete` management for existing works
  - Supports HTML, markdown-with-companion-HTML, and plain text
  - Reuses a logged-in Chrome debugging session when available
- `skills/thy1cc-post-to-toutiaohao`
  - Browser-driven Toutiao creator management skill
  - Supports slow, page-led `list` / `get` / `delete` operations with explicit delete confirmation
- `skills/thy1cc-post-to-neteasehao`
  - Browser-driven Netease Hao creator management skill
  - Supports slow, page-led `list` / `get` / `delete` operations with explicit delete confirmation

## Install

Clone this repository, then copy the needed skills into your local Codex skills directory:

```bash
mkdir -p "$HOME/.codex/skills"
cp -R skills/thy1cc-post-to-baijiahao "$HOME/.codex/skills/"
cp -R skills/thy1cc-post-to-toutiaohao "$HOME/.codex/skills/"
cp -R skills/thy1cc-post-to-neteasehao "$HOME/.codex/skills/"
```

Then create one of these config files:

- `.thy1cc-skills/thy1cc-post-to-baijiahao/EXTEND.md`
- `$HOME/.thy1cc-skills/thy1cc-post-to-baijiahao/EXTEND.md`

See [`skills/thy1cc-post-to-baijiahao/references/config/first-time-setup.md`](skills/thy1cc-post-to-baijiahao/references/config/first-time-setup.md) for the template.

## Notes

- This repository intentionally excludes local login state, Chrome profiles, and user-specific `EXTEND.md` files.
- The Baijiahao publish flow defaults to saving drafts. Final publish remains opt-in via `--submit`.
- The management flows are browser-led and intentionally slow/serial to reduce automation risk.
