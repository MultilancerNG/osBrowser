# Nstbrowser feature inventory and StakeMode coverage

Reviewed: **15 October 2026**. Target: **StakeMode Windows preview.2**. This is a source-backed implementation inventory, not a claim of complete Nstbrowser compatibility or feature parity.

The Nstbrowser column describes its public official documentation and product pages. Some documentation contains older kernel/version examples; those examples are not treated as the current supported-version list. StakeMode statuses describe reachable implementations in the active client, not functionality merely present in retained upstream files.

**Check the acceptance report attached to the matching release for native verification.** Implemented local features have focused parser, lifecycle, route or browser-bridge tests. The Windows packaged-browser acceptance and installed NSIS/Tauri smoke must pass for the release commit before native behavior is called verified. An implementation status is not a production certification, live-site acceptance guarantee or full Nstbrowser parity claim.

## Status meanings

| Status | Meaning |
| --- | --- |
| Implemented | Reachable local implementation with applicable local tests; native verification remains subject to exact-release evidence. |
| Partial | Only the explicitly described subset is available; the complete documented Nstbrowser feature is absent. |
| Engine only | Retained upstream code offers building blocks, but the active StakeMode UI/API does not expose the complete feature. |
| Pending | Not implemented in this client. |
| Separate service | Requires additional server, identity, storage, billing, or infrastructure implementation. |
| Excluded | Removed explicitly or outside this client's interaction policy. |

## Profiles, browser controls and organization

| Nstbrowser feature and official source | StakeMode status | Actual scope or remaining work |
| --- | --- | --- |
| Single and batch profile creation; startup pages ([create](https://docs.nstbrowser.io/guide/fingerprint-browser/create.html)) | Implemented | Independent desktop Chromium/Firefox profiles, saved startup URLs, resolution presets or exact custom desktop dimensions, bounded bulk creation. |
| Bulk profile import ([create](https://docs.nstbrowser.io/guide/fingerprint-browser/create.html)) | Implemented | Validated local configuration templates create fresh profile IDs and fingerprints. Account credentials, cookies and sessions are not imported. |
| Profile editing and copying ([settings](https://docs.nstbrowser.io/guide/fingerprint-browser/settings.html)) | Partial | Rename and resource/network editing, stopped-profile desktop screen editing, plus configuration copies with fresh identities and preserved dimensions. Copies omit account authentication and browser session data; complete session cloning is absent. |
| Group moves and tags ([batch](https://docs.nstbrowser.io/guide/fingerprint-browser/batch.html)) | Implemented | Local group/tag organization and filtering; no team authorization implied. |
| Remarks/notes ([batch](https://docs.nstbrowser.io/guide/fingerprint-browser/batch.html)) | Implemented | Deliberately saved local operator metadata; excluded from captured browser interaction. |
| Profile export ([batch](https://docs.nstbrowser.io/guide/fingerprint-browser/batch.html)) | Implemented | Configuration/metadata-only JSON export. Exact allowlists omit IDs, fingerprints, account/proxy credentials, tokens, extensions and browser sessions. |
| Delete profiles ([settings](https://docs.nstbrowser.io/guide/fingerprint-browser/settings.html)) | Implemented | Confirmed stopped-profile local deletion with launch guards, fresh ownership/directory checks and metadata/relay cleanup. Website accounts are not deleted. |
| Historical profile recovery ([settings](https://docs.nstbrowser.io/guide/fingerprint-browser/settings.html)) | Pending | No versioned profile-history service or recovery UI. Upstream trash helpers are not a history product. |
| Browser startup progress ([start](https://docs.nstbrowser.io/guide/fingerprint-browser/start.html)) | Implemented | Starting/running/manual/stopping/error states and verified native process identity. |
| Kernel/client updates ([kernel](https://docs.nstbrowser.io/guide/fingerprint-browser/kernel.html)) | Partial | StakeMode packages pinned, verified engines. Installer updates are manual; arbitrary kernel downgrade/download selection is pending. |
| Multi-window operation ([multi-account](https://www.nstbrowser.io/en/solution/multi-account)) | Implemented | Isolated live streams/task manager, per-profile address bars, up to 24 tabs, navigation controls and full administrator view. Arbitrary manual HTTPS browsing does not enlarge synchronization permissions. |
| Desktop display independent of viewer size | Implemented, StakeMode addition | Saved integer dimensions (width 1,024–4,096; height 640–2,160), desktop identities and exact per-tab viewports. A mobile dashboard scales live images without switching profiles to phone emulation. Websites still choose their own responsive layout. |
| OS/UA, language/timezone, location, DNT and rendering fingerprints ([settings](https://docs.nstbrowser.io/guide/fingerprint-browser/settings.html)) | Partial / engine only | Stored identities and pinned engine fingerprint controls remain. The complete Nstbrowser fingerprint-settings UI is not replicated. Unsupported settings must not silently alter an identity. |

## Batch operations and group defaults

| Nstbrowser feature and official source | StakeMode status | Actual scope or remaining work |
| --- | --- | --- |
| Batch start and stop ([batch](https://docs.nstbrowser.io/guide/fingerprint-browser/batch.html)) | Implemented | Up to 32 selected profiles per batch through the ownership-aware launcher; at most four concurrent launches. |
| Batch copy, proxy/tag/note changes, export and delete ([batch](https://docs.nstbrowser.io/guide/fingerprint-browser/batch.html)) | Partial | Local configuration copies, network/metadata changes, selected configuration export and confirmed deletion. Full session cloning and batch cache/cookie workflows are absent. |
| Group create/rename/delete and ordering ([groups](https://docs.nstbrowser.io/guide/advanced/group.html)) | Partial | Local create/rename/delete and profile reassignment preserve unrelated metadata. Custom ordering and team/group access rules are absent. |
| Group startup URLs and bookmarks ([groups](https://docs.nstbrowser.io/guide/advanced/group.html)) | Partial | Saved per-profile bookmarks and startup pages are implemented. Group-policy inheritance is absent. |
| Group extension assignments ([groups](https://docs.nstbrowser.io/guide/advanced/group.html)) | Pending / engine only | Per-profile assignments are implemented. An upstream Chromium group helper does not constitute cross-engine group assignment management. |
| Saved tabs, secure DNS, interface language and image-loading policies ([groups](https://docs.nstbrowser.io/guide/advanced/group.html)) | Pending / engine only | No complete workspace UI for these group defaults. Browser tab controls do not imply persistent session-tab restore. |
| Group cloud cookies/storage and shared account vault ([groups](https://docs.nstbrowser.io/guide/advanced/group.html)) | Separate service | No cloud session replication or team credential vault is enabled. |

## Network and proxies

| Nstbrowser feature and official source | StakeMode status | Actual scope or remaining work |
| --- | --- | --- |
| HTTP, HTTPS and SOCKS5 custom proxies ([proxy](https://docs.nstbrowser.io/guide/advanced/proxy.html)) | Implemented | Independent saved endpoints; authenticated proxy relay and fail-closed configured-proxy behavior. |
| Saved proxy lists/groups, aliases and reuse ([proxy](https://docs.nstbrowser.io/guide/advanced/proxy.html)) | Implemented | Local saved proxy registry, alias/group labels, bounded atomic text import, editing/removal and stopped-profile assignment. Responses redact authentication; deletion leaves previously assigned profile copies intact. |
| Proxy detection and IP inspection ([create](https://docs.nstbrowser.io/guide/fingerprint-browser/create.html)) | Engine only | Retained proxy-check modules are building blocks; they need authenticated workspace routes/UI and evidence before being presented as available. |
| Built-in residential, IPv6, datacenter and ISP inventory; geographic selection and billing ([proxy](https://docs.nstbrowser.io/guide/advanced/proxy.html)) | Separate service | StakeMode does not provide a paid proxy network, traffic balance or provider inventory. |
| Random proxy selection/pool rotation ([create](https://docs.nstbrowser.io/guide/fingerprint-browser/create.html)) | Pending | No automatic launch-time identity/route rotation. Explicit network changes require a stopped profile. |
| Direct and operating-system network selection | Implemented, StakeMode addition | Direct bypasses browser proxy settings; system mode follows OS settings. An OS VPN can still route both. This is not a per-profile VPN tunnel controller. |
| Deeper Network DPN integration | Excluded, prior user instruction | DPN features remain removed. Ordinary use of an already configured OS VPN does not reintroduce DPN controls. |

## Extensions and browser data

| Nstbrowser feature and official source | StakeMode status | Actual scope or remaining work |
| --- | --- | --- |
| Extension upload and library ([extensions](https://docs.nstbrowser.io/guide/advanced/extension.html)) | Implemented | Bounded local Chromium extension folders and Firefox XPI imports; manifest review, immutable hashes and engine checks. |
| Google Web Store URL import/update ([extensions](https://docs.nstbrowser.io/guide/advanced/extension.html)) | Engine only | Retained upstream downloader is not an exposed preview.2 service. No store-catalog/update parity claim. |
| Extension assignment and removal ([extensions](https://docs.nstbrowser.io/guide/advanced/extension.html)) | Implemented | Reviewed profile-scoped assignment changes while stopped; engine mismatch and identity collisions are rejected. |
| Selected website access | Implemented, StakeMode addition | Narrows declared host/content-script patterns where possible. Global extension permissions remain global; this is not a security sandbox. |
| Extension popup/options interfaces | Implemented, StakeMode addition | Trusted backend opens only assigned, manifest-validated entry points with exact Chromium IDs or persistent per-profile Firefox UUID mappings and checks the actual installed native document (plus HTTP status when available). The Firefox runtime uses the recorded downstream actor compatibility patch; it does not replace package HTML with a local mock. Arbitrary privileged-scheme navigation remains blocked. |
| Import/export/clear cookies and local cache ([settings](https://docs.nstbrowser.io/guide/fingerprint-browser/settings.html)) | Partial | Explicit authenticated live-profile site-cookie JSON import/export/clear is implemented; values are omitted from snapshots/WS/logs. Cookie mutation decouples synchronization. General cache management and batch cookie tools are absent. |
| Environment launch/proxy logs ([settings](https://docs.nstbrowser.io/guide/fingerprint-browser/settings.html)) | Partial | Local sanitized lifecycle diagnostics exist. A complete searchable per-profile log/history interface is pending. |

Firefox's local add-ons are loaded as extracted temporary add-ons on each launch using the pinned patched engine. This differs from installing a signed XPI permanently into standard Firefox. Chromium extensions use persistent profiles and managed unpacked copies. A library entry alone is not proof of successful native activation.

## Teams, security and cloud infrastructure

| Nstbrowser feature and official source | StakeMode status | Actual scope or remaining work |
| --- | --- | --- |
| Teams, invitations and member lifecycle ([teams](https://docs.nstbrowser.io/guide/advanced/team.html)) | Separate service | StakeMode is a local owner-operated workspace, not a hosted multi-user service. |
| Custom roles and function/group permissions ([teams](https://docs.nstbrowser.io/guide/advanced/team.html)) | Separate service | Sync admin/follower/manual roles are operation modes, not user authentication/RBAC. |
| Transfer/share profiles between teams ([settings](https://docs.nstbrowser.io/guide/fingerprint-browser/settings.html)) | Separate service | Local metadata export is not cloud account/session sharing. |
| Team credential vault, account import/export ([groups](https://docs.nstbrowser.io/guide/advanced/group.html)) | Separate service | No shared password storage, vault extension or credential distribution is active. |
| Website restrictions for team members ([official site](https://www.nstbrowser.io/en/)) | Separate service | Sync origin restrictions constrain replay, not every manual website a locally authorized operator may visit. |
| Cloud browser clusters, dedicated deployment and Docker self-hosting ([cloud](https://www.nstbrowser.io/en/solution/fingerprint-browser)) | Separate service | No remote cluster, browser fleet scheduler, tenant storage, load balancer or container distribution is provided by this Windows release. |
| Cloud storage, historical backups and subscription/billing ([teams](https://docs.nstbrowser.io/guide/advanced/team.html), [groups](https://docs.nstbrowser.io/guide/advanced/group.html)) | Separate service | Requires independent backend implementation and operational ownership. |

## Automation, developer integrations and services

| Nstbrowser feature and official source | StakeMode status | Actual scope or remaining work |
| --- | --- | --- |
| Browser/profile API and Node/Python SDKs ([Node SDK](https://docs.nstbrowser.io/guide/sdk/node.html), [Python SDK](https://docs.nstbrowser.io/guide/sdk/python.html)) | Partial | Authenticated loopback workspace REST API with local TypeScript/Node and Python clients, bounded requests and explicit token renewal. This is not an Nstbrowser API v2-compatible SDK or remote browser API. |
| Puppeteer/Playwright/CDP and Selenium integration ([Node SDK](https://docs.nstbrowser.io/guide/sdk/node.html)) | Partial / engine only | Internal Chromium CDP and patched-Firefox Playwright transports support this client. No public raw-endpoint or Selenium compatibility service is promised. |
| Visual RPA editor and workflow management ([RPA](https://docs.nstbrowser.io/guide/advanced/rpa.html)) | Partial | Local JSON workflow editor/library and runner support only navigate, wait, scroll and public text/title/redacted-URL extraction. Profiles must already run independently in manual mode. No node canvas, click/type/authentication/financial automation or general RPA debugger. |
| Schedules, repetitions, headless jobs, concurrency and task outputs ([RPA](https://docs.nstbrowser.io/guide/advanced/rpa.html)) | Partial | App-open one-off/interval schedules, cancellation/status and explicit JSON/CSV output downloads. Two concurrent leases, per-profile exclusivity, 64 steps and 180 seconds per running job. No offline catch-up or remote job service. Outputs stay in memory and are not persisted. |
| Workflow JSON interchange, reusable packages, variables, conditions, loops, data processing and logs ([modules](https://docs.nstbrowser.io/guide/rpa/features.html)) | Partial | Validated read-only workflow JSON import/export and sanitized step/timing history are implemented. Imported workflows get fresh IDs. Reusable packages, variables, branching, loops and arbitrary executable nodes are absent. |
| RPA template marketplace ([marketplace](https://docs.nstbrowser.io/guide/rpa/marketplace.html)) | Separate service | One locally reviewed built-in inspection workflow is available. There is no remote marketplace catalog, publishing, downloads or general marketplace execution service. |
| AI agent, AI skills and natural-language browser execution ([AI product](https://www.nstbrowser.io/en/product/ai-agent-skills)) | Excluded, prior user instruction | AI providers, WebLLM, Laya, MCP and related routes remain removed. |
| Web unblocker, CAPTCHA/Cloudflare solving and stealth-automation services ([official site](https://www.nstbrowser.io/en/)) | Excluded by client policy | Challenges remain manual. No detection-evasion or website-acceptance guarantee. |
| Wager/payment/credential replication | Excluded by client policy | Sensitive interactions remain independently controlled on their selected profile. |

## StakeMode-specific implementation boundaries

The authenticated loopback relay supports safe click/text/scroll events, ordered delivery and acknowledgements, immediate/delayed pacing, scoped follower manual takeover, stale-event invalidation and disconnect recovery. Real browser pixels populate the live grid. Native process diagnostics and ownership-aware stop/force-close are separate from the JavaScript heap limit and monitored RAM budget.

Limits currently defined by the workspace are 256 profiles, four concurrent launches and twelve visible streams. These are application limits, not promises that every Windows machine can run that many active browsers. Passing local fixture tests does not establish native Windows behavior for a new source commit, successful live-site login, real wagering, arbitrary extension compatibility or Nstbrowser parity. Consult that release's acceptance JSON and installed-window evidence.

## Safe reuse of retained upstream modules

| Module | Suitable local building block | Required boundary |
| --- | --- | --- |
| `store.ts`, `types.ts` | Names, groups, tags and extension registry primitives | Do not serialize account passwords, 2FA or raw launch connection data into organization views. |
| `create.ts`, `firefox-config.ts`, `launcher.ts` | Fresh identities, fingerprint consistency and controlled lifecycle | Preserve binary pins, persona checks, generation locks and exact process ownership. |
| `proxy.ts`, `proxy-relay.ts`, `proxy-check.ts` | Proxy validation, authenticated transport and optional diagnostics | No direct-network fallback after configured-proxy failure; no implicit paid-service integration. |
| `extensions.ts`, `unzip.ts` | Existing store/archive handling reference | Use bounded archive validation, immutable managed sources and explicit engine compatibility. |
| `portable-profile.ts`, `session.ts`, `import-formats.ts` | Existing schemas and parsers | Full portable profiles can contain credentials and sessions. Do not reuse full serializers for metadata-only export. |
| `scripts.ts`, retained cloud/reference modules | Architectural reference only | Their presence does not activate scripts, AI, MCP, team services or cloud routes in StakeMode. |

Before publishing preview.2, bind this inventory to the exact tested release source and retain the native acceptance reports. Keep pending services visible in this matrix rather than representing absent functionality with inactive product controls.
