---
name: thy1cc-post-to-toutiaohao
description: "Use when a user needs browser-led Toutiao Hao draft upload or content management, including saving article drafts, listing content, reading article metrics, and deleting one article with explicit confirmation."
---

# Manage Toutiao Hao

## Overview

This skill is browser-led and safety-first. It reuses a logged-in Chrome session when possible, falls back to launching an isolated profile, and now supports both article draft upload and `list/get/delete` management flows through page navigation and DOM extraction.

`delete` is intentionally strict:

- requires exactly one of `--confirm` or `--dry-run-delete`
- requires `--id` or `--title`
- verifies the target is no longer visible after deletion

## Script Directory

Determine this directory as `SKILL_DIR`, then use:

| Script | Purpose |
|--------|---------|
| `scripts/toutiao-article.ts` | Save one long-form article into the Toutiao draft box |
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

### 1) Save one article into drafts

```bash
node --experimental-strip-types ${SKILL_DIR}/scripts/toutiao-article.ts \
  --html article-publish.html
```

Markdown package with companion HTML:

```bash
node --experimental-strip-types ${SKILL_DIR}/scripts/toutiao-article.ts \
  --markdown article-publish.md
```

Plain text fallback:

```bash
node --experimental-strip-types ${SKILL_DIR}/scripts/toutiao-article.ts \
  --content "正文" \
  --title "标题"
```

Operational notes:

- The script uses the real image drawer upload flow (`input[type=file]` + drawer confirm) so body images persist after reopening the draft.
- Title input is React-controlled; the script uses the native textarea setter rather than `el.value = ...`.
- Draft success is verified in three layers: page-side `草稿已保存`, draft-list fetch match by title, and reopened-editor image-count check after clicking `继续编辑`.
- Toutiao title length is stricter than some other platforms; if the source title is too long, the script shortens it before saving and reports both versions.

### 2) List content

```bash
node --experimental-strip-types ${SKILL_DIR}/scripts/toutiao-manage.ts list \
  --max-pages 2
```

### 3) Get article metrics

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

### 4) Delete one article

```bash
node --experimental-strip-types ${SKILL_DIR}/scripts/toutiao-manage.ts delete \
  --id 1234567890 --confirm --max-pages 2
```

or

```bash
node --experimental-strip-types ${SKILL_DIR}/scripts/toutiao-manage.ts delete \
  --title "你的文章标题" --confirm --max-pages 2
```

Dry-run delete (no final confirm click):

```bash
node --experimental-strip-types ${SKILL_DIR}/scripts/toutiao-manage.ts delete \
  --id 1234567890 --dry-run-delete --max-pages 2
```

## Safety Defaults

- Slow mode is enabled by default (`--slow-ms 2200`).
- No bulk delete mode is provided.
- No high-frequency backend API polling is used.
- `--confirm` and `--dry-run-delete` are mutually exclusive.
- If login expires or a verification page appears, the script fails fast for manual recovery.

## Output

Default output is JSON for automation and audit logs.

Use `--text` if you only need a short human-readable line.
