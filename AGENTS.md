# StakeMode

Build and test this Windows client in cloud environments. Publish only to the private StakeMode source branch/release. Do not change the existing AliasMode Game main branch or releases. Keep Apache-2.0 notices and record the original engine source pin.

The distribution contains no Stake1, AI providers/models/MCP, or DPN integration. Its entry point is StakeMode-cli.ts; retained upstream modules are engine reference/compatibility code and are not routes in this client.

Preserve launcher binary pins, independent storage/proxies/fingerprints, launch generation and process ownership verification. Never terminate an arbitrary or recycled PID. Resource memory settings are V8 heap limits and monitored process-tree budgets, not Windows Job Object hard caps.

Bind control services to loopback. Authenticate every control and stream session, bound payloads/queues, require exact approved same-origin navigation for synchronization, invalidate queued replay on manual override/disconnect, and resume only explicitly. Ordinary direct manual browsing can navigate to other HTTPS websites; doing so must suspend synchronization and must not enlarge its approved origins. Never mirror passwords, session tokens, 2FA, CAPTCHA, login, payments or wagering. Direct operator manual input stays on its selected profile and is never persisted or logged. Full address-bar URLs may be returned only in an authenticated direct browser-state response; snapshots, streams and logs redact queries, fragments and credentials. Do not automatically persist address history. Deliberate operator bookmark saves may retain their entered URL and are returned only by the private library API.

Deleting an account means deleting its local isolated profile and owned browser data, never a third-party website account. Require explicit typed confirmation, a stopped profile and verified absence of an owned/live process; never follow symlinks or delete arbitrary input paths. Imported extensions are trusted local code with reviewed permissions, not a sandbox guarantee. Apply extension and network changes only while stopped. System VPN mode uses the existing Windows route and does not install, control or claim to provide a VPN service.

Rendered live views must come from actual isolated browser pages. Do not substitute screenshots or pretend framed third-party pages provide isolated profiles. Synthetic DOM input is untrusted; make no undetectability claims. Report tests honestly and label unsigned preview releases accurately.
