# osBrowser · GameBrowser

GameBrowser is a Windows desktop workspace for running many isolated browser profiles side by side. You pick one profile as the admin, and the others follow it: page changes and ordinary clicks, typing and scrolling on stake.com are mirrored to every follower. Each profile keeps its own cookies, storage, proxy and screen size.

**Download:** [multilancerng.github.io/osBrowser](https://multilancerng.github.io/osBrowser/) or the [latest release](https://github.com/MultilancerNG/osBrowser/releases/latest).

## What it does

- Live grid of every running profile, with the admin outlined in purple and followers in teal
- Full Admin View with browser tabs, an address bar and a strip of connected followers
- Auto-follow: choose an admin and every other running profile follows it
- Followers rejoin on their own after a slow page, a reload or a short disconnect
- A tick sound for each mirrored admin click, and an alert when a follower drops off
- Reload all, Save session, Resume and Stop following for the whole fleet
- Readiness badge on every profile, plus plain-language advice when something goes wrong
- Phone and tablet view mode with touch input for Chromium profiles
- RAM budget and JS heap sized automatically from your PC's memory
- Bulk create, mass delete, groups, tags, proxy library and read-only automation

Logins, passwords, 2FA, CAPTCHAs, deposits, withdrawals and bets are never mirrored. A follower that reaches one of those pages switches to manual and waits for you.

## Install

**Installer (recommended):** download `GameBrowser-Setup-windows-x64.exe` from the latest release and run it. It installs to your user folder (no admin rights), adds Start menu and desktop shortcuts, and has a normal uninstaller.

**Portable:** download `GameBrowser-windows-x64-portable.zip`, extract it anywhere, and run `GameBrowser.exe`. Keep the `runtime`, `cloakbrowser` and `firefox` folders next to the exe.

The dashboard opens at `http://127.0.0.1:8080/workspace/dashboard.html`. Keep the console window open while you work; closing it stops every profile. GameBrowser uses local port 8080, so close StakeMode or anything else on that port first. Profiles are stored in `%LOCALAPPDATA%\GameBrowser` and survive updates and uninstalls.

The build is unsigned, so Windows SmartScreen may warn on first launch. Choose **More info**, then **Run anyway**.

## How releases are built

The [Build GameBrowser for Windows](.github/workflows/build-windows.yml) workflow compiles `GameBrowser.exe` from this source on a GitHub Windows runner, adds the browser engines from the `runtime-windows-x64` release, runs the tests and a dashboard smoke test, then produces the installer, the portable ZIP and `SHA256SUMS.txt`.

- Run it any time from the **Actions** tab (tick *Publish* to attach the files to a release), or
- bump the version in `version.ts` and `package.json`, then push a tag such as `v0.1.0-preview.5`.

The download page in `site/` is published by the [Pages workflow](.github/workflows/pages.yml).

## Build from source

Requires [Bun](https://bun.sh) 1.3 or newer.

```bash
bun install
bun test
bun build --compile --target=bun-windows-x64-baseline --define=ALIASMODE_COMPILED=true --external=playwright-core --external=chromium-bidi --external=electron StakeMode-cli.ts --outfile GameBrowser.exe
```

The dashboard lives in `workspace/` (`dashboard.html`, `dashboard.js`, `dashboard.css`), the admin/follower relay in `workspace/syncRelay.ts`, and the page-side sync extension in `extensions/stakemode-sync/`.

## License

Apache License 2.0. GameBrowser is a modified version of AliasMode / StakeMode by Xreacher. See [LICENSE](LICENSE), [NOTICE](NOTICE) and [CHANGES.md](CHANGES.md). CloakBrowser and Firefox are third-party engines under their own licenses.

Developed by Solomon Gbeta · [solomon.ng](https://solomon.ng)
