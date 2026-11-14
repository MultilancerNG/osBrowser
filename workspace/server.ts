import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { Launcher } from "../launcher.ts";
import type { ProfileStore } from "../store.ts";
import type { Profile } from "../types.ts";
import { assertSafeProfileId } from "../profile-id.ts";
import { BrowserBridge } from "./browserBridge.ts";
import { ProcessManager, type BulkProfileInput, type WorkspaceProfileView } from "./processManager.ts";
import { SyncRelay, type RelayTransport } from "./syncRelay.ts";
import { approvedOrigin, browserCommand, browsingUrl, boundedJson, isLoopback, MAX_PACKET_BYTES, MAX_VISIBLE_PROFILES, safeManualControl, sameToken, sessionToken, trustedLocalRequest, WORKSPACE_PORT, type LiveFrame, type ManualControl, type SyncRole } from "./protocol.ts";
import { generateSyncExtension, removeSyncExtension } from "../extensions/stakemode-sync/syncExtension.ts";
import { ExtensionManager, type PreparedExtensionLaunch } from "./extensionManager.ts";
import { ProfileLibrary } from "./profileLibrary.ts";
import { ManagementRoutes } from "./managementRoutes.ts";
import { WorkspaceWorkflowEngine } from "./workflowEngine.ts";
import { WorkflowRoutes } from "./workflowRoutes.ts";
import { ProxyLibrary } from "./proxyLibrary.ts";
import { handleProxyRoute } from "./proxyRoutes.ts";
import { windowsProcessScheduler } from "./windowsProcessScheduler.ts";

/** The main site stays approved for synchronization whatever is saved in settings. */
export const MAIN_SITE_ORIGIN = "https://stake.com";
/** How long followers stay attached after the last dashboard window disconnects. */
export const DASHBOARD_GRACE_MS = 90_000;
/** Followers never auto-navigate onto login, verification or cashier paths. */
const SENSITIVE_PATH = /(?:^|\/)(?:login|sign[-_]?in|sign[-_]?up|register|auth|oauth|verify|verification|2fa|mfa|captcha|challenge|deposit|withdraw(?:al)?|payout|payment|checkout|wallet|cashier)(?:\/|$)/i;

interface SocketState {
  client?: "dashboard" | "profile";
  profileId?: string;
  transport?: RelayTransport;
  subscribed: Set<string>;
  focused?: string;
  authenticationTimer?: ReturnType<typeof setTimeout>;
  windowAt: number;
  windowPackets: number;
}
export interface StakeModeWorkspaceOptions {
  launcher: Launcher;
  store: ProfileStore;
  stateRoot: string;
  assets?: Record<string, { body: string; contentType: string }>;
  extraFetch?: (request: Request, remoteAddress: string) => Response | undefined | Promise<Response | undefined>;
  /** Tests may inject an ownership-compatible manager and browser transport. */
  manager?: ProcessManager;
  onProfileDeleted?: (profileId: string) => Promise<void> | void;
  bridgeFactory?: (options: ConstructorParameters<typeof BrowserBridge>[0]) => BrowserBridge;
  /** Tests shorten the dashboard reconnect grace period. */
  dashboardGraceMs?: number;
}
/** One line the operator can act on: is this profile ready to lead or follow? */
export function profileReadiness(profile: WorkspaceProfileView, status?: { role: string; connected: boolean; origin: string; paused: boolean; rejoining?: boolean }): { level: "ready" | "waiting" | "blocked"; label: string } {
  if (profile.state === "error") return { level: "blocked", label: profile.lastError ? "Error" : "Launch error" };
  if (profile.state === "stopped") return { level: "blocked", label: "Stopped" };
  if (profile.state === "starting") return { level: "waiting", label: "Starting browser" };
  if (profile.state === "stopping") return { level: "waiting", label: "Stopping" };
  if (profile.overBudget) return { level: "blocked", label: "Over memory budget" };
  if (!status?.connected) return { level: "waiting", label: "Sync connecting" };
  if (status.rejoining) return { level: "waiting", label: "Rejoining admin" };
  if (!status.origin) return { level: "waiting", label: "Not on stake.com" };
  if (status.paused) return { level: "waiting", label: "Sync paused" };
  if (status.role === "admin") return { level: "ready", label: "Leading" };
  if (status.role === "follower") return { level: "ready", label: "Following admin" };
  return { level: "ready", label: "Ready" };
}
export class StakeModeWorkspace {
  readonly manager: ProcessManager;
  readonly relay: SyncRelay;
  readonly bridge: BrowserBridge;
  readonly extensions: ExtensionManager;
  readonly library: ProfileLibrary;
  readonly workflows: WorkspaceWorkflowEngine;
  readonly proxies: ProxyLibrary;
  private workflowRoutes: WorkflowRoutes;
  private management: ManagementRoutes;
  private server?: Server<SocketState>;
  private sockets = new Set<ServerWebSocket<SocketState>>();
  private dashboardTokens = new Map<string, number>();
  private dashboardOrigins = new Set<string>();
  private extensionDirs = new Map<string, string>();
  private preparedExtensions = new Map<string, PreparedExtensionLaunch>();
  private unsubscribe: () => void;
  private settingsFile: string;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private shutdown = false;
  private changingManual = false;
  private cleanedProfiles = new Set<string>();
  private controlQueues = new Map<string, { count: number; chain: Promise<void> }>();
  private dashboardGrace?: ReturnType<typeof setTimeout>;
  private followTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private options: StakeModeWorkspaceOptions) {
    mkdirSync(join(options.stateRoot, "workspace"), { recursive: true, mode: 0o700 });
    this.settingsFile = join(options.stateRoot, "workspace", "settings.json");
    this.relay = new SyncRelay({ pinnedOrigins: [MAIN_SITE_ORIGIN], onAdminPage: (_admin, page) => this.followAdminPage(page),
      onSync: id => { if (!this.changingManual && this.manager?.getProfile(id)?.manual) { this.changingManual = true; try { this.manager.setManual(id, false); } finally { this.changingManual = false; } } },
      onAdminAction: (adminId, action, followers) => this.publishDashboard({ type: "SYNC_ACTION", profileId: adminId, action, followers, at: Date.now() }),
      onChange: () => this.publishSnapshot(), onManual: (id, reason) => {
      if (reason !== "manual_startup") console.error(`[GameBrowser] sync: ${id} switched to manual (${reason})`);
      if (reason !== "manual_startup" && !reason.startsWith("operator_")) this.publishDashboard({ type: "SYNC_LOST", profileId: id, reason: reason.slice(0, 160), at: Date.now() });
      if (!this.changingManual && this.manager?.getProfile(id)) {
        this.changingManual = true;
        try { this.manager.setManual(id, true); } finally { this.changingManual = false; }
      }
    } });
    if (existsSync(this.settingsFile)) {
      const raw = readFileSync(this.settingsFile, "utf8");
      if (raw.length > 65536) throw new Error("Workspace settings exceed their limit");
      const settings = JSON.parse(raw);
      if (settings.version !== 1 || !Array.isArray(settings.origins)) throw new Error("Workspace settings are invalid");
      this.relay.configure(settings.origins, settings.pacing);
      if (typeof settings.autoFollow === "boolean") this.relay.setAutoFollow(settings.autoFollow);
    } else this.relay.configure([MAIN_SITE_ORIGIN], "fast");
    this.manager = options.manager ?? new ProcessManager({ launcher: options.launcher, store: options.store, stateRoot: options.stateRoot,
      beforeStart: (id, profile) => this.prepareProfile(id, profile), afterDelete: id => this.cleanupProfile(id) });
    this.library = new ProfileLibrary(options.stateRoot, id => !!this.manager.getProfile(id));
    this.proxies = new ProxyLibrary(options.stateRoot);
    this.extensions = new ExtensionManager({ stateRoot: options.stateRoot,
      isProfileStopped: id => this.manager.canEditProfile(id), getProfileEngine: id => this.manager.getProfile(id)?.engine });
    this.registerProfiles(this.manager.list());
    this.bridge = (options.bridgeFactory ?? (config => new BrowserBridge(config)))({
      getLaunch: id => this.manager.getLaunch(id),
      getConfig: id => this.relay.configFor(id),
      getViewport: id => { const profile = this.manager.getProfile(id); return profile ? profile.mobileView ? { ...profile.mobileView, mobile: true } : { width: profile.screenWidth, height: profile.screenHeight } : undefined; },
      canControl: id => {
        const profile = this.manager.getProfile(id), status = this.relay.statuses().find(row => row.profileId === id);
        return !!profile && !!this.manager.getLaunch(id) && (profile.manual || status?.role === "admin");
      },
      onFrame: frame => this.publishFrame(frame),
      onError: (profileId, error) => this.publishProfilePacket(profileId, { type: "FRAME_ERROR", profileId, error }),
      onFirefoxConnect: (id, token, transport) => this.relay.authenticate(id, token, transport),
      onFirefoxPacket: (id, transport, packet) => this.relay.receive(id, transport, packet),
      onDisconnect: id => this.relay.disconnect(id),
      // The administrator keeps leading while it browses inside its approved site;
      // onNavigation below still hands it to manual if it leaves the site or opens a sensitive page.
      beforeBrowserAction: (id, command) => {
        const config = this.relay.configFor(id);
        if (config?.role === "admin" && command && (command.action === "reload" || (command.action === "navigate" && (() => {
          try { const url = new URL(String(command.url)); return config.origins.includes(url.origin) && !url.username && !url.password && !SENSITIVE_PATH.test(url.pathname); } catch { return false; }
        })()))) return;
        this.relay.manual(id, "operator_navigation");
      },
      onNavigation: (id, value) => {
        try {
          const url = new URL(value), config = this.relay.configFor(id);
          const leaving = !config?.origins.includes(url.origin) || url.username || url.password;
          if (config?.role === "admin") { if (leaving || SENSITIVE_PATH.test(url.pathname)) this.relay.manual(id, "manual_navigation"); }
          else if (leaving || url.search || url.hash) this.relay.manual(id, "manual_navigation");
        } catch { this.relay.manual(id, "manual_navigation"); }
      },
      onBrowserState: browser => this.publishProfilePacket(browser.profileId, { type: "BROWSER_STATE", browser }),
      contentScriptPath: join(process.env.STAKEMODE_SYNC_EXTENSION_ROOT ?? join(import.meta.dir, "..", "extensions", "stakemode-sync"), "content.js"),
    });
    this.management = new ManagementRoutes({ manager: this.manager, bridge: this.bridge, relay: this.relay, extensions: this.extensions, library: this.library,
      snapshot: () => this.snapshot(), changed: () => this.publishSnapshot(), openExtensionPage: (id, extensionId, kind) => this.openExtensionPage(id, extensionId, kind) });
    this.workflows = new WorkspaceWorkflowEngine({ stateRoot: options.stateRoot,
      execute: (id, step, signal) => this.bridge.executeWorkflowStep(id, step, signal),
      canRunProfile: id => {
        const profile = this.manager.getProfile(id);
        return !!profile && !!this.manager.getLaunch(id) && profile.manual === true && this.relay.configFor(id)?.role === "manual" && !profile.overBudget;
      },
      onChange: () => this.publishSnapshot() });
    this.workflowRoutes = new WorkflowRoutes(this.workflows, this.manager);
    this.unsubscribe = this.manager.onChange(profiles => {
      this.registerProfiles(profiles);
      for (const profile of profiles) {
        const status = this.relay.statuses().find(row => row.profileId === profile.id);
        if (profile.overBudget && status?.role !== "manual") this.relay.manual(profile.id, "resource_budget");
        if (profile.state === "stopped") { this.bridge?.detach(profile.id); if (status?.connected) this.relay.disconnect(profile.id); }
      }
      this.publishSnapshot();
    });
  }
  private registerProfiles(profiles: WorkspaceProfileView[]): void {
    for (const p of profiles) {
      if (this.relay.configFor(p.id)) continue;
      const origin = p.urls.length ? new URL(p.urls[0]!).origin : MAIN_SITE_ORIGIN;
      this.relay.register(p.id, this.relay.origins.includes(origin) ? origin : MAIN_SITE_ORIGIN);
    }
  }
  private async prepareProfile(id: string, _profile: Profile): Promise<void> {
    // Starting an already running profile is idempotent. Never rewrite code or
    // credentials loaded by its current browser generation.
    if (this.manager.getLaunch(id)) return;
    const dto = this.manager.getProfile(id);
    if (!dto) throw new Error("Workspace profile is missing");
    for (const url of dto.urls) browsingUrl(url);
    this.relay.register(id);
    const origin = dto.urls[0] ? new URL(dto.urls[0]).origin : MAIN_SITE_ORIGIN;
    this.relay.setOrigin(id, this.relay.origins.includes(origin) ? origin : MAIN_SITE_ORIGIN);
    // Keep a follower/admin choice across restarts; otherwise start manual.
    const intended = this.relay.statuses().find(row => row.profileId === id)?.intendedRole;
    if (intended !== "follower" && intended !== "admin") this.relay.manual(id, "manual_startup");
    const config = this.relay.configFor(id)!;
    this.extensionDirs.set(id, await generateSyncExtension({ stateRoot: this.options.stateRoot, profileId: id, config }));
    this.preparedExtensions.set(id, await this.extensions.prepareLaunch(id, dto.engine));
  }
  extensionDirectories(profile: Profile): string[] {
    if (profile.engine === "firefox") return [];
    const directory = this.extensionDirs.get(profile.id);
    return [...directory ? [directory] : [], ...this.preparedExtensions.get(profile.id)?.chromiumDirectories ?? []];
  }
  firefoxAddonDirectories(profile: Profile): string[] { return this.preparedExtensions.get(profile.id)?.firefoxDirectories ?? []; }
  firefoxAddonUUIDs(profile: Profile): Record<string, string> { return { ...this.preparedExtensions.get(profile.id)?.firefoxAddonUUIDs ?? {} }; }
  private async openExtensionPage(id: string, extensionId: string, kind: "popup" | "options"): Promise<object> {
    if (!this.canControl(id)) throw new Error("Start the profile and switch it to manual control before opening an add-on");
    const entry = this.preparedExtensions.get(id)?.entries.find(row => row.id === extensionId);
    const assignment = this.extensions.listAssignments(id).find(row => row.extensionId === extensionId && row.enabled);
    if (!entry?.browserOrigin || !assignment || !entry.ui[kind]) throw new Error("The enabled add-on does not provide this page in the current browser generation");
    return this.bridge.openExtensionPage(id, { origin: entry.browserOrigin, entrypoint: entry.ui[kind]! });
  }
  private saveSettings(): void {
    const temporary = `${this.settingsFile}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, origins: this.relay.origins, pacing: this.relay.pacing, autoFollow: this.relay.autoFollow }), { mode: 0o600 });
    renameSync(temporary, this.settingsFile);
  }
  /** Running, in budget, and not mid-lifecycle: may be forced into follower mode. */
  private syncEligible(id: string): boolean {
    const profile = this.manager.getProfile(id);
    return !!profile && !!this.manager.getLaunch(id) && !profile.overBudget && (profile.state === "running" || profile.state === "manual");
  }
  /** Keep followers on the administrator's page. Sensitive paths stay manual. */
  private followAdminPage(page: string): void {
    let url: URL;
    try { url = new URL(page); } catch { return; }
    if (SENSITIVE_PATH.test(url.pathname) || !this.relay.origins.includes(url.origin)) return;
    for (const follower of this.relay.followers()) {
      if (!follower.connected || follower.page === page) continue;
      clearTimeout(this.followTimers.get(follower.profileId));
      // Debounce so a burst of single-page-app route changes produces one navigation.
      this.followTimers.set(follower.profileId, setTimeout(() => {
        this.followTimers.delete(follower.profileId);
        void this.bridge.followNavigation?.(follower.profileId, page).catch(() => {});
      }, 400));
    }
  }
  snapshot(): object {
    const statuses = new Map(this.relay.statuses().map(row => [row.profileId, row]));
    return { profiles: this.manager.list().map(p => { const metadata = this.library.get(p.id); const status = statuses.get(p.id); return { ...p, ...(status ?? { role: "manual", paused: false, connected: false, origin: "", queued: 0 }),
      readiness: profileReadiness(p, status),
      groupId: metadata.groupId, tags: metadata.tags, notes: metadata.notes, bookmarkCount: metadata.bookmarks.length,
      syncMechanism: p.engine === "firefox" ? "Playwright page binding" : "Manifest V3 extension" }; }), groups: this.library.listGroups(),
      pacing: this.relay.pacing, origins: this.relay.origins, epoch: this.relay.epoch, autoFollow: this.relay.autoFollow, mainSite: MAIN_SITE_ORIGIN,
      limits: { maxVisible: MAX_VISIBLE_PROFILES, maxProfiles: 256, maxConcurrentLaunches: 4, screenshotFps: 2 },
      policy: { credentialsMirrored: false, financialActionsMirrored: false, actionsRequireHumanOperator: true } };
  }
  async start(): Promise<number> {
    if (this.server) return this.server.port!;
    this.shutdown = false;
    this.server = Bun.serve<SocketState>({ hostname: "127.0.0.1", port: WORKSPACE_PORT,
      maxRequestBodySize: 1048576,
      fetch: async (request, server) => {
        const address = server.requestIP(request)?.address ?? "";
        const url = new URL(request.url);
        if (url.pathname === "/relay") {
          const origin = request.headers.get("origin");
          const host = request.headers.get("host");
          const acceptedOrigin = !origin || this.dashboardOrigins.has(origin) || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
          if (!isLoopback(address) || host !== `127.0.0.1:${WORKSPACE_PORT}` || !acceptedOrigin || url.search || this.sockets.size >= 272) return json({ error: "WebSocket origin or connection is not permitted" }, 403);
          if (server.upgrade(request, { data: { subscribed: new Set(), windowAt: Date.now(), windowPackets: 0 } })) return undefined;
          return json({ error: "WebSocket upgrade required" }, 426);
        }
        return this.handleRequest(request, address);
      },
      websocket: {
        maxPayloadLength: MAX_PACKET_BYTES,
        idleTimeout: 120,
        backpressureLimit: 6 * 1024 * 1024,
        closeOnBackpressureLimit: true,
        open: socket => {
          this.sockets.add(socket);
          socket.data.authenticationTimer = setTimeout(() => socket.close(4001, "Authentication required"), 5000);
        },
        message: (socket, value) => { void this.socketMessage(socket, value).catch(() => socket.close(4002, "Invalid message")); },
        close: socket => {
          clearTimeout(socket.data.authenticationTimer);
          this.sockets.delete(socket);
          socket.data.focused = undefined; socket.data.subscribed.clear();
          if (socket.data.profileId) this.relay.disconnect(socket.data.profileId, socket.data.transport);
          if (!this.shutdown && socket.data.client === "dashboard" && ![...this.sockets].some(peer => peer.data.client === "dashboard")) {
            // A refresh, a sleeping phone or a brief socket drop must not detach every
            // follower. Pause synchronization only if no dashboard returns within the grace period.
            clearTimeout(this.dashboardGrace);
            this.dashboardGrace = setTimeout(() => {
              this.dashboardGrace = undefined;
              if (this.shutdown || [...this.sockets].some(peer => peer.data.client === "dashboard")) return;
              const active = this.relay.statuses().filter(profile => profile.connected || !!this.manager.getLaunch(profile.profileId)).map(profile => profile.profileId);
              if (active.length) this.relay.manualMany(active, "operator_disconnected");
            }, this.options.dashboardGraceMs ?? DASHBOARD_GRACE_MS);
            this.dashboardGrace.unref?.();
          }
          this.refreshVisible();
        },
      },
    });
    this.bridge.start();
    this.workflows.start();
    this.heartbeat = setInterval(() => { for (const socket of this.sockets) if (socket.data.client) this.send(socket, { type: "PING", at: Date.now() }); }, 15000);
    this.heartbeat.unref?.();
    return this.server.port!;
  }
  async handleRequest(request: Request, remoteAddress: string): Promise<Response> {
    const response = await this.dispatchRequest(request, remoteAddress);
    // Pinned Bun on Windows can stall a browser reusing an idle HTTP socket.
    // End each loopback HTTP exchange explicitly; the relay upgrades separately.
    const headers = new Headers(response.headers);
    headers.set("connection", "close");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  private async dispatchRequest(request: Request, remoteAddress: string): Promise<Response> {
    const extra = await this.options.extraFetch?.(request, remoteAddress);
    if (extra) return extra;
    const url = new URL(request.url);
    if ((url.pathname === "/" || url.pathname === "/workspace" || url.pathname === "/workspace/") && request.method === "GET") {
      if (!isLoopback(remoteAddress)) return json({ error: "Local workspace access required" }, 403);
      return this.asset("/workspace/dashboard.html");
    }
    if (["/workspace/dashboard.html", "/workspace/dashboard.css", "/workspace/dashboard.js"].includes(url.pathname) && request.method === "GET") {
      if (!isLoopback(remoteAddress)) return json({ error: "Local workspace access required" }, 403);
      return this.asset(url.pathname);
    }
    if (!url.pathname.startsWith("/workspace/api/")) return json({ error: "Route not found" }, 404);
    if (!trustedLocalRequest(request, remoteAddress)) return json({ error: "Same-origin local workspace request required" }, 403);
    if (this.shutdown) return json({ error: "Workspace is stopping" }, 503);
    if (url.pathname === "/workspace/api/bootstrap" && request.method === "GET") {
      for (const [token, expiry] of this.dashboardTokens) if (expiry < Date.now()) this.dashboardTokens.delete(token);
      if (this.dashboardTokens.size >= 32) this.dashboardTokens.delete(this.dashboardTokens.keys().next().value!);
      const token = sessionToken();
      this.dashboardTokens.set(token, Date.now() + 12 * 60 * 60 * 1000);
      this.dashboardOrigins.add(url.origin);
      return json({ token, relayUrl: `ws://127.0.0.1:${WORKSPACE_PORT}/relay`, snapshot: this.snapshot() });
    }
    if (!this.validDashboardToken(request.headers.get("authorization")?.replace(/^Bearer /, ""))) return json({ error: "Workspace authorization required" }, 401);
    if (url.pathname === "/workspace/api/snapshot" && request.method === "GET") return json({ snapshot: this.snapshot() });
    const proxy = await handleProxyRoute(request, url, { library: this.proxies, manager: this.manager,
      snapshot: () => this.snapshot(), changed: () => this.publishSnapshot() });
    if (proxy) return proxy;
    const workflow = await this.workflowRoutes.handle(request, url);
    if (workflow) return workflow;
    const management = await this.management.handle(request, url);
    if (management) return management;
    const profileRoute = /^\/workspace\/api\/profiles\/([a-zA-Z0-9_-]{1,64})(?:\/(browser|network|delete|cookies))?$/.exec(url.pathname);
    if (profileRoute) return this.profileRequest(request, profileRoute[1]!, profileRoute[2], url);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    try {
      const body = await boundedJson(request);
      const operation = url.pathname.slice("/workspace/api/".length);
      if (operation === "bulk") {
        const input = body as unknown as BulkProfileInput;
        if (input.origin) approvedOrigin(input.origin);
        for (const page of input.urls ?? []) browsingUrl(page);
        const profiles = await this.manager.bulkCreate(input);
        this.registerProfiles(profiles);
        return json({ profiles, snapshot: this.snapshot() });
      }
      if (operation === "settings") {
        if (!Array.isArray(body.origins)) throw new Error("Origins must be an array");
        this.relay.configure(body.origins, body.pacing);
        if (typeof body.autoFollow === "boolean") this.relay.setAutoFollow(body.autoFollow);
        this.saveSettings();
        return json({ snapshot: this.snapshot() });
      }
      if (operation === "reload-all") {
        const ids = this.manager.list().filter(profile => this.manager.getLaunch(profile.id)).map(profile => profile.id);
        const results = await Promise.all(ids.map(async id => {
          try { return { profileId: id, ok: await this.bridge.reloadPage(id) }; }
          catch { return { profileId: id, ok: false, error: "The page did not finish reloading within 15 seconds" }; }
        }));
        return json({ results, snapshot: this.snapshot() });
      }
      if (operation === "follow") {
        // Fleet-wide follow controls: "pause" stops following, "resume" rejoins and unpauses everyone.
        if (body.action !== "pause" && body.action !== "resume") throw new Error("Follow action must be pause or resume");
        const statuses = this.relay.statuses();
        if (body.action === "pause") { for (const row of statuses) if (row.role === "follower" && !row.paused) this.relay.setPaused(row.profileId, true); }
        else {
          for (const row of statuses) if (row.paused && this.syncEligible(row.profileId)) this.relay.setPaused(row.profileId, false);
          this.relay.rejoinAll();
          if (this.relay.autoFollow && statuses.some(row => row.role === "admin")) this.relay.forceFollowers(id => this.syncEligible(id));
        }
        this.publishSnapshot();
        return json({ snapshot: this.snapshot() });
      }
      if (operation === "save-session") {
        // Remember each running profile's current stake.com page as its next startup page.
        let saved = 0;
        for (const row of this.relay.statuses()) {
          if (!row.page || !this.manager.getLaunch(row.profileId)) continue;
          try { const url = new URL(row.page); if (!this.relay.origins.includes(url.origin) || SENSITIVE_PATH.test(url.pathname)) continue; this.manager.setPolicy(row.profileId, { urls: [url.href] }); saved++; } catch { /* skip */ }
        }
        this.publishSnapshot();
        return json({ saved, snapshot: this.snapshot() });
      }
      if (operation === "force-followers") {
        const forced = this.relay.forceFollowers(id => this.syncEligible(id));
        this.publishSnapshot();
        return json({ forced, snapshot: this.snapshot() });
      }
      if (typeof body.profileId !== "string") throw new Error("Profile ID is required");
      assertSafeProfileId(body.profileId);
      const id = body.profileId;
      if (!this.manager.getProfile(id)) return json({ error: "Profile not found" }, 404);
      if (operation === "start") { await this.manager.start(id); await this.bridge.attach(id); }
      else if (operation === "stop" || operation === "kill") {
        this.relay.manual(id, "operator_stop"); await this.bridge.detach(id);
        const stopped = operation === "kill" ? await this.manager.forceKill(id) : await this.manager.stop(id);
        if (!stopped) return json({ error: "Browser shutdown could not be confirmed", snapshot: this.snapshot() }, 409);
      } else if (operation === "manual") {
        if (typeof body.enabled !== "boolean") throw new Error("Manual mode must be boolean");
        if (body.enabled) this.relay.setRole(id, "manual");
        else { this.manager.setManual(id, false); this.relay.setRole(id, "follower"); }
      } else if (operation === "pause") {
        if (typeof body.enabled !== "boolean") throw new Error("Pause mode must be boolean");
        this.relay.setPaused(id, body.enabled);
      } else if (operation === "role") {
        if (!["admin", "follower", "manual"].includes(String(body.role))) throw new Error("Role is invalid");
        if (body.role !== "manual") this.manager.setManual(id, false);
        this.relay.setRole(id, body.role as SyncRole, { eligible: other => this.syncEligible(other) });
      } else if (operation === "navigate") {
        if (typeof body.url !== "string") throw new Error("URL is required");
        if (!this.manager.getLaunch(id)) return json({ error: "Start this browser profile first" }, 409);
        if (!this.canControl(id)) return json({ error: "Switch this profile to manual control first" }, 403);
        browsingUrl(body.url);
        await this.bridge.navigate(id, body.url);
      } else if (operation === "policy") this.manager.setPolicy(id, body as any);
      else if (operation === "view") this.manager.setMobileView(id, body.mobileView ?? null);
      else return json({ error: "Route not found" }, 404);
      this.publishSnapshot();
      return json({ profile: this.manager.getProfile(id), snapshot: this.snapshot() });
    } catch (error) {
      const message = error instanceof Error && error.message.length <= 200 ? error.message : "Workspace request failed";
      return json({ error: message }, 400);
    }
  }
  private async cleanupProfile(id: string): Promise<void> {
    assertSafeProfileId(id);
    if (this.cleanedProfiles.has(id)) return;
    this.relay.unregister(id);
    await this.bridge.forgetProfile(id);
    this.extensionDirs.delete(id); this.controlQueues.delete(id);
    for (const socket of this.sockets) {
      socket.data.subscribed.delete(id); if (socket.data.focused === id) socket.data.focused = undefined;
      if (socket.data.profileId === id) socket.close(4001, "Profile deleted");
    }
    removeSyncExtension(this.options.stateRoot, id);
    this.extensions.removeProfile(id); this.preparedExtensions.delete(id);
    this.library.removeProfile(id);
    this.workflows.removeProfile(id);
    await this.options.onProfileDeleted?.(id);
    this.cleanedProfiles.add(id);
  }
  private canControl(id: string): boolean {
    const profile = this.manager.getProfile(id), config = this.relay.configFor(id);
    return !!profile && !!this.manager.getLaunch(id) && (profile.manual || config?.role === "admin");
  }
  private async profileRequest(request: Request, id: string, operation: string | undefined, url: URL): Promise<Response> {
    if (!this.manager.getProfile(id)) return json({ error: "Profile not found" }, 404);
    try {
      if (operation === "browser" || operation === "cookies") {
        if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
        if (!this.manager.getLaunch(id)) return json({ error: "Start this browser profile first" }, 409);
        if (!this.canControl(id)) return json({ error: "Switch this profile to manual control first" }, 403);
        if (operation === "cookies") {
          if (request.method === "GET") return json(await this.bridge.cookies(id, url.searchParams.get("origin")));
          const result = await this.bridge.changeCookies(id, await boundedJson(request));
          return json({ ...result, snapshot: this.snapshot() });
        }
        if (request.method === "GET") return json({ browser: await this.bridge.browserState(id) });
        const command = browserCommand(await boundedJson(request));
        return json({ browser: await this.bridge.browserAction(id, command), snapshot: this.snapshot() });
      }
      if ((operation === undefined && request.method === "DELETE") || (operation === "delete" && request.method === "POST")) {
        const body = await boundedJson(request);
        if (body.confirmation !== id || Object.keys(body).some(key => key !== "confirmation")) return json({ error: "Type the exact profile ID to confirm deletion of its local browser data" }, 400);
        if (!this.manager.canEditProfile(id)) return json({ error: "Stop this profile and finish its lifecycle operation before deleting local data" }, 409);
        const result = await this.manager.deleteProfile(id);
        await this.cleanupProfile(id);
        this.refreshVisible(); this.publishSnapshot();
        return json({ ...result, snapshot: this.snapshot() });
      }
      if (operation === "network" && request.method === "POST") {
        if (!this.manager.canEditProfile(id)) return json({ error: "Stop this profile before changing its network route" }, 409);
        const body = await boundedJson(request);
        if (Object.keys(body).some(key => !["networkMode", "proxy"].includes(key))) throw new Error("Network request contains an unsupported field");
        const profile = this.manager.updateNetwork(id, body as any);
        this.relay.manual(id, "network_changed");
        return json({ profile, snapshot: this.snapshot() });
      }
      return json({ error: "Method not allowed" }, 405);
    } catch (error) {
      // Browser protocol failures can include full addresses and cookie contents.
      // Only our bounded validation messages are safe; runtime failures stay generic.
      const message = error instanceof Error && /^(?:Browser command|Browser action|Browser tab identifier|Choose a browser tab|Browser URL|Enter a complete HTTPS|Use HTTPS, or HTTP|This browser action|Origin is invalid|Use an exact HTTPS|Cookie action must|Cookie request contains|Cookie is invalid|Cookie contains an unsupported|Cookie name or value is invalid|Cookie domain|Cookie path is invalid|Cookie expiry is invalid|Cookie flags are invalid|SameSite=None|Secure cookie prefix|Host cookie prefix|Import at most|Network request contains|Request |network |proxy |stop the profile|This site's cookies exceed)/.test(error.message)
        ? error.message.slice(0, 200) : "Browser request could not finish; the profile remains available";
      return json({ error: message }, 400);
    }
  }
  private asset(path: string): Response {
    const asset = this.options.assets?.[path];
    if (!asset) return json({ error: "Workspace asset is unavailable" }, 503);
    return new Response(asset.body, { headers: { "content-type": asset.contentType, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:8080; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" } });
  }
  private validDashboardToken(token: unknown): boolean {
    if (typeof token !== "string") return false;
    for (const [candidate, expiry] of this.dashboardTokens) if (expiry > Date.now() && sameToken(token, candidate)) return true;
    return false;
  }
  private async socketMessage(socket: ServerWebSocket<SocketState>, value: string | Buffer): Promise<void> {
    if (Date.now() - socket.data.windowAt > 1000) { socket.data.windowAt = Date.now(); socket.data.windowPackets = 0; }
    if (++socket.data.windowPackets > 120 || Buffer.byteLength(value) > MAX_PACKET_BYTES) { socket.close(4008, "Message limit exceeded"); return; }
    let packet: Record<string, unknown>;
    try { packet = JSON.parse(value.toString()); if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new Error(); }
    catch { socket.close(4002, "Invalid message"); return; }
    if (!socket.data.client) {
      if (packet.type !== "HELLO") { socket.close(4001, "Authentication required"); return; }
      if (packet.client === "dashboard" && this.validDashboardToken(packet.token)) {
        socket.data.client = "dashboard"; clearTimeout(socket.data.authenticationTimer);
        this.send(socket, { type: "SNAPSHOT", snapshot: this.snapshot() }); return;
      }
      const transport: RelayTransport = { send: data => this.send(socket, data), close: (code, reason) => socket.close(code, reason) };
      if (this.relay.authenticate(packet.profileId, packet.token, transport)) {
        socket.data.client = "profile"; socket.data.profileId = packet.profileId as string; socket.data.transport = transport; clearTimeout(socket.data.authenticationTimer); return;
      }
      socket.close(4001, "Authentication failed"); return;
    }
    if (packet.type === "PING") { this.send(socket, { type: "PONG" }); return; }
    if (packet.type === "PONG") return;
    if (socket.data.client === "profile") {
      if (packet.type === "PAGE") this.bridge.setActivePage(socket.data.profileId!, packet.url);
      this.relay.receive(socket.data.profileId!, socket.data.transport!, packet); return;
    }
    if (packet.type === "SUBSCRIBE") {
      if (!Array.isArray(packet.profileIds) || packet.profileIds.length > MAX_VISIBLE_PROFILES || packet.profileIds.some(id => typeof id !== "string")) { socket.close(4002, "Invalid subscription"); return; }
      try { socket.data.subscribed = new Set((packet.profileIds as string[]).filter(id => this.manager.getProfile(id) && this.manager.getLaunch(id))); }
      catch { socket.close(4002, "Invalid subscription"); return; }
      this.refreshVisible(); return;
    }
    if (packet.type === "FOCUS") {
      if (packet.profileId === null) { socket.data.focused = undefined; return; }
      if (typeof packet.profileId !== "string" || !socket.data.subscribed.has(packet.profileId)) return;
      socket.data.focused = packet.profileId; return;
    }
    if (packet.type === "CONTROL") {
      try {
        const input = safeManualControl(packet);
        if (input.profileId !== socket.data.focused || !socket.data.subscribed.has(input.profileId)) throw new Error("Focus this browser tile before controlling it");
        await this.dispatchControl(socket, input);
      } catch { this.send(socket, { type: "CONTROL_ERROR", profileId: packet.profileId, error: "Control requires a focused administrator or manual browser profile" }); }
    }
  }
  private dispatchControl(socket: ServerWebSocket<SocketState>, input: ManualControl): Promise<void> {
    const queue = this.controlQueues.get(input.profileId) ?? { count: 0, chain: Promise.resolve() };
    if (queue.count >= 32) return Promise.reject(new Error("Manual control queue exceeded its limit"));
    const enqueuedAt = Date.now();
    queue.count++; this.controlQueues.set(input.profileId, queue);
    const task = queue.chain.then(async () => {
      if (this.shutdown || Date.now() - enqueuedAt > 3000 || socket.data.focused !== input.profileId || !socket.data.subscribed.has(input.profileId)) throw new Error("Manual input is stale or its tile lost focus");
      await this.bridge.control(input);
    });
    queue.chain = task.catch(() => {}).finally(() => { queue.count--; if (!queue.count && this.controlQueues.get(input.profileId) === queue) this.controlQueues.delete(input.profileId); });
    return task;
  }
  private send(socket: ServerWebSocket<SocketState>, packet: unknown): void { socket.send(JSON.stringify(packet)); }
  private refreshVisible(): void {
    const ids = new Set<string>();
    for (const socket of this.sockets) if (socket.data.client === "dashboard") for (const id of socket.data.subscribed) if (ids.size < MAX_VISIBLE_PROFILES) ids.add(id);
    this.bridge.setVisible([...ids]);
  }
  private publishFrame(frame: LiveFrame): void {
    for (const socket of this.sockets) if (socket.data.client === "dashboard" && socket.data.subscribed.has(frame.profileId)) {
      if (socket.getBufferedAmount() < 4 * 1024 * 1024) this.send(socket, frame);
    }
  }
  private publishProfilePacket(profileId: string, packet: unknown): void {
    for (const socket of this.sockets) if (socket.data.client === "dashboard" && socket.data.subscribed.has(profileId)) this.send(socket, packet);
  }
  private publishDashboard(packet: Record<string, unknown>): void {
    if (this.shutdown) return;
    for (const socket of this.sockets) if (socket.data.client === "dashboard") this.send(socket, packet);
  }
  private publishSnapshot(): void {
    if (this.snapshotTimer || this.shutdown) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      for (const socket of this.sockets) if (socket.data.client === "dashboard") this.send(socket, { type: "SNAPSHOT", snapshot: this.snapshot() });
    }, 80);
  }
  async stop(): Promise<void> {
    this.shutdown = true;
    clearTimeout(this.dashboardGrace); this.dashboardGrace = undefined;
    for (const timer of this.followTimers.values()) clearTimeout(timer);
    this.followTimers.clear();
    this.manager.beginShutdown?.();
    this.workflows.stop();
    this.unsubscribe();
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.relay.stop();
    for (const socket of this.sockets) socket.close(1001, "Workspace stopping");
    this.sockets.clear();
    // No browser exists during initial warmup. Cancel its exact owned helper
    // before waiting for starts; active-browser teardown still needs collectors.
    let helpersStopped = true;
    if (!this.manager.list().some(p => this.manager.getLaunch(p.id))) helpersStopped = await windowsProcessScheduler.drain();
    await this.bridge.stop();
    const ids = new Set([...this.manager.list().filter(p => this.manager.getLaunch(p.id)).map(p => p.id), ...(this.manager.pendingStartIds?.() ?? [])]);
    const results = await Promise.allSettled([...ids].map(id => this.manager.stop(id)));
    helpersStopped = await windowsProcessScheduler.drain() && helpersStopped;
    this.server?.stop(true); this.server = undefined;
    this.dashboardTokens.clear();
    if (results.some(result => result.status === "rejected" || result.value !== true) || this.manager.list().some(p => this.manager.getLaunch(p.id))) {
      throw new Error("Owned browser shutdown could not be confirmed; launch records remain quarantined");
    }
    if (!helpersStopped) throw new Error("Native process helper shutdown could not be confirmed; the helper remains quarantined");
    this.manager.dispose();
  }
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "access-control-allow-origin": "" } });
}
