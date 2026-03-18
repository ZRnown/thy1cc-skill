---
name: thy1cc-post-to-baijiahao
description: Use when a user wants to publish or save articles to Baijiahao from HTML, markdown, or article-package files through a real Chrome login session, especially for browser-driven draft upload or explicit final submission.
---

# Post to Baijiahao

## Overview

Publish long-form Baijiahao articles through the logged-in creator backend in Chrome.

The same skill now also supports browser-led content management (`list`, `get`, `delete`) with slow serial navigation and explicit delete confirmation.

Default mode is browser-driven draft saving. Final publish should be opt-in with `--submit`, because Baijiahao may show extra dialogs, cover checks, or risk controls.

## Script Directory

Determine this directory as `SKILL_DIR`, then use these scripts:

| Script | Purpose |
|--------|---------|
| `scripts/check-permissions.ts` | Verify Chrome, Bun, profile dir, and Baijiahao reachability |
| `scripts/baijiahao-article.ts` | Publish or save one article through the browser |
| `scripts/baijiahao-manage.ts` | Browser-led list/get/delete for creator content management |

## Preferences (EXTEND.md)

Check these locations in order:

```bash
test -f .thy1cc-skills/thy1cc-post-to-baijiahao/EXTEND.md && echo "project"
test -f "$HOME/.thy1cc-skills/thy1cc-post-to-baijiahao/EXTEND.md" && echo "user"
```

If neither exists, create one using [references/config/first-time-setup.md](references/config/first-time-setup.md).

Supported keys:

- `default_author`
- `chrome_profile_path`
- `editor_url`
- `create_button_texts`
- `default_action`

Value priority:

1. CLI arguments
2. Frontmatter or HTML meta
3. `EXTEND.md`
4. Skill defaults

## Workflow

Publishing Progress:
- [ ] Step 0: Load preferences
- [ ] Step 1: Determine input type
- [ ] Step 2: Prepare HTML if needed
- [ ] Step 3: Validate metadata
- [ ] Step 4: Run preflight check
- [ ] Step 5: Publish via browser
- [ ] Step 6: Report result and any manual follow-up

### Step 0: Load Preferences

Load `EXTEND.md` before doing anything else. If missing, create it from the reference template and continue.

### Step 1: Determine Input Type

Supported inputs:

- HTML file: use directly
- Markdown file: prefer a prepared companion HTML file in the same article package
- Plain text: allowed only for small one-off posts; pass as `--content` with explicit `--title`

Recommended package layout:

- `source.md`
- `article-rewrite.md`
- `article-publish.md`
- `article-publish.html`
- `manifest.json`
- `imgs/cover.png`

If a markdown file is provided without a ready HTML companion, prefer converting it first with `baoyu-markdown-to-html` or the existing WeChat HTML render workflow instead of inventing ad hoc HTML in chat.

Operational notes from current usage:

- If an article package already has `article-publish.html`, upload that file directly. Do not reconstruct title or summary from a stale root `manifest.json`.
- For long-form article batches, treat the HTML artifact as the source of truth for `<title>`, `<meta name="description">`, and body structure.

### Step 2: Prepare HTML If Needed

For HTML input, the browser script extracts the content from `#output` when present, otherwise it falls back to the `<body>` content.

For markdown input, use a prepared HTML file when possible. This keeps the Baijiahao script thin and avoids bundling another renderer into this skill.

### Step 3: Validate Metadata

Check:

- `title`
- `summary`
- `author`
- optional `cover`

Rules:

- Do not assume the editor can infer title from HTML.
- Prefer explicit summary. Auto-summary fallback is only a safety net.
- Cover upload is not guaranteed on every Baijiahao editor version. If the platform blocks automatic cover handling, report that and stop before final submit.

### Step 4: Run Preflight Check

```bash
npx -y bun ${SKILL_DIR}/scripts/check-permissions.ts
```

This verifies the runtime and confirms that Baijiahao is reachable before a browser session is started.

If a fixed debug port fails, do not assume Chrome is unavailable. Check whether a logged-in Chrome is already exposing another live CDP port and reuse that session first.

### Step 5: Publish Via Browser

Draft-first flow:

```bash
npx -y bun ${SKILL_DIR}/scripts/baijiahao-article.ts \
  --html article-publish.html \
  --title "标题" \
  --summary "摘要" \
  --author "作者"
```

If the user explicitly wants final publish:

```bash
npx -y bun ${SKILL_DIR}/scripts/baijiahao-article.ts \
  --html article-publish.html \
  --title "标题" \
  --summary "摘要" \
  --submit
```

The script will:

1. Reuse an existing Chrome debug session if possible, otherwise launch an isolated Chrome profile.
2. Confirm the Baijiahao login state with a live `/builder/author/app/currentuser` probe.
3. Reach the article editor through either `editor_url` or heuristic create-button clicks.
4. Fill title and summary when matching fields are found.
5. Inject HTML into the richest editable surface it can detect.
6. Click draft-save by default, or publish only when `--submit` is set.

Remote-image note:

- Public image URLs are not automatically safe for Baijiahao. The editor uploads remote assets through `/materialui/picture/uploadProxy`, and some public hosts or redirect-style image URLs can still fail there.
- Prefer stable direct image URLs, especially Wikimedia thumb URLs, over indirect redirect pages such as `Special:FilePath` when image durability matters.

### Step 6: Report Result

Always report:

- Whether login succeeded
- Whether the editor was reached automatically
- Whether title/summary/body were filled
- Whether the action ended in draft save or submit attempt
- Any manual follow-up still needed, especially cover selection or secondary confirmation dialogs

Draft-save acceptance should use layered evidence:

- Save response from `/pcui/article/save` with `errno=0` and draft status
- Preview check from the rendered draft page for title/body/image count
- Reopened editor check for final uploaded image count inside `iframe#ueditor_0`

The content list is only a secondary hint. Preview image counts can still be false positives if the editor later reopens with fewer images.

## Content Management Workflow (Browser-Led)

Use this when you need creator-side operations on existing works.

### Supported Commands

```bash
npx -y bun ${SKILL_DIR}/scripts/baijiahao-manage.ts list --max-pages 3 --page-size 10
npx -y bun ${SKILL_DIR}/scripts/baijiahao-manage.ts get --article-id 1859795452973012305
npx -y bun ${SKILL_DIR}/scripts/baijiahao-manage.ts delete --article-id 1859795452973012305 --confirm
```

`list` returns title/status/time/article_id/nid/url with best-effort metrics extracted from page DOM.

`get` focuses on运营数据读取 (阅读/点赞/收藏/转发, and comment when detectable) using page text and DOM extraction.

`delete` is intentionally narrow and safety-first:

- Requires `--confirm`
- Requires explicit target (`--article-id` or `--nid`)
- Operates on one article per run
- Performs post-delete page recheck before reporting success

### Safety Boundaries

- Browser-led only: reuse logged-in Chrome CDP session where possible.
- Slow serial operations: page navigation is throttled by `--slow-ms` (default enabled).
- Stop on challenge/risk indicators (`验证码`, `安全验证`, `扫码登录`, etc.) instead of retry-spamming.
- Avoid high-frequency direct backend API loops for management operations.

## Common Mistakes

- Treating `--submit` as the default. Use draft mode first.
- Assuming markdown can always be rendered inline. Reuse a prepared HTML artifact when available.
- Assuming Baijiahao cover upload is stable across UI versions.
- Treating a Baijiahao page URL as proof of login. The browser flow should trust the `currentuser` probe plus page text, not URL shape alone.
- Treating any public image URL as upload-safe. A URL can open in the browser and still fail `/materialui/picture/uploadProxy`.
- Counting preview success alone as final success when正文图落地 matters. Reopen the editor and verify image persistence.

## References

- Setup and preferences: [references/config/first-time-setup.md](references/config/first-time-setup.md)
