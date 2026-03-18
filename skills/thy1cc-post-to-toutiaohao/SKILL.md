---
name: thy1cc-post-to-toutiaohao
description: Use when a user needs browser-led Toutiao Hao content management: listing content, reading article metrics (reads/likes/collects/shares), and deleting one article with explicit confirmation.
---

# Manage Toutiao Hao

## Overview

This skill is browser-led and safety-first. It reuses a logged-in Chrome session when possible, falls back to launching an isolated profile, and performs `list/get/delete` via page navigation and DOM extraction.

`delete` is intentionally strict:

- requires `--confirm`
- requires `--id` or `--title`
- verifies the target is no longer visible after deletion

## Script Directory

Determine this directory as `SKILL_DIR`, then use:

| Script | Purpose |
|--------|---------|
| `scripts/toutiao-manage.ts` | List articles, get metrics, or delete one article |

## Preferences (EXTEND.md)

Check these locations in order:

```bash
test -f .thy1cc-skills/thy1cc-post-to-toutiaohao/EXTEND.md && echo "project"
test -f "$HOME/.thy1cc-skills/thy1cc-post-to-toutiaohao/EXTEND.md" && echo "user"
```

If neither exists, create one from [references/config/first-time-setup.md](references/config/first-time-setup.md).

Recommended keys:

- `chrome_profile_path`
- `content_manage_url`
- `default_slow_ms`

## Commands

### 1) List content

```bash
node --experimental-strip-types ${SKILL_DIR}/scripts/toutiao-manage.ts list \
  --max-pages 2
```

### 2) Get article metrics

By article id:

```bash
node --experimental-strip-types ${SKILL_DIR}/scripts/toutiao-manage.ts get \
  --id 1234567890 --max-pages 3
```

By title fuzzy match:

```bash
node --experimental-strip-types ${SKILL_DIR}/scripts/toutiao-manage.ts get \
  --title "你的文章标题" --max-pages 3
```

Expected metrics priority:

- reads
- likes
- collects
- shares
- comments (if detectable)

### 3) Delete one article

```bash
node --experimental-strip-types ${SKILL_DIR}/scripts/toutiao-manage.ts delete \
  --id 1234567890 --confirm --max-pages 2
```

or

```bash
node --experimental-strip-types ${SKILL_DIR}/scripts/toutiao-manage.ts delete \
  --title "你的文章标题" --confirm --max-pages 2
```

## Safety Defaults

- Slow mode is enabled by default (`--slow-ms 2200`).
- No bulk delete mode is provided.
- No high-frequency backend API polling is used.
- If login expires or a verification page appears, the script fails fast for manual recovery.

## Output

Default output is JSON for automation and audit logs.

Use `--text` if you only need a short human-readable line.
