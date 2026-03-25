# Quickstart

## 1) 进入技能目录

```bash
export SKILL_DIR="/path/to/thy1cc-skill/skills/github-weekly-trending-cards"
cd "$SKILL_DIR"
```

## 2) 首次安装截图依赖

```bash
cd "$SKILL_DIR"
npm install
npx playwright install chromium
```

## 3) 生成一套周榜卡片

```bash
python3 scripts/build_github_weekly_cards.py \
  --issue "第一期" \
  --date "2026-03-23" \
  --brand-name "AI造物社"
```

如果你要带品牌头像，再额外传：

```bash
--brand-avatar "/path/to/avatar.webp"
```

## 4) 产物位置

默认会输出到当前目录下：

`github-trending-ljg-card-YYYYMMDD`

其中 `png/00-cover.png` 是封面。
