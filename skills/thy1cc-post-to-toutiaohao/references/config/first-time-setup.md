# First-Time Setup

Create one of these files:

- Project-level: `.thy1cc-skills/thy1cc-post-to-toutiaohao/EXTEND.md`
- User-level: `$HOME/.thy1cc-skills/thy1cc-post-to-toutiaohao/EXTEND.md`

Recommended template:

```md
chrome_profile_path: $HOME/.local/share/toutiaohao-browser-profile
content_manage_url: https://mp.toutiao.com/profile_v4/graphic/publish
default_slow_ms: 2200
```

Notes:

- `chrome_profile_path`: use a dedicated Chrome profile for creator-platform automation.
- `content_manage_url`: optional override when your account lands on a different content-management path.
- `default_slow_ms`: click/navigation delay in milliseconds; keep it above 1500 to reduce risk signals.
