import { randomBytes, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  PLAYWRIGHT_MAX_MESSAGE_BYTES,
  PLAYWRIGHT_PROTOCOL_VERSION,
  playwrightWorkerEnvironment,
  resolvePlaywrightRuntime,
} from "./playwright-runtime.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface FirefoxOwner {
  endpoint: string;
  token: string;
  pid: number;
  browserPid: number;
  generation: string;
  binaryPath?: string;
}

export interface FirefoxReservation {
  endpoint: string;
  token: string;
  generation: string;
}

export interface StartFirefoxOwnerInput {
  profileId: string;
  executablePath: string;
  executableSha256: string;
  userDataDir: string;
  config: Record<string, JsonValue>;
  proxy?: { server: string; username?: string; password?: string; bypass?: string };
  networkMode?: "direct" | "system" | "proxy";
  addonDirs?: string[];
  addonUUIDs?: Record<string, string>;
  headless?: boolean;
  args?: string[];
  timeoutMs?: number;
}

export interface FirefoxOwnerCallbacks {
  reservation?: FirefoxReservation;
  onSpawn?: (owner: FirefoxOwner) => void | Promise<void>;
  onReady?: (owner: FirefoxOwner) => void | Promise<void>;
}

export interface FirefoxOwnerErrorDetails {
  operation?: string;
  outcome?: string;
}

export class FirefoxOwnerError extends Error {
  constructor(
    readonly code: "invalid_request" | "invalid_response" | "operation_failed" | "runtime_unavailable" | "timeout",
    message: string,
    readonly details?: FirefoxOwnerErrorDetails,
  ) {
    super(message);
    this.name = "FirefoxOwnerError";
  }
}

const owners = new Map<string, FirefoxOwner>();

const FIREFOX_OWNER_DIAGNOSTIC_LIMIT = 128;
const FIREFOX_OWNER_OPERATIONS = [
  "owner-ready", "status", "close", "bring-to-front", "detach", "playwright-endpoint",
  "page", "search-provider", "profile-card", "navigate", "label-window", "ensure-cookies",
  "session-capture", "session-restore", "cookie-add", "cookie-harvest", "diagnostics",
] as const;
type FirefoxOwnerDiagnosticOperation = typeof FIREFOX_OWNER_OPERATIONS[number] | "other";
export interface FirefoxOwnerRpcDiagnostic {
  sequence: number;
  startedAt: number;
  elapsedMs: number;
  transport: "http" | "stdout";
  operation: FirefoxOwnerDiagnosticOperation;
  phase: "request-validation" | "readiness" | "request" | "headers" | "body" | "json" | "protocol" | "remote" | "complete";
  outcome: "running" | "ok" | "invalid-request" | "caller-timeout" | "caller-abort" | "remote-timeout" | "remote-error"
    | "invalid-json" | "invalid-protocol" | "response-overflow" | "http-error" | "transport-error" | "owner-exited";
  timeoutMs: number | null;
  httpStatus: number | null;
  contentType: "missing" | "json" | "html" | "text" | "binary" | "other";
  bodyBytes: number;
}
const ownerDiagnostics: FirefoxOwnerRpcDiagnostic[] = [];
let diagnosticSequence = 0;

function beginOwnerDiagnostic(transport: FirefoxOwnerRpcDiagnostic["transport"], operation: unknown, timeoutMs?: number): FirefoxOwnerRpcDiagnostic {
  const entry: FirefoxOwnerRpcDiagnostic = {
    sequence: ++diagnosticSequence, startedAt: Date.now(), elapsedMs: 0, transport,
    operation: typeof operation === "string" && (FIREFOX_OWNER_OPERATIONS as readonly string[]).includes(operation)
      ? operation as FirefoxOwnerDiagnosticOperation : "other",
    phase: transport === "stdout" ? "readiness" : "request-validation", outcome: "running",
    timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs! > 0 ? timeoutMs! : null,
    httpStatus: null, contentType: "missing", bodyBytes: 0,
  };
  ownerDiagnostics.push(entry);
  if (ownerDiagnostics.length > FIREFOX_OWNER_DIAGNOSTIC_LIMIT) ownerDiagnostics.shift();
  return entry;
}

function finishOwnerDiagnostic(entry: FirefoxOwnerRpcDiagnostic, outcome: FirefoxOwnerRpcDiagnostic["outcome"]): void {
  entry.outcome = outcome;
  entry.elapsedMs = Math.max(0, Date.now() - entry.startedAt);
}

/** Fixed categories only: never retain endpoints, identities, bodies, tokens or raw errors. */
export function getFirefoxOwnerDiagnostics(): FirefoxOwnerRpcDiagnostic[] {
  return ownerDiagnostics.map(entry => ({ ...entry,
    elapsedMs: entry.outcome === "running" ? Math.max(0, Date.now() - entry.startedAt) : entry.elapsedMs,
  }));
}

function responseContentType(value: string | null): FirefoxOwnerRpcDiagnostic["contentType"] {
  if (!value) return "missing";
  const mime = value.split(";", 1)[0]!.trim().toLowerCase();
  if (mime === "application/json" || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mime)) return "json";
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/octet-stream") return "binary";
  return "other";
}

function validAddonUUIDs(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length <= 256
    && Object.entries(value).every(([id, uuid]) => id.length >= 1 && id.length <= 200
      && /^[a-zA-Z0-9@._{}-]+$/.test(id) && !["__proto__", "prototype", "constructor"].includes(id)
      && typeof uuid === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid));
}

function endpointUrl(endpoint: string): URL {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new FirefoxOwnerError("invalid_request", "Firefox owner endpoint is invalid"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.pathname !== "/") {
    throw new FirefoxOwnerError("invalid_request", "Firefox owner endpoint is invalid");
  }
  return parsed;
}

function endpointKey(endpoint: string, generation: string): string {
  const parsed = endpointUrl(endpoint);
  return `firefox://127.0.0.1:${parsed.port}/${encodeURIComponent(generation)}`;
}

function responseError(code: string, message: string, details?: FirefoxOwnerErrorDetails): FirefoxOwnerError {
  const valid = ["invalid_request", "invalid_response", "operation_failed", "runtime_unavailable", "timeout"] as const;
  return new FirefoxOwnerError(valid.includes(code as typeof valid[number]) ? code as typeof valid[number] : "operation_failed", message, details);
}

function requestSignal(options: { signal?: AbortSignal; timeoutMs?: number }) {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new FirefoxOwnerError("invalid_request", "Firefox owner timeout is invalid");
  }
  if (!options.signal && options.timeoutMs === undefined) return { signal: undefined, dispose() {}, timedOut: () => false };
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    },
    timedOut: () => timedOut,
  };
}

async function readResponse(response: Response, diagnostic: FirefoxOwnerRpcDiagnostic): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      diagnostic.bodyBytes = bytes;
      if (bytes > PLAYWRIGHT_MAX_MESSAGE_BYTES) {
        finishOwnerDiagnostic(diagnostic, "response-overflow");
        throw new FirefoxOwnerError("invalid_response", "Firefox owner response exceeded its limit");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string" || !Number.isSafeInteger(address.port)) {
    throw new FirefoxOwnerError("runtime_unavailable", "Firefox owner port is unavailable");
  }
  return address.port;
}

export async function reserveFirefoxOwner(): Promise<FirefoxReservation> {
  const port = await freeLoopbackPort();
  return {
    endpoint: `http://127.0.0.1:${port}/`,
    token: randomBytes(32).toString("hex"),
    generation: randomBytes(16).toString("hex"),
  };
}

export function firefoxOwnerReady(response: unknown): FirefoxOwner {
  const value: any = response;
  if (value?.version !== PLAYWRIGHT_PROTOCOL_VERSION) {
    throw new FirefoxOwnerError("invalid_response", "Firefox owner readiness is invalid");
  }
  if (value.ok === false) {
    throw responseError(value.error?.code, "Firefox owner failed before ready");
  }
  if (value.ok !== true
    || typeof value.result?.endpoint !== "string" || typeof value.result?.generation !== "string"
    || !Number.isSafeInteger(value.result?.pid) || !Number.isSafeInteger(value.result?.browserPid)) {
    throw new FirefoxOwnerError("invalid_response", "Firefox owner readiness is invalid");
  }
  return value.result;
}

function readReady(child: ChildProcess, timeoutMs?: number): Promise<FirefoxOwner> {
  const diagnostic = beginOwnerDiagnostic("stdout", "owner-ready", timeoutMs);
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      try { child.kill(); } catch {}
      fail(new FirefoxOwnerError("timeout", "Firefox owner readiness timed out"), "caller-timeout");
    }, timeoutMs);
    const fail = (error: Error, outcome: FirefoxOwnerRpcDiagnostic["outcome"]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      finishOwnerDiagnostic(diagnostic, outcome);
      reject(error);
    };
    const succeed = (owner: FirefoxOwner) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      diagnostic.phase = "complete";
      finishOwnerDiagnostic(diagnostic, "ok");
      resolve(owner);
    };
    child.once("error", () => fail(new FirefoxOwnerError("runtime_unavailable", "Firefox owner could not start"), "transport-error"));
    child.once("close", () => fail(new FirefoxOwnerError("runtime_unavailable", "Firefox owner stopped before ready"), "owner-exited"));
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      output += chunk.toString();
      diagnostic.bodyBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (Buffer.byteLength(output) > PLAYWRIGHT_MAX_MESSAGE_BYTES) {
        fail(new FirefoxOwnerError("invalid_response", "Firefox owner readiness exceeded its limit"), "response-overflow");
        return;
      }
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      diagnostic.phase = "json";
      let response: any;
      try { response = JSON.parse(output.slice(0, newline)); } catch { fail(new FirefoxOwnerError("invalid_response", "Firefox owner readiness is invalid"), "invalid-json"); return; }
      diagnostic.phase = "protocol";
      try { succeed(firefoxOwnerReady(response)); }
      catch (error) { fail(error instanceof Error ? error : new FirefoxOwnerError("invalid_response", "Firefox owner readiness is invalid"),
        error instanceof FirefoxOwnerError && error.code === "invalid_response" ? "invalid-protocol"
          : error instanceof FirefoxOwnerError && error.code === "timeout" ? "remote-timeout" : "remote-error"); }
    });
  });
}

export async function startFirefoxOwner(
  input: StartFirefoxOwnerInput,
  callbacks: FirefoxOwnerCallbacks = {},
): Promise<FirefoxOwner> {
  if (!input || typeof input.profileId !== "string" || !input.profileId
    || typeof input.executablePath !== "string" || !input.executablePath
    || typeof input.executableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.executableSha256)
    || typeof input.userDataDir !== "string" || !input.userDataDir
    || !input.config || typeof input.config !== "object" || Array.isArray(input.config)
    || (input.networkMode !== undefined && !["direct", "system", "proxy"].includes(input.networkMode))
    || (input.addonDirs !== undefined && (!Array.isArray(input.addonDirs) || input.addonDirs.length > 32
      || input.addonDirs.some((path) => typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))))
    || (input.addonUUIDs !== undefined && !validAddonUUIDs(input.addonUUIDs))
    || (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1))) {
    throw new FirefoxOwnerError("invalid_request", "Firefox owner input is invalid");
  }
  try { JSON.stringify(input.config); } catch { throw new FirefoxOwnerError("invalid_request", "Firefox owner input is invalid"); }
  if (await sha256File(input.executablePath) !== input.executableSha256) {
    throw new FirefoxOwnerError("operation_failed", "Firefox executable changed before launch");
  }
  const reservation = callbacks.reservation ?? await reserveFirefoxOwner();
  endpointUrl(reservation.endpoint);
  if (typeof reservation.token !== "string" || !reservation.token || typeof reservation.generation !== "string" || !reservation.generation) {
    throw new FirefoxOwnerError("invalid_request", "Firefox owner reservation is invalid");
  }
  const runtime = resolvePlaywrightRuntime();
  const workerPath = runtime.kind === "source"
    ? join(import.meta.dir, "firefox-worker.mjs")
    : join(runtime.root, "firefox-worker.mjs");
  let child: ChildProcess;
  try {
    child = spawn(runtime.nodeExecutable, [workerPath, `--aliasmode-firefox-owner=${reservation.generation}`], {
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: playwrightWorkerEnvironment(),
    });
  } catch {
    throw new FirefoxOwnerError("runtime_unavailable", "Firefox owner could not start");
  }
  if (!child.pid || !child.stdin) {
    child.kill();
    throw new FirefoxOwnerError("runtime_unavailable", "Firefox owner could not start");
  }
  const provisional: FirefoxOwner = {
    endpoint: reservation.endpoint,
    token: reservation.token,
    generation: reservation.generation,
    pid: child.pid,
    browserPid: 0,
    binaryPath: child.spawnfile,
  };
  try {
    await callbacks.onSpawn?.(provisional);
  } catch {
    child.kill();
    throw new FirefoxOwnerError("operation_failed", "Firefox owner reservation was not saved");
  }
  const ready = readReady(child, input.timeoutMs);
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ version: PLAYWRIGHT_PROTOCOL_VERSION, ...input, owner: reservation }));
  let owner: FirefoxOwner;
  try {
    const result = await ready;
    if (result.endpoint !== reservation.endpoint || result.generation !== reservation.generation || result.pid !== child.pid) {
      throw new FirefoxOwnerError("invalid_response", "Firefox owner readiness is invalid");
    }
    owner = { ...provisional, browserPid: result.browserPid };
    firefoxEndpoint(owner);
    await callbacks.onReady?.(owner);
  } catch (error) {
    child.kill();
    throw error;
  }
  child.unref();
  (child.stdout as any)?.unref?.();
  return owner;
}

export function firefoxEndpoint(owner: FirefoxOwner): string {
  const endpoint = endpointKey(owner.endpoint, owner.generation);
  owners.set(endpoint, owner);
  return endpoint;
}

export function firefoxOwnerForEndpoint(endpoint: string): FirefoxOwner | undefined {
  return owners.get(endpoint);
}

export function forgetFirefoxOwner(owner: FirefoxOwner): void {
  owners.delete(endpointKey(owner.endpoint, owner.generation));
}

export async function callFirefoxOwner<T>(
  owner: FirefoxOwner,
  operation: string,
  payload: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const diagnostic = beginOwnerDiagnostic("http", operation, options.timeoutMs);
  let request: string;
  let abort: ReturnType<typeof requestSignal>;
  try {
    if (typeof operation !== "string" || !operation || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new FirefoxOwnerError("invalid_request", "Firefox owner request is invalid");
    }
    request = JSON.stringify({
      version: PLAYWRIGHT_PROTOCOL_VERSION,
      operation,
      payload: { ...(payload as Record<string, unknown>), ownerGeneration: owner.generation },
    });
    if (Buffer.byteLength(request) > PLAYWRIGHT_MAX_MESSAGE_BYTES) {
      throw new FirefoxOwnerError("invalid_request", "Firefox owner request exceeded its limit");
    }
    abort = requestSignal(options);
  } catch (error) {
    finishOwnerDiagnostic(diagnostic, "invalid-request");
    throw error;
  }
  let response: Response;
  try {
    diagnostic.phase = "request";
    response = await fetch(owner.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
      body: request,
      signal: abort.signal,
    });
    diagnostic.phase = "headers";
    diagnostic.httpStatus = response.status;
    diagnostic.contentType = responseContentType(response.headers.get("content-type"));
    diagnostic.phase = "body";
    const body = await readResponse(response, diagnostic);
    diagnostic.phase = "json";
    let value: any;
    try { value = JSON.parse(body); } catch {
      finishOwnerDiagnostic(diagnostic, "invalid-json");
      throw new FirefoxOwnerError("invalid_response", "Firefox owner response is invalid");
    }
    diagnostic.phase = "protocol";
    if (value?.version !== PLAYWRIGHT_PROTOCOL_VERSION || typeof value.ok !== "boolean") {
      finishOwnerDiagnostic(diagnostic, "invalid-protocol");
      throw new FirefoxOwnerError("invalid_response", "Firefox owner response is invalid");
    }
    if (!value.ok) {
      diagnostic.phase = "remote";
      finishOwnerDiagnostic(diagnostic, value.error?.code === "timeout" ? "remote-timeout" : "remote-error");
      throw responseError(value.error?.code, value.error?.message || "Firefox owner operation failed", value.error?.details);
    }
    if (!response.ok) {
      finishOwnerDiagnostic(diagnostic, "http-error");
      throw new FirefoxOwnerError("operation_failed", "Firefox owner operation failed");
    }
    diagnostic.phase = "complete";
    finishOwnerDiagnostic(diagnostic, "ok");
    return value.result as T;
  } catch (error) {
    if (error instanceof FirefoxOwnerError) throw error;
    if (abort.timedOut()) {
      finishOwnerDiagnostic(diagnostic, "caller-timeout");
      throw new FirefoxOwnerError("timeout", "Firefox owner operation timed out");
    }
    finishOwnerDiagnostic(diagnostic, options.signal?.aborted ? "caller-abort" : "transport-error");
    throw new FirefoxOwnerError("runtime_unavailable", "Firefox owner is unavailable");
  } finally { abort.dispose(); }
}

export async function closeFirefoxOwner(owner: FirefoxOwner, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  await callFirefoxOwner(owner, "close", {}, options);
  forgetFirefoxOwner(owner);
}
