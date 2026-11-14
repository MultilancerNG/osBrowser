# Changes from AliasMode / StakeMode

GameBrowser is a modified version of AliasMode/StakeMode (Copyright 2026 Xreacher, Apache License 2.0). Changes made by Solomon Gbeta:

- Renamed the product to GameBrowser and added a portable Windows layout and an Inno Setup installer.
- Admin/follower relay: auto-follow, forced followers, automatic rejoin after transient failures, followers move to the admin's page, a dashboard disconnect grace period, and https://stake.com pinned as the main site.
- Dashboard redesign: stats bar, Following bar (Save session, Resume, Stop following, Reload all, Make all followers), grid/list switch, Full Admin View with a followers strip, purple admin and teal follower borders.
- Sounds for mirrored admin clicks and follower disconnects; plain-language error advice in banners and on profiles.
- Readiness status per profile, mass delete, phone/tablet view mode, and automatic RAM/JS heap budgets.
- New server routes: reload-all, follow (pause/resume), save-session, force-followers, view.
- Build and Pages workflows for this repository.

Sensitive actions (login, passwords, 2FA, CAPTCHA, deposits, withdrawals, bets) are still never mirrored.
