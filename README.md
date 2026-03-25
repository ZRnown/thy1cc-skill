# thy1cc-skill

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
- `skills/thy1cc-post-to-qiehao`
  - Browser-driven Qiehao draft posting skill
  - Supports `--probe-only` login/editor checks plus real draft saving through the live editor
  - Reuses a logged-in Chrome debugging session when available
- `skills/github-weekly-trending-cards`
  - GitHub Weekly Trending 卡片生成技能（封面 + 项目详情页）
  - 支持在线抓取周榜数据或读取本地 JSON 数据
  - 输出 `html/png/manifest/sources/summary`，可直接用于发布

## Install

Clone this repository, then copy the needed skills into your local Codex skills directory:

```bash
mkdir -p "$HOME/.codex/skills"
cp -R skills/thy1cc-post-to-baijiahao "$HOME/.codex/skills/"
cp -R skills/thy1cc-post-to-toutiaohao "$HOME/.codex/skills/"
cp -R skills/thy1cc-post-to-neteasehao "$HOME/.codex/skills/"
cp -R skills/thy1cc-post-to-qiehao "$HOME/.codex/skills/"
cp -R skills/github-weekly-trending-cards "$HOME/.codex/skills/"
```

Then create one of these config files:

- `.thy1cc-skills/thy1cc-post-to-baijiahao/EXTEND.md`
- `$HOME/.thy1cc-skills/thy1cc-post-to-baijiahao/EXTEND.md`

See [`skills/thy1cc-post-to-baijiahao/references/config/first-time-setup.md`](skills/thy1cc-post-to-baijiahao/references/config/first-time-setup.md) for the template.

## Notes

- This repository intentionally excludes local login state, Chrome profiles, and user-specific `EXTEND.md` files.
- The Baijiahao publish flow defaults to saving drafts. Final publish remains opt-in via `--submit`.
- The management flows are browser-led and intentionally slow/serial to reduce automation risk.
