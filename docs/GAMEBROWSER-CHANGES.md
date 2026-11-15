GameBrowser 0.1.0-preview.5 (portable, unsigned preview)
=========================================================

Start
-----
1. Close StakeMode first. Both apps use local port 8080, so only one can run at a time.
2. Double-click GameBrowser.exe (or "Start GameBrowser.cmd").
   A console window opens and the dashboard opens in your default browser at
   http://127.0.0.1:8080/workspace/dashboard.html
3. Keep the console window open while you work. Close it (or press Ctrl+C) to stop
   GameBrowser and every profile it started.

Profiles and settings are stored in %LOCALAPPDATA%\GameBrowser (separate from StakeMode).
Keep the folders runtime, cloakbrowser and firefox next to GameBrowser.exe.

What changed from StakeMode preview.2
-------------------------------------
- Renamed to GameBrowser.
- Mass delete: Profiles view > select profiles (or "Select all") > action
  "Delete profiles (stopped only)" > type the confirmation phrase.
- Auto-follow admin (toolbar toggle and Relay settings, on by default): choosing an admin
  turns every other running profile into its follower. "Make all followers" does it on demand.
- Followers stay attached: a missed click, a slow page, a reload or a short disconnect no
  longer drops a follower to manual; it rejoins automatically. Followers also move to the
  admin's stake.com page. The dashboard can be refreshed or closed for up to 90 seconds
  without detaching anyone.
- https://stake.com is the pinned main site: always approved, and the default startup site.
- Automatic RAM budget and Chromium JS heap (default): sized from this PC's memory and the number of running
  profiles; sync pauses only if a profile is above its share AND the PC is low on memory.
  Pick a fixed size in Create profiles if you prefer.
- Readiness badge on every tile and table row: Stopped, Starting browser, Sync connecting,
  Not on stake.com, Rejoining admin, Sync paused, Over memory budget, Ready,
  Following admin, Leading.
- Admin tile has an orange border and an ADMIN tag; followers have a blue left edge.
- View mode (native app): Create profiles > View mode, or Profile settings > View mode.
  Phone/tablet viewport with touch input (iPhone 15, iPhone SE, Pixel 8, Galaxy S23,
  iPad mini, or custom 320-1024 x 480-2160). Chromium profiles only; stop the profile
  to change it.

New in 0.1.0-preview.5
----------------------
- One admin per group: put profiles in groups (Profiles > Manage groups), pick the group in
  the Following bar, then its admin. Each group follows only its own admin; two groups can
  run side by side. Moving an admin into a group that already has one makes it manual.
- Real browser windows: Create profiles or Profile settings > Window mode > "Real browser
  window". The profile opens as a normal resizable Chrome window with every browser feature
  (right-click, zoom, find, downloads, devtools). "Show window" brings it to the front.
- Admin controls the layout: when the admin's window or viewport is resized, every follower
  in its group is resized to the same page size. Full view has a Viewport bar to set it.
- Tabs and popups follow: a new tab or popup the admin opens on stake.com opens on its
  followers too, and closing or switching tabs is copied.
- Menus and modals follow: hover menus and Escape (close) are mirrored, and far fewer
  ordinary stake.com buttons are wrongly treated as sensitive.
- Browser dialogs: alert/confirm/prompt boxes appear in Full view to answer (or natively in
  a real window). The admin's answer is applied to the same box on its followers.
- Full view works like a browser: drag and text selection, double-click, right-click,
  keyboard shortcuts (Ctrl+C/A/Z, F5...), Ctrl+wheel zoom, zoom buttons, Find on page,
  file uploads (up to 700 KB; real windows have no limit) and downloads saved to
  Downloads\GameBrowser\<profile>.
- The admin keeps leading while it opens, switches or closes tabs.

Earlier in preview.4
--------------------
- New layout: stats bar (profiles, running, CPU, RAM), a Following bar, and grid/list
  switch. Admin tile has a purple border, followers teal.
- Full Admin View: browser frame with "Admin · N followers connected" and a Followers strip
  at the bottom; click a follower to open it.
- Sounds: a short tick for every admin click that is mirrored, and an alert tone when a
  follower disconnects from the admin. The bell button in the Following bar turns them off.
- Following bar buttons: Save session (each profile reopens on its current stake.com page
  next start), Resume (unpause and rejoin all followers), Stop following (pause all
  followers), Reload all (reload the page in every running profile), Make all followers.
- Error advice: errors show a "How to fix" line, and a profile that is stuck or failing
  shows a yellow box explaining what to do.

Unchanged on purpose
--------------------
Login, passwords, 2FA, CAPTCHA, deposits, withdrawals and bets are never mirrored.
A follower that reaches one of those pages or controls switches to manual and does not
auto-rejoin; return it to sync yourself.
