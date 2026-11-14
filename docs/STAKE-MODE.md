# StakeMode 0.1.0-preview.2

StakeMode is a separate Windows browser workspace. It removes Stake1, AI models and providers, MCP and DPN integrations. It keeps independent profile storage, per-profile proxies, two browser engines, and owned process cleanup.

## Start

1. Install `StakeMode_0.1.0-preview.2_x64-setup.exe` from the private project release page.
2. Open StakeMode and create profiles, selecting Chromium or Firefox, a desktop screen preset or custom resolution, a network route and a memory budget. A proxy endpoint is required only for Proxy mode.
3. Open the local workspace. Launch a profile and use its tile to inspect its session and send manual input.
4. For supported non-sensitive synchronized interaction, designate a controller and followers and approve their common website.
5. Switch any profile into manual mode for independent operation; pause or stop synchronization at any time.

Only local loopback services are required. Existing AliasMode profiles are not implicitly imported. StakeMode stores its own Windows data under the application identity `com.solomongs.stakemode` and does not overwrite AliasMode's installation or state.

## Browse a profile

Choose **Full view** on a profile to expand its actual live browser surface. **Full Admin View** opens the current running controller. The address bar, Back, Forward, Reload, Stop loading and tab strip operate only that selected isolated browser. Use **+** for a new tab, select a tab to switch, and its **×** to close it. A profile supports up to 24 tabs. Closing the final tab leaves a fresh blank tab available. **Fullscreen** expands the workspace; **Return to grid** restores the multi-profile view.

The address bar accepts HTTPS websites and HTTP loopback pages. Credentials embedded in an address are rejected. A follower first requires **Switch to manual**. Direct navigation and tab actions switch the selected profile to manual and discard its queued synchronization work. Returning to a previously approved website does not resume synchronization; choose its role explicitly. These controls do not widen the workspace’s synchronization origin allowlist.

Full addresses, including queries and fragments, are available only through authenticated direct browser-state requests. Broadcast status and frame metadata redact these values. The live webpage itself remains visible to the operator.

## Desktop screens and custom sizes

Profiles use desktop browser identities and keep their saved desktop viewport. In **Create profiles**, select a resolution preset or **Custom**, then enter whole-pixel dimensions: width 1,024–4,096 and height 640–2,160. Multiple selected resolutions rotate through a batch; custom dimensions can be included in that selection.

To change an existing profile, stop it, open **Profile settings**, choose its desktop preset or custom width and height, and save. Running profiles and profiles with a lifecycle operation in progress reject screen edits. The new dimensions apply on the next launch and carry into new tabs and verified add-on popup/options pages. Screen changes preserve the profile’s remaining identity and account data. Configuration copies and templates retain the selected dimensions while creating fresh identities.

The desktop application, grid, full browser view and mobile dashboard scale the live image to the available viewer space. Resizing that viewer does not resize its isolated browser or enable mobile user-agent emulation. Websites retain control over their own responsive layouts; selecting a desktop viewport does not override a website’s layout rules.

## Network settings

Stop a profile and open **Profile settings** before changing its network mode. Saving a new mode affects its next launch. The saved endpoint remains available when switching away from Proxy mode; replace it explicitly to change it.

| Mode | Browser behavior | VPN behavior |
| --- | --- | --- |
| Direct | Chromium receives `--no-proxy-server`; Firefox uses direct connection preferences. The saved profile proxy is ignored. | Existing Windows VPN routes still apply. |
| System | Chromium receives no application proxy override; Firefox uses system proxy preferences. | Uses the existing Windows route, including a connected OS VPN. |
| Proxy | Uses the profile’s saved HTTP or SOCKS endpoint and optional credentials through its isolated local proxy relay. | Does not create or control a VPN tunnel. |

System mode is not a built-in VPN provider, and it does not isolate VPN routes between profiles. OS settings and the remote proxy determine connectivity. Network badges show configuration, not a verified external IP or anonymity guarantee.

Use **Proxies** to save an endpoint with an alias and optional library group, or **Import endpoint list** for one HTTP or SOCKS URL per line. The list is validated before anything is saved. Assigning a saved endpoint copies it into selected stopped profiles and switches them to Proxy mode. Listing the library shows routing metadata and an authentication indicator without returning stored credentials. Removing a library entry leaves existing profile endpoints unchanged. Keep the local application data private.

## Local extensions and Firefox add-ons

Open **Extensions**, choose **Import package**, select the engine and enter an existing local package path. Chromium accepts an unpacked Manifest V3 directory. Firefox accepts a local `.xpi` archive using Manifest V2 or V3 with a Gecko add-on ID; Firefox packages with a background section require compatible background scripts. Automatic Chrome Web Store or Mozilla Add-ons installation is not provided. Package signatures are not verified by this importer.

An import is copied into an immutable local library and remains inactive. Choose **Review & assign**, inspect its SHA-256 digest, permissions and warnings, then select a compatible stopped profile. Confirm the review and choose either its requested websites or selected website origins. Enabling an assignment takes effect on the next profile launch. Disable or remove an assignment while stopped and restart to remove its runtime effects. An imported library package cannot be deleted while profiles still reference it. When an enabled package declares a popup or options page, its profile controls can open that verified package page inside the selected browser; arbitrary extension addresses are not accepted by the normal address bar.

The packaged Firefox runtime includes the audited `stakemode-firefox-extension-ui-v1` JavaScript actor compatibility patch so assigned popup/options pages can use the live browser view. Its native executable remains pinned. The installer includes original/modified module sources and MPL-2.0 notices; browser provenance records the changed runtime archive hashes. See [source provenance](SOURCE-PROVENANCE.md).

Selected-site access narrows declared host permissions and content-script matches while preserving their original path restrictions. Browser extension patterns do not enforce TCP ports. Extension-wide capabilities such as storage or other non-host permissions remain active; host selection is not a code sandbox. Install only local packages you trust. Third-party extensions can read or alter pages according to their granted capabilities, and engine compatibility can vary.

The importer bounds local packages to 64 MiB per XPI, 128 MiB expanded content, 16 MiB per file and 4,096 files. The library supports up to 128 packages and each profile up to 32 assignments. Source package edits do not silently replace an imported digest; import and review a new package version explicitly.

## Organize and copy profiles

Use **Profiles** to filter by group or tag and select profiles for supported batch actions. **Save profile details** stores a profile’s group, comma-separated tags, notes and bookmarks. **Manage groups** creates or renames local groups; deleting a group clears its memberships without deleting profiles. Bookmarks are deliberate local saves and can contain full URLs, so avoid saving sensitive addresses in them.

**Create copied profile** makes a new identity from the selected profile’s configuration and organization metadata. It does not copy browser directories, cookies, logins or extension assignments. Configuration export/import similarly moves names, engines, window sizes, resource/network configuration, groups, tags, notes and bookmarks. Import creates fresh profile IDs and new browser identities. Proxy endpoints can be exported; proxy credentials are omitted and must be entered separately before an authenticated proxy works. These files are configuration templates rather than session backups.

Batch operations report each profile’s result. Starting remains subject to the four-launch concurrency limit; a failure on one selected profile is shown for that profile. Review partial results before repeating an operation.

## Private cookie tools

With a profile open in manual or administrator control, open **Profile settings** and select an exact website origin in the cookie tools. Export downloads that selected profile’s matching cookies as JSON. Import accepts a bounded cookie JSON array for that origin. Clear requires explicit confirmation and clears that origin’s cookies; it does not clear the whole browser cache or other profiles’ cookie jars.

Cookie values travel only through authenticated direct requests and are absent from broadcast workspace state. Exported cookie files can grant access to a session; keep them private and import only cookies you are authorized to use. The importer rejects unrelated domains, and follower profiles must first switch to manual control. These tools do not synchronize credentials or website accounts.

## Local read-only workflows and schedules

The workflow library stores ordered JSON steps for navigating to a query-free HTTPS or loopback URL, waiting, scrolling and extracting one visible public text element, the page title or a redacted URL. It does not provide click, typing, login, credential, payment or wagering nodes. The reviewed **Inspect current page** template reads a title and redacted address; it is a local example rather than a cloud marketplace.

Start a profile and explicitly switch it to manual control before running or scheduling a workflow. Administrator and follower synchronization roles cannot run workflow steps. Each job has a three-minute limit, up to 64 steps, waits of at most 30 seconds and bounded scroll distances. At most two jobs run globally, with one active job per profile. Cancel stops later steps and makes incomplete output unavailable.

Completed output is available only in the current application session through explicit JSON or CSV downloads. Output values are not written into the saved workflow library. Review extracted content before downloading it. Workflows reject sensitive pages and control elements; they are designed for reading public page content.

One-off and repeating schedules operate only while StakeMode remains open and the target profile is already running in manual control within its resource budget. They do not launch a browser or run a Windows background service. Repeating intervals start at one minute. After an application restart, missed one-off schedules are disabled and intervals restart from the new session; offline work is not replayed.

| Capability | This local edition |
| --- | --- |
| Profiles, live views, tabs, organization, configuration templates | Available locally, with the limits described above. |
| Local extensions, cookie tools, read-only workflows and app-open schedules | Available through explicit operator controls. |
| System VPN | Uses an existing Windows route; no VPN provider or per-profile tunnel service. |
| Cloud profile/session synchronization and team roles | Not implemented. |
| Hosted task execution, extension marketplace or remote workflow marketplace | Not implemented. |
| General click/typing RPA or financial automation | Not implemented. |

## Delete a local profile

Stop the browser and wait for its lifecycle operation to finish. Open **Profile settings**, choose **Delete local profile**, and type the exact profile ID shown in the confirmation dialog. Incorrect confirmation or a live browser prevents deletion. The application verifies process ownership and absence before removing the validated local directory, cookies, storage, browser settings, profile metadata and assignments. Other profiles remain available.

Deletion is permanent for local profile data. It does not delete or close an account at any website. Manage a website account directly through that website.

## Control policy

Synchronization follows a controller's approved website and supported safe interactions. A follower must have the expected origin and a valid active connection before an event can be delivered. Authentication, login forms, password and 2FA fields, anti-bot challenges, wagers and financial operations remain individual manual actions. The application does not solve or bypass verification challenges.

Immediate pacing sends eligible packets promptly. Delayed pacing adds bounded delay to eligible actions and maintains per-profile order; changing pacing is an operator scheduling control. DOM-dispatched events remain synthetic and websites can reject them. There is no guarantee of invisibility or acceptance by a third-party site.

Manual override decouples the selected follower without changing the state of the rest of the workspace. Disconnects and disallowed navigation suspend synchronization, discard stale work and show status rather than silently replaying a queue later. A new connection requires fresh authorization.

## Task manager and resources

The task table shows profile name, process identity, lifecycle state, synchronization/manual status, memory consumption, memory budget and available CPU measurements. Stop requests first use owned-process cleanup. Force close applies only to a currently owned profile instance and its verified process tree.

The RAM budget monitors the complete owned process tree and pauses synchronization after sustained excess; it is not a Windows Job Object hard cap. Chromium has a separate V8 old-space heap limit. Firefox does not receive V8 flags. GPU, network, cache and other native allocations can exceed a JavaScript heap setting. CPU and memory values come from native process samples; unavailable samples are shown as unknown rather than zero.

The first profile launch waits for Windows process inspection to become available. If inspection cannot be confirmed, StakeMode leaves the profile unlaunched and shows an error so the operator can retry explicitly. Background measurements yield to ownership checks needed for stop and deletion.

In-browser tiles are real browser view streams served through the authenticated local workspace; the website is not embedded in a cross-origin iframe. Individual manual browser inputs are operator commands. Headless viewing may differ from headed browser behavior on sites requiring hardware or interactive verification. Use manual control where a website requires it.

## Local integrations

[The local API guide](STAKE-MODE-API.md) includes TypeScript and Python clients for StakeMode’s authenticated REST management interface at `http://127.0.0.1:8080`. They connect explicitly, keep dashboard tokens in memory and do not expose browser transport credentials. These are StakeMode clients rather than an NSTbrowser SDK, a CDP compatibility layer or a remote browser service.

## Build evidence and updates

The release workflow validates source tests and type checking, checks pinned engine provenance, tests the native lifecycle and packaged browser workspace, and builds the Tauri x64 NSIS installer. A focused Firefox add-on gate first verifies actual popup/options documents, rendered pixels, live frames, manual text/click input and cleanup; its report is included in the combined acceptance report. The full native suite uses only local fixture pages to check isolated Chromium and Firefox sessions, saved desktop and custom viewports, mobile-viewer size isolation, navigation and tabs, full administrator browser controls, host-scoped add-on activation and restart removal, stopped-profile deletion, configuration-template isolation, private cookie tools, read-only workflow output/cancellation/app-open scheduling, configured network modes, authenticated proxy routing, live views, resources and owned cleanup. Read the report for the checks that actually ran and their result. Download `STAKEMODE-ACCEPTANCE.json`, `BROWSER-PROVENANCE.json`, `BUILD-PROVENANCE.txt` and `SHA256SUMS.txt` alongside the installer to inspect the exact verified build.

This is an unsigned developer preview. Updates are manual: download the next StakeMode installer from the project release page, close StakeMode, and install over the existing version. The former AliasMode automatic update service is disabled. A browser acceptance pass does not imply that live account login or live wagers have been tested. The compiled-sidecar test checks the packaged local service and shutdown protocol. A separate installed-desktop smoke silently installs the exact NSIS build on a fresh Windows runner, verifies an actual native window and its rendered WebView2 workspace, closes the window and verifies its owned service exits, then uninstalls. It also checks that installation refuses harmless same-name process sentinels without killing them. Browser and installed-app checks produce independent evidence from the same prepared runtime. The release gate requires both to pass for the exact source commit before merging their checks into `STAKEMODE-ACCEPTANCE.json`. Failed workflow runs retain `STAKEMODE-INSTALLED-ACCEPTANCE.json` separately for inspection. Inspect the combined report’s `installedDesktop` result; a source-browser pass alone is not an installed-GUI pass. This release remains an unsigned developer preview rather than a production certification.

Application license: Apache-2.0. The patched AliasMode Firefox engine retains MPL-2.0 and its original source provenance. Downstream customization: Solomon Gbeta.
