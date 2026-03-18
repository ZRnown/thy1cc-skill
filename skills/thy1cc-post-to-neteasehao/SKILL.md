---
name: thy1cc-post-to-neteasehao
description: Use when a user wants browser-led content management on Netease Hao, especially list/get/delete operations with low-risk pacing and explicit delete confirmation.
---

# Manage Netease Hao Content

## Overview

This skill is browser-led and safety-first for Netease Hao management tasks.

Supported modes:

- `list`: slow pagination over content-management pages
- `get`: extract article metrics (read, like, favorite, share, comment)
- `delete`: one-by-one deletion, only with explicit `--confirm`

The script prefers a logged-in Chrome debug session and DOM extraction. It does not rely on high-frequency direct backend polling.

## Script Directory

Determine this directory as `SKILL_DIR`, then use:

- `scripts/neteasehao-manage.ts`

## Preferences (EXTEND.md)

Check these locations in order:

```bash
test -f .thy1cc-skills/thy1cc-post-to-neteasehao/EXTEND.md && echo "project"
test -f "$HOME/.thy1cc-skills/thy1cc-post-to-neteasehao/EXTEND.md" && echo "user"
```

Supported keys:

- `chrome_profile_path`
- `content_manage_url`
- `default_max_pages`
- `slow_mode_ms`

Template: `references/config/first-time-setup.md`

## Commands

```bash
node --experimental-strip-types ${SKILL_DIR}/scripts/neteasehao-manage.ts list --max-pages 3
node --experimental-strip-types ${SKILL_DIR}/scripts/neteasehao-manage.ts get --article-id 123456
node --experimental-strip-types ${SKILL_DIR}/scripts/neteasehao-manage.ts delete --article-id 123456 --confirm
node --experimental-strip-types ${SKILL_DIR}/scripts/neteasehao-manage.ts delete --article-id 123456 --dry-run-delete
```

## Safety Rules

- Keep actions serial and slow (`--slow-ms`)
- Stop immediately when risk-control markers appear (captcha/security prompts)
- Never run delete without `--confirm`
- Use `--dry-run-delete` to verify delete chain without final confirm click
- `--confirm` and `--dry-run-delete` are mutually exclusive
- Default behavior is non-destructive

## Notes

- `get` metric extraction is heuristic because Netease Hao dashboards can vary by account/UI.
- If fields are missing, refine selectors from the currently rendered page instead of switching to high-frequency API calls.
