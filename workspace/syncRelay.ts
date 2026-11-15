import { validateActionPacket, type ActionPacket } from "./eventPolicy.ts";
import { approvedOrigin, approvedUrl, sameToken, sessionToken, type PacingMode, type SyncProfileConfig, type SyncRole } from "./protocol.ts";

export interface RelayTransport { send(packet: unknown): void; close(code?: number, reason?: string): void; }
interface RegisteredProfile {
  config: SyncProfileConfig;
  transport?: RelayTransport;
  paused: boolean;
  activeOrigin: string;
  queued: ActionPacket[];
  timer?: ReturnType<typeof setTimeout>;
  awaiting?: { id: string; epoch: number; timer: ReturnType<typeof setTimeout> };
  /** Role the operator chose; transient drops restore it automatically. */
  intended: SyncRole;
  rejoin: boolean;
  softFailures: number;
  pagePath: string;
}
/** Drops that should not detach a profile from its administrator for good. */
export const TRANSIENT_REASONS = new Set(["disconnected", "ack_timeout", "origin_changed", "unapproved_page", "transport_error", "queue_limit", "action_rejected", "operator_disconnected"]);
const MAX_SOFT_FAILURES = 5;
export interface RelayProfileStatus { profileId: string; role: SyncRole; intendedRole: SyncRole; rejoining: boolean; paused: boolean; connected: boolean; origin: string; queued: number; page: string; group: string; }
/** Group key used when a profile has no library group. */
export const UNGROUPED = "__ungrouped";
export interface SyncRelayOptions {
  onChange?: () => void;
  onManual?: (profileId: string, reason: string) => void;
  random?: () => number;
  ackTimeoutMs?: number;
  /** Called with origin+pathname when the administrator's page changes. */
  onAdminPage?: (adminId: string, url: string) => void;
  /** Origins that stay approved whatever the saved settings say. */
  pinnedOrigins?: string[];
  /** A profile rejoined synchronization (automatic rejoin or forced follower). */
  onSync?: (profileId: string) => void;
  /** The administrator produced an action; followers is how many received it. */
  onAdminAction?: (adminId: string, action: string, followers: number) => void;
  /** The group administrator's viewport size changed (CSS pixels). */
  onAdminLayout?: (adminId: string, layout: { width: number; height: number }) => void;
  /** Sync group of a profile; each group has at most one administrator. */
  groupFor?: (profileId: string) => string | null | undefined;
}
const MAX_QUEUE = 64;
/** Authenticated, bounded FIFO dispatcher. Pacing is scheduling, never a detection-evasion promise. */
export class SyncRelay {
  private profiles = new Map<string, RegisteredProfile>();
  private epochValue = 1;
  /** Last accepted action sequence per administrator (several groups lead at once). */
  private adminSequences = new Map<string, number>();
  private pacingValue: PacingMode = "fast";
  private approvedOrigins = new Set<string>();
  private autoFollowValue = true;
  constructor(private options: SyncRelayOptions = {}) {}
  get autoFollow(): boolean { return this.autoFollowValue; }
  setAutoFollow(enabled: boolean): void { this.autoFollowValue = enabled === true; this.options.onChange?.(); }
  get epoch(): number { return [...this.profiles.values()].find(p => p.config.role === "admin")?.config.epoch ?? this.epochValue; }
  /** Sync group of a profile ("__ungrouped" when it has none). */
  groupOf(profileId: string): string { return this.options.groupFor?.(profileId) || UNGROUPED; }
  private sameGroup(a: RegisteredProfile, b: RegisteredProfile): boolean { return this.groupOf(a.config.profileId) === this.groupOf(b.config.profileId); }
  private members(group: string): RegisteredProfile[] { return [...this.profiles.values()].filter(p => this.groupOf(p.config.profileId) === group); }
  /** Current administrator of a group, if any. */
  adminOf(group: string): string | undefined { return this.members(group).find(p => p.config.role === "admin")?.config.profileId; }
  get pacing(): PacingMode { return this.pacingValue; }
  get origins(): string[] { return [...this.approvedOrigins]; }
  configure(origins: unknown[], pacing: unknown = this.pacing): void {
    if (origins.length > 32 || (pacing !== "fast" && pacing !== "paced")) throw new Error("Workspace settings are invalid");
    this.approvedOrigins = new Set([...(this.options.pinnedOrigins ?? []), ...origins].map(approvedOrigin));
    this.pacingValue = pacing;
    for (const p of this.profiles.values()) {
      p.config.origins = p.config.origins.filter(origin => this.approvedOrigins.has(origin));
      if (!p.config.origins.length && p.config.role !== "manual") { p.config.role = "manual"; this.options.onManual?.(p.config.profileId, "origin_removed"); }
    }
    this.invalidate();
  }
  register(profileId: string, origin?: string): SyncProfileConfig {
    let p = this.profiles.get(profileId);
    if (!p) {
      p = { config: { profileId, token: sessionToken(), role: "manual", origins: [], relayUrl: "ws://127.0.0.1:8080/relay", epoch: ++this.epochValue }, paused: false, activeOrigin: "", queued: [], intended: "manual", rejoin: false, softFailures: 0, pagePath: "" };
      this.profiles.set(profileId, p);
    }
    if (origin) {
      const canonical = approvedOrigin(origin);
      if (!this.approvedOrigins.has(canonical)) throw new Error("This website origin has not been approved");
      p.config.origins = [canonical];
    }
    return { ...p.config, origins: [...p.config.origins] };
  }
  /** Followers currently attached and the page they report (origin + pathname). */
  followers(group?: string): Array<{ profileId: string; page: string; connected: boolean }> {
    return [...this.profiles.values()].filter(p => p.config.role === "follower" && !p.paused && (group === undefined || this.groupOf(p.config.profileId) === group)).map(p => ({ profileId: p.config.profileId, page: p.pagePath, connected: !!p.transport }));
  }
  tokenFor(profileId: string): string | undefined { return this.profiles.get(profileId)?.config.token; }
  configFor(profileId: string): SyncProfileConfig | undefined {
    const p = this.profiles.get(profileId);
    return p ? { ...p.config, origins: [...p.config.origins] } : undefined;
  }
  statuses(): RelayProfileStatus[] {
    return [...this.profiles].map(([profileId, p]) => ({ profileId, role: p.config.role, intendedRole: p.intended, rejoining: p.rejoin, paused: p.paused, connected: !!p.transport, origin: p.activeOrigin, queued: p.queued.length + (p.awaiting ? 1 : 0), page: p.pagePath || "", group: this.groupOf(profileId) }));
  }
  setRole(profileId: string, role: SyncRole, options: { forceFollowers?: boolean; eligible?: (id: string) => boolean } = {}): string[] {
    const p = this.require(profileId);
    if (!["admin", "follower", "manual"].includes(role)) throw new Error("Role is invalid");
    const affectsAdmin = role === "admin" || p.config.role === "admin";
    const forced: string[] = [];
    if (role === "admin") {
      const force = options.forceFollowers ?? this.autoFollowValue;
      for (const other of this.profiles.values()) {
        if (other === p || !this.sameGroup(other, p)) continue;
        const id = other.config.profileId;
        if (force && (options.eligible ? options.eligible(id) : true)) {
          if (!other.config.origins.length && p.config.origins.length) other.config.origins = [...p.config.origins];
          if (other.config.origins.length) {
            other.config.role = "follower"; other.intended = "follower"; other.rejoin = false; other.paused = false; other.softFailures = 0;
            forced.push(id); this.options.onSync?.(id); continue;
          }
        }
        if (other.config.role === "admin" || other.intended === "admin") {
          other.config.role = "manual"; other.intended = "manual"; other.rejoin = false;
          this.options.onManual?.(id, "administrator_changed");
        }
      }
    }
    p.config.role = role;
    p.intended = role;
    p.rejoin = false;
    p.softFailures = 0;
    p.paused = false;
    if (affectsAdmin) this.invalidate(this.groupOf(profileId)); else this.invalidateProfile(p);
    if (role === "manual") this.options.onManual?.(profileId, "operator_manual");
    return forced;
  }
  /** Turn every other eligible profile into a follower of the current administrator. */
  forceFollowers(eligible?: (id: string) => boolean, group?: string): string[] {
    const pool = group === undefined ? [...this.profiles.values()] : this.members(group);
    const admin = pool.find(p => p.config.role === "admin") ?? pool.find(p => p.intended === "admin");
    if (!admin) throw new Error(group === undefined ? "Choose an administrator profile first" : "Choose an administrator for this group first");
    return this.setRole(admin.config.profileId, "admin", { forceFollowers: true, eligible });
  }
  /** A profile moved to another group: keep at most one administrator per group. */
  regroup(profileId: string): void {
    const p = this.profiles.get(profileId);
    if (!p) return;
    if ((p.config.role === "admin" || p.intended === "admin") && [...this.profiles.values()].some(o => o !== p && this.sameGroup(o, p) && o.config.role === "admin")) {
      p.config.role = "manual"; p.intended = "manual"; p.rejoin = false; p.paused = false;
      this.options.onManual?.(profileId, "group_has_administrator");
    }
    this.invalidateProfile(p);
  }
  setPaused(profileId: string, enabled: boolean): void {
    const p = this.require(profileId);
    p.paused = enabled;
    if (p.config.role === "admin") this.invalidate(this.groupOf(profileId)); else this.invalidateProfile(p);
  }
  setOrigin(profileId: string, origin: string): void {
    const canonical = approvedOrigin(origin);
    if (!this.approvedOrigins.has(canonical)) throw new Error("This website origin has not been approved");
    const p = this.require(profileId);
    p.config.origins = [canonical];
    p.activeOrigin = "";
    if (p.config.role === "admin") this.invalidate(this.groupOf(profileId)); else this.invalidateProfile(p);
  }
  authenticate(profileId: unknown, token: unknown, transport: RelayTransport): boolean {
    if (typeof profileId !== "string") return false;
    const p = this.profiles.get(profileId);
    if (!p || !sameToken(token, p.config.token)) return false;
    if (p.transport) { p.transport.close(4009, "A profile connection already exists"); this.disconnect(profileId, p.transport); }
    p.transport = transport;
    transport.send(this.publicConfig(p));
    this.options.onChange?.();
    return true;
  }
  receive(profileId: string, transport: RelayTransport, packet: unknown): void {
    const p = this.require(profileId);
    if (p.transport !== transport || !packet || typeof packet !== "object") return;
    const v = packet as Record<string, unknown>;
    if (v.type === "PAGE") {
      try {
        const url = new URL(approvedUrl(v.url, p.config.origins));
        p.activeOrigin = url.origin;
        p.pagePath = `${url.origin}${url.pathname}`;
        if (p.rejoin && p.config.role === "manual" && (p.intended === "follower" || p.intended === "admin")) this.restore(p);
        if (p.config.role === "admin" && !p.paused) this.options.onAdminPage?.(profileId, p.pagePath);
      }
      catch { p.activeOrigin = ""; p.pagePath = ""; this.manual(profileId, "unapproved_page"); }
      this.options.onChange?.();
      return;
    }
    if (v.type === "LAYOUT") {
      const width = Number(v.width), height = Number(v.height);
      if (p.config.role === "admin" && !p.paused && Number.isInteger(width) && Number.isInteger(height) && width >= 200 && width <= 7680 && height >= 150 && height <= 4320) this.options.onAdminLayout?.(profileId, { width, height });
      return;
    }
    if (v.type === "MANUAL_OVERRIDE") {
      // Keep the page's own short reason for the operator log; it never contains page content.
      const detail = typeof v.reason === "string" ? v.reason.replace(/[^ -~]/g, "").slice(0, 80) : "";
      this.manual(profileId, detail ? `page_manual_override: ${detail}` : "page_manual_override"); return;
    }
    if (v.type === "ACK") {
      if (typeof v.id !== "string" || !p.awaiting || p.awaiting.id !== v.id || v.epoch !== p.awaiting.epoch || v.epoch !== p.config.epoch) return;
      clearTimeout(p.awaiting.timer);
      p.awaiting = undefined;
      // A single missed replay (page still loading, element not rendered yet)
      // must not detach the follower; give up only after repeated failures.
      if (v.status !== "applied" && ++p.softFailures >= MAX_SOFT_FAILURES) this.manual(profileId, "action_rejected");
      else { if (v.status === "applied") p.softFailures = 0; this.dispatchNext(profileId, p); }
      this.options.onChange?.();
      return;
    }
    if (v.type !== "ACTION") return;
    if (p.config.role !== "admin" || p.paused || !p.activeOrigin) return;
    const valid = validateActionPacket(packet, { origins: p.config.origins, epoch: p.config.epoch });
    if (!valid.ok) { transport.send({ type: "ACTION_REJECTED", reason: valid.reason }); return; }
    const action = valid.action;
    if (action.seq <= (this.adminSequences.get(profileId) ?? 0) || action.origin !== p.activeOrigin) {
      transport.send({ type: "ACTION_REJECTED", reason: "sequence_or_origin_mismatch" }); return;
    }
    this.adminSequences.set(profileId, action.seq);
    let delivered = 0;
    for (const [id, target] of this.profiles) {
      if (id === profileId || !this.sameGroup(target, p) || target.config.role !== "follower" || target.paused || !target.transport || target.activeOrigin !== action.origin || !target.config.origins.includes(action.origin)) continue;
      if (target.queued.length + (target.awaiting ? 1 : 0) >= MAX_QUEUE) { this.manual(id, "queue_limit"); continue; }
      target.queued.push({ ...action, epoch: target.config.epoch });
      this.dispatchNext(id, target); delivered++;
    }
    this.options.onAdminAction?.(profileId, action.action, delivered);
    this.options.onChange?.();
  }
  private dispatchNext(id: string, p: RegisteredProfile): void {
    if (p.timer || p.awaiting || !p.transport || p.paused || p.config.role !== "follower" || !p.queued.length) return;
    const epoch = p.config.epoch;
    const next = () => {
      p.timer = undefined;
      if (epoch !== p.config.epoch || !p.transport || p.paused || p.config.role !== "follower") return;
      const action = p.queued.shift();
      if (!action || action.epoch !== p.config.epoch) { this.manual(id, "origin_changed"); return; }
      if (p.activeOrigin !== action.origin) { this.dispatchNext(id, p); return; } // follower still loading; skip this action
      p.awaiting = { id: action.id, epoch: action.epoch, timer: setTimeout(() => {
        if (p.awaiting?.id !== action.id || p.awaiting.epoch !== action.epoch) return;
        p.awaiting = undefined;
        if (++p.softFailures >= MAX_SOFT_FAILURES) this.manual(id, "ack_timeout");
        else { this.dispatchNext(id, p); this.options.onChange?.(); }
      }, this.options.ackTimeoutMs ?? 8000) };
      try { p.transport.send(action); } catch { this.manual(id, "transport_error"); }
    };
    if (this.pacing === "fast") next();
    else p.timer = setTimeout(next, 450 + Math.floor(Math.min(0.999999, Math.max(0, (this.options.random ?? Math.random)())) * 1301));
  }
  disconnect(profileId: string, transport?: RelayTransport): void {
    const p = this.profiles.get(profileId);
    if (!p || (transport && p.transport !== transport)) return;
    p.transport = undefined;
    p.activeOrigin = "";
    this.manual(profileId, "disconnected");
  }
  /** Retire only a deleted local profile; its old token must never reconnect. */
  unregister(profileId: string): void {
    const p = this.profiles.get(profileId);
    if (!p) return;
    const affectsAdmin = p.config.role === "admin";
    this.profiles.delete(profileId);
    if (p.timer) clearTimeout(p.timer);
    if (p.awaiting) clearTimeout(p.awaiting.timer);
    p.timer = undefined; p.awaiting = undefined; p.queued = [];
    const transport = p.transport;
    p.transport = undefined;
    try { transport?.close(1000, "Local profile deleted"); } catch { /* The token is already revoked. */ }
    if (affectsAdmin) this.invalidate(this.groupOf(profileId)); else this.options.onChange?.();
  }
  manualMany(profileIds: string[], reason: string): void {
    for (const profileId of profileIds) {
      const p = this.require(profileId);
      if (p.config.role !== "manual") this.mark(p, reason);
      p.config.role = "manual"; p.paused = false;
      this.options.onManual?.(profileId, reason);
    }
    this.invalidate();
  }
  /** Restore every profile that dropped for a transient reason and is connected on an approved page. */
  rejoinAll(): void {
    let changed = false;
    for (const p of this.profiles.values()) if (p.rejoin && p.config.role === "manual" && p.transport && p.activeOrigin) { this.restore(p, false); changed = true; }
    if (changed) this.invalidate();
  }
  private mark(p: RegisteredProfile, reason: string): void {
    if (TRANSIENT_REASONS.has(reason) && (p.intended === "follower" || p.intended === "admin")) p.rejoin = true;
    else { p.intended = "manual"; p.rejoin = false; }
  }
  private restore(p: RegisteredProfile, notify = true): void {
    if (p.intended === "admin" && [...this.profiles.values()].some(o => o !== p && this.sameGroup(o, p) && o.config.role === "admin")) { p.intended = "manual"; p.rejoin = false; return; }
    p.config.role = p.intended;
    p.rejoin = false; p.softFailures = 0; p.paused = false;
    this.options.onSync?.(p.config.profileId);
    if (!notify) return;
    if (p.intended === "admin") this.invalidate(this.groupOf(p.config.profileId)); else this.invalidateProfile(p);
  }
  manual(profileId: string, reason: string): void {
    const p = this.require(profileId);
    if (p.config.role !== "manual" || !TRANSIENT_REASONS.has(reason)) this.mark(p, reason);
    if (p.config.role === "manual" && !p.paused && !p.timer && !p.awaiting && !p.queued.length) { this.options.onManual?.(profileId, reason); return; }
    const affectsAdmin = p.config.role === "admin";
    p.config.role = "manual";
    p.paused = false;
    if (affectsAdmin) this.invalidate(this.groupOf(profileId)); else this.invalidateProfile(p);
    this.options.onManual?.(profileId, reason);
  }
  private publicConfig(p: RegisteredProfile): object {
    return { type: "CONFIG", profileId: p.config.profileId, role: p.config.role, origins: p.config.origins, epoch: p.config.epoch, paused: p.paused };
  }
  private resetProfile(p: RegisteredProfile, epoch: number): void {
    if (p.timer) clearTimeout(p.timer);
    if (p.awaiting) clearTimeout(p.awaiting.timer);
    p.timer = undefined; p.awaiting = undefined; p.queued = []; p.config.epoch = epoch;
    try { p.transport?.send(this.publicConfig(p)); } catch { p.transport = undefined; p.config.role = "manual"; }
  }
  private invalidateProfile(p: RegisteredProfile): void {
    this.resetProfile(p, ++this.epochValue);
    this.options.onChange?.();
  }
  /** New epoch for one group (an administrator change) or every profile (settings change). */
  private invalidate(group?: string): void {
    const epoch = ++this.epochValue;
    for (const p of this.profiles.values()) {
      if (group !== undefined && this.groupOf(p.config.profileId) !== group) continue;
      this.adminSequences.delete(p.config.profileId);
      this.resetProfile(p, epoch);
    }
    this.options.onChange?.();
  }
  private require(profileId: string): RegisteredProfile {
    const p = this.profiles.get(profileId);
    if (!p) throw new Error("Workspace profile is missing");
    return p;
  }
  stop(): void {
    this.invalidate();
    for (const p of this.profiles.values()) { p.transport?.close(1001, "Workspace stopped"); p.transport = undefined; }
  }
}
