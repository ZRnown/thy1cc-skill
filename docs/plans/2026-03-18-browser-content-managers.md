# Browser Content Managers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add browser-led `list` / `get` / `delete` management workflows for Baijiahao, then create a parallel Netease Hao skill with the same safety-first behavior, keeping the repo ready for later Toutiao reuse.

**Architecture:** Keep each skill self-contained. Reuse the existing Chrome CDP pattern, but move management logic into dedicated scripts and pure helper modules that can be covered with unit tests before browser wiring. Default to slow, serial, logged-in browser navigation; only use page-context requests when unavoidable and never rely on high-frequency direct backend calls.

**Tech Stack:** TypeScript, Bun-style test files, Chrome CDP, text-first DOM extraction, git-managed skill repo

---

### Task 1: Baijiahao management helpers

**Files:**
- Create: `skills/thy1cc-post-to-baijiahao/scripts/baijiahao-manage-types.ts`
- Create: `skills/thy1cc-post-to-baijiahao/scripts/baijiahao-manage-parse.ts`
- Test: `skills/thy1cc-post-to-baijiahao/scripts/baijiahao-manage-parse.test.ts`

**Step 1: Write the failing tests**

Cover:
- command parsing for `list`, `get`, `delete`
- metrics normalization for read / like / collect / share
- delete safety checks requiring explicit confirmation

**Step 2: Run test to verify it fails**

Run: `bun test skills/thy1cc-post-to-baijiahao/scripts/baijiahao-manage-parse.test.ts`

**Step 3: Write minimal implementation**

Implement pure helpers only. No browser code in this task.

**Step 4: Run test to verify it passes**

Run: same command as Step 2

### Task 2: Baijiahao browser-led manager

**Files:**
- Create: `skills/thy1cc-post-to-baijiahao/scripts/baijiahao-manage.ts`
- Modify: `skills/thy1cc-post-to-baijiahao/SKILL.md`
- Test: `skills/thy1cc-post-to-baijiahao/scripts/baijiahao-manage.test.ts`

**Step 1: Write the failing tests**

Cover:
- help output documents `list`, `get`, `delete`, `--confirm`, `--max-pages`
- safe defaults remain non-destructive

**Step 2: Run test to verify it fails**

Run: `bun test skills/thy1cc-post-to-baijiahao/scripts/baijiahao-manage.test.ts`

**Step 3: Write minimal implementation**

Implement:
- `list`: slow pagination on content-management pages
- `get`: open article or data page and read metrics from DOM
- `delete`: list-page selection + visible-text confirmation flow + post-delete recheck

**Step 4: Run tests**

Run:
- `bun test skills/thy1cc-post-to-baijiahao/scripts/baijiahao-manage.test.ts`
- `bun test skills/thy1cc-post-to-baijiahao/scripts/*.test.ts`

### Task 3: Netease Hao browser-led skill

**Files:**
- Create: `skills/thy1cc-post-to-neteasehao/SKILL.md`
- Create: `skills/thy1cc-post-to-neteasehao/agents/openai.yaml`
- Create: `skills/thy1cc-post-to-neteasehao/references/config/first-time-setup.md`
- Create: `skills/thy1cc-post-to-neteasehao/scripts/*.ts`
- Create: `skills/thy1cc-post-to-neteasehao/scripts/*.test.ts`

**Step 1: Write the failing tests**

Cover:
- CLI help
- command parsing
- metrics extraction helpers
- delete confirmation behavior

**Step 2: Run test to verify it fails**

Run: targeted Bun tests for the new skill

**Step 3: Write minimal implementation**

Mirror the Baijiahao management shape, but with Netease Hao URLs, login checks, and DOM heuristics.

**Step 4: Run tests**

Run all Netease skill tests.

### Task 4: Repo integration and follow-up

**Files:**
- Modify: `README.md`
- Sync later: `/Users/wanghaixin/.codex/skills/thy1cc-post-to-baijiahao`

**Step 1: Update docs**

Document the new management commands and the new Netease Hao skill.

**Step 2: Verification**

Run targeted test suites and any safe dry-run checks.

**Step 3: Sync**

Copy the updated Baijiahao skill into the local Codex skills directory after repo changes are verified.
