/** Native Chromium routing acceptance against authenticated loopback fixtures only. */
import assert from "node:assert/strict";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Launcher } from "../launcher.ts";
import { buildNewProfile } from "../create.ts";
import { ProfileStore } from "../store.ts";
import type { LaunchInfo, Profile } from "../types.ts";
import { ownedRoot, readResourceSnapshot, windowsArgv } from "../workspace/resourceMonitor.ts";
import { callFirefoxOwner } from "../firefox-runtime.ts";
import type { NetworkMode } from "../workspace/networkPolicy.ts";

const FIXTURE_HOST = "fixture.stakemode.test";
const FIXTURE_URL = `http://${FIXTURE_HOST}/marker`;
const MAX_BUFFER = 64 * 1024;
interface ProxyFixture {
  port: number;
  marker: string;
  username: string;
  password: string;
  successes: number;
  authenticationFailures: number;
  targets: Set<string>;
  close(): Promise<void>;
}
function response(socket: net.Socket, status: number, content = ""): void {
  const body = Buffer.from(content, "utf8");
  const reason = status === 200 ? "OK" : status === 407 ? "Proxy Authentication Required" : "Forbidden";
  socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`), body]));
}
function permittedTarget(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === FIXTURE_HOST && (!url.port || url.port === "80")
      && url.pathname === "/marker" && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}
async function startProxyFixture(protocol: "http" | "socks5"): Promise<ProxyFixture> {
  const sockets = new Set<net.Socket>();
  const username = `fixture_${randomBytes(8).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  const marker = `${protocol}-route-${randomBytes(8).toString("hex")}`;
  const fixture: ProxyFixture = { port: 0, marker, username, password, successes: 0, authenticationFailures: 0, targets: new Set(), close: async () => {} };
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const server = net.createServer((socket) => {
    if (sockets.size >= 128) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(8_000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let state: "http" | "greeting" | "authentication" | "connect" | "socks-http" | "finished" = protocol === "http" ? "http" : "greeting";
    const consume = (count: number): Buffer => { const bytes = buffer.subarray(0, count); buffer = buffer.subarray(count); return bytes; };
    const processRequest = () => {
      while (!socket.destroyed && state !== "finished") {
        if (state === "http" || state === "socks-http") {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const head = consume(end + 4).toString("latin1");
          const lines = head.split("\r\n"), request = lines[0]?.match(/^GET\s+(\S+)\s+HTTP\/1\.[01]$/);
          if (state === "http") {
            const auth = lines.find((line) => /^proxy-authorization:/i.test(line))?.split(/:\s*/).slice(1).join(": ");
            if (auth !== authorization) { fixture.authenticationFailures++; state = "finished"; response(socket, 407); return; }
          }
          const host = lines.find((line) => /^host:/i.test(line))?.slice(5).trim().toLowerCase();
          const target = state === "http" ? request?.[1] : `http://${host}${request?.[1] ?? ""}`;
          state = "finished";
          // No real proxy forwarding exists: every other host, CONNECT request,
          // method, path, or scheme is blocked within this fixture process.
          if (!request || !target || !permittedTarget(target)) { response(socket, 403); return; }
          fixture.targets.add(target); fixture.successes++;
          response(socket, 200, fixture.marker); return;
        }
        if (state === "greeting") {
          if (buffer.length < 2) return;
          const count = buffer[1]!;
          if (buffer.length < count + 2) return;
          const greeting = consume(count + 2);
          if (greeting[0] !== 5 || !greeting.subarray(2).includes(2)) { state = "finished"; socket.end(Buffer.from([5, 0xff])); return; }
          socket.write(Buffer.from([5, 2])); state = "authentication"; continue;
        }
        if (state === "authentication") {
          if (buffer.length < 2) return;
          const usernameLength = buffer[1]!;
          if (buffer.length < usernameLength + 3) return;
          const passwordLength = buffer[usernameLength + 2]!;
          const length = usernameLength + passwordLength + 3;
          if (buffer.length < length) return;
          const auth = consume(length);
          const providedUser = auth.subarray(2, usernameLength + 2).toString("utf8");
          const providedPass = auth.subarray(usernameLength + 3).toString("utf8");
          if (auth[0] !== 1 || providedUser !== username || providedPass !== password) {
            fixture.authenticationFailures++; state = "finished"; socket.end(Buffer.from([1, 1])); return;
          }
          socket.write(Buffer.from([1, 0])); state = "connect"; continue;
        }
        if (state === "connect") {
          if (buffer.length < 5) return;
          // Domain-form CONNECT proves SOCKS remote DNS. Numeric addresses and
          // all non-fixture domains are refused rather than resolved or forwarded.
          if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0 || buffer[3] !== 3) {
            state = "finished"; socket.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return;
          }
          const hostnameLength = buffer[4]!;
          if (buffer.length < hostnameLength + 7) return;
          const request = consume(hostnameLength + 7);
          const hostname = request.subarray(5, hostnameLength + 5).toString("ascii").toLowerCase();
          const port = request.readUInt16BE(hostnameLength + 5);
          if (hostname !== FIXTURE_HOST || port !== 80) {
            state = "finished"; socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return;
          }
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); state = "socks-http"; continue;
        }
      }
    };
    socket.on("data", (bytes: Buffer) => {
      if (state === "finished") return;
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length > MAX_BUFFER) { socket.destroy(); return; }
      processRequest();
    });
  });
  await new Promise<void>((ready, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", failed); ready(); });
  });
  fixture.port = (server.address() as net.AddressInfo).port;
  fixture.close = () => new Promise<void>((ready, reject) => {
    for (const socket of sockets) socket.destroy();
    const timer = setTimeout(() => reject(new Error("Local proxy fixture did not close within its bound")), 5_000);
    server.close((error) => { clearTimeout(timer); if (error) reject(error); else ready(); });
  });
  return fixture;
}

export interface ProxyAcceptanceOptions {
  runtimeRoot: string;
  checkBudget?: () => void;
  chromiumPath: string;
  chromiumSha256: string;
  firefoxPath?: string;
  firefoxSha256?: string;
  playwright: { chromium: { connectOverCDP(endpoint: string, options: { timeout: number }): Promise<any> };
    firefox?: { connect(endpoint: string, options: { timeout: number }): Promise<any> } };
}
export interface ProxyAcceptanceResult {
  independentRouting: true;
  http: { authenticated: true; marker: string; requestCount: number };
  socks5: { authenticated: true; marker: string; requestCount: number; remoteDns: true };
  wrongCredentials: { http: true; socks5: true };
  separateProfileDirectories: true;
  separateRelayPorts: true;
  confirmedNativeCleanup: true;
  networkModes: {
    direct: { savedProxyIgnored: true; noProxyArgument: true; loopbackPageLoaded: true };
    system: { savedProxyIgnored: true; browserProxyOverrideAbsent: true; loopbackPageLoaded: true };
    firefoxPrefs?: { direct: 0; system: 5; loopbackPageLoaded: true };
  };
}
async function disconnectInspector(browser: any): Promise<void> {
  // In the pinned Playwright runtime, a connectOverCDP attachment's public close
  // closes its own ChromeTransport. Its private _connection is shared by all
  // in-process clients and must never be closed to detach one profile.
  // Launcher separately performs and confirms native process teardown.
  await browser.close();
}

export async function runProxyAcceptance(options: ProxyAcceptanceOptions): Promise<ProxyAcceptanceResult> {
  assert.equal(process.platform, "win32", "Native proxy acceptance requires prepared Windows browsers");
  assert.match(options.chromiumSha256, /^[a-f0-9]{64}$/);
  assert.ok(options.runtimeRoot, "Packaged runtime root is required");
  const verifyFirefox = options.firefoxPath !== undefined || options.firefoxSha256 !== undefined;
  if (verifyFirefox) {
    assert.ok(options.firefoxPath && options.firefoxSha256 && options.playwright.firefox, "Complete prepared Firefox runtime is required for Firefox mode checks");
    assert.match(options.firefoxSha256!, /^[a-f0-9]{64}$/);
  }
  const previousRuntime = process.env.ALIASMODE_PLAYWRIGHT_RUNTIME;
  process.env.ALIASMODE_PLAYWRIGHT_RUNTIME = resolve(options.runtimeRoot);
  const root = await mkdtemp(join(tmpdir(), "stakemode-proxy-acceptance-"));
  const store = new ProfileStore(join(root, "profiles.sqlite"));
  const launcher = new Launcher({ store, binaryPath: resolve(options.chromiumPath), expectedBinarySha256: options.chromiumSha256,
    firefoxBinaryPath: options.firefoxPath ? resolve(options.firefoxPath) : undefined, expectedFirefoxBinarySha256: options.firefoxSha256,
    dataRoot: join(root, "profiles"), headless: true, portRange: { start: 19400, end: 19499 },
    baseArgs: ["--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--metrics-recording-only"],
    labelWindow: async () => {}, cdpReadyTimeoutMs: 60_000, gracefulStopMs: 5_000 });
  const fixtures: ProxyFixture[] = [];
  const inspectors = new Set<any>();
  const launches: LaunchInfo[] = [];
  let cleanupConfirmed = false;
  let result: Omit<ProxyAcceptanceResult, "confirmedNativeCleanup"> | undefined;
  let localPage: ReturnType<typeof Bun.serve> | undefined;
  const stopProfile = async (id: string) => {
    const stopped = await launcher.stop(id);
    assert.equal(stopped, true, "Owned browser shutdown must be confirmed");
    assert.equal(store.getLaunch(id), null, "Stopped native launch must be removed");
  };
  const createProfile = (fixture: ProxyFixture, type: "http" | "socks5", wrong = false): Profile => {
    const profile = buildNewProfile({ name: `Local ${type} routing ${wrong ? "wrong-auth" : "valid-auth"}`,
      proxy: { type, host: "127.0.0.1", port: String(fixture.port), user: fixture.username, pass: fixture.password + (wrong ? "_incorrect" : "") }, screen: "1280x800" },
    (id) => store.getProfile(id) !== null || store.isTrashed(id));
    store.upsertProfile(profile); return profile;
  };
  const open = async (profile: Profile, networkMode: NetworkMode = "proxy") => {
    options.checkBudget?.();
    const opened = await launcher.start(profile.id, [], { headless: true, autoNavigate: false, restoreLastSession: false, networkMode });
    const launch = store.getLaunch(profile.id);
    assert.ok(launch && launch.headless === true, "Certified headless launch is required"); launches.push(launch);
    const browser = launch.engine === "firefox"
      ? await options.playwright.firefox!.connect((await callFirefoxOwner<{ endpoint: string }>(launch.firefoxOwner!, "playwright-endpoint", {}, { timeoutMs: 15_000 })).endpoint, { timeout: 20_000 })
      : await options.playwright.chromium.connectOverCDP(opened.ws, { timeout: 20_000 });
    inspectors.add(browser);
    const context = browser.contexts()[0]; assert.ok(context, "Real profile context is required");
    const page = await context.newPage();
    return { browser, page, launch };
  };
  try {
    options.checkBudget?.();
    const http = await startProxyFixture("http"); fixtures.push(http);
    const socks = await startProxyFixture("socks5"); fixtures.push(socks);
    const profiles = [createProfile(http, "http"), createProfile(socks, "socks5")];
    // Await every concurrent start even if one fails. Otherwise a late spawn
    // could outlive cleanup after Promise.all rejects on its first failure.
    const opening = await Promise.allSettled(profiles.map(profile => open(profile)));
    const failedOpen = opening.find((item) => item.status === "rejected");
    if (failedOpen?.status === "rejected") throw failedOpen.reason;
    const opened = opening.map((item) => { assert.equal(item.status, "fulfilled"); return (item as PromiseFulfilledResult<Awaited<ReturnType<typeof open>>>).value; });
    assert.notEqual(opened[0]!.launch.userDataDir, opened[1]!.launch.userDataDir, "Each profile must own a different persistent directory");
    assert.ok(opened.every((item) => Number.isSafeInteger(item.launch.relayPort) && item.launch.relayPort! > 0), "Authenticated profiles require managed local relays");
    assert.notEqual(opened[0]!.launch.relayPort, opened[1]!.launch.relayPort, "Profiles must have independent authenticated relay endpoints");
    const bodies = await Promise.all(opened.map(async (item) => {
      const reply = await item.page.goto(FIXTURE_URL, { timeout: 15_000, waitUntil: "domcontentloaded" });
      assert.equal(reply?.status(), 200, "Only the authenticated local fixture may answer this page");
      assert.equal(item.page.url(), FIXTURE_URL, "No navigation redirect is permitted");
      return await item.page.locator("body").innerText();
    }));
    assert.deepEqual(bodies, [http.marker, socks.marker], "Browser pages must use their own configured proxy");
    assert.ok(http.successes >= 1 && socks.successes >= 1, "Both proxy fixtures must observe browser requests");
    assert.ok([...http.targets, ...socks.targets].every(permittedTarget), "Successful traffic must remain inside the reserved local fixture");
    await disconnectInspector(opened[0]!.browser); inspectors.delete(opened[0]!.browser);
    assert.equal(await opened[1]!.page.locator("body").innerText(), socks.marker,
      "Disconnecting one CDP attachment must preserve the unrelated profile's client");
    await disconnectInspector(opened[1]!.browser); inspectors.delete(opened[1]!.browser);
    await Promise.all(profiles.map((profile) => stopProfile(profile.id)));
    for (const [fixture, protocol] of [[http, "http"], [socks, "socks5"]] as const) {
      options.checkBudget?.();
      const profile = createProfile(fixture, protocol, true), initialSuccesses = fixture.successes;
      const bad = await open(profile);
      let successful = false;
      try {
        const reply = await bad.page.goto(FIXTURE_URL, { timeout: 10_000, waitUntil: "domcontentloaded" });
        successful = !!reply?.ok();
      } catch { /* Wrong upstream credentials must prevent a successful page. */ }
      assert.equal(successful, false, `Wrong ${protocol} credentials must block browser navigation`);
      assert.equal(fixture.successes, initialSuccesses, "Wrong credentials must not obtain the fixture response");
      assert.ok(fixture.authenticationFailures > 0, "The fixture must record a refused authentication attempt");
      await disconnectInspector(bad.browser); inspectors.delete(bad.browser);
      await stopProfile(profile.id);
    }
    const modeMarker = `local-mode-${randomBytes(8).toString("hex")}`;
    localPage = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/mode"
      ? new Response(modeMarker, { headers: { "content-type": "text/plain", "cache-control": "no-store" } }) : new Response("Not found", { status: 404 }) });
    const modeUrl = `http://127.0.0.1:${localPage.port}/mode`;
    for (const mode of ["direct", "system"] as const) {
      options.checkBudget?.();
      const profile = createProfile(http, "http"), savedProxy = structuredClone(profile.proxy);
      const instance = await open(profile, mode);
      assert.equal(instance.launch.relayPort, undefined, "An inactive saved proxy must not create an application relay");
      const records = await readResourceSnapshot();
      assert.ok(records, "Native mode verification requires a process ownership snapshot");
      const record = ownedRoot(instance.launch, records, true); assert.ok(record, "Mode browser must have exact native process ownership");
      const args = record.argv ?? windowsArgv(record.commandLine ?? "");
      assert.equal(args.includes("--no-proxy-server"), mode === "direct", "Direct mode alone must explicitly bypass system browser proxies");
      assert.equal(args.some(arg => arg.startsWith("--proxy-server=")), false, "Direct/system modes must not use the inactive saved proxy");
      const reply = await instance.page.goto(modeUrl, { timeout: 15_000, waitUntil: "domcontentloaded" });
      assert.equal(reply?.status(), 200); assert.equal(await instance.page.locator("body").innerText(), modeMarker);
      assert.deepEqual(store.getProfile(profile.id)?.proxy, savedProxy, "Mode changes must preserve saved proxy credentials");
      await disconnectInspector(instance.browser); inspectors.delete(instance.browser); await stopProfile(profile.id);
    }
    if (verifyFirefox) {
      for (const mode of ["direct", "system"] as const) {
        options.checkBudget?.();
        const profile = buildNewProfile({ engine: "firefox", name: `Local Firefox ${mode} mode`, screen: "1280x800",
          proxy: { type: "http", host: "127.0.0.1", port: String(http.port), user: http.username, pass: http.password } }, id => !!store.getProfile(id));
        store.upsertProfile(profile);
        const instance = await open(profile, mode);
        assert.equal(instance.launch.relayPort, undefined, "Firefox direct/system mode must not activate the saved app proxy");
        const prefs = await readFile(join(instance.launch.userDataDir!, "user.js"), "utf8");
        const value = prefs.match(/user_pref\("network\.proxy\.type",\s*(\d+)\s*\);/)?.[1];
        assert.equal(value, mode === "direct" ? "0" : "5", "Native Firefox must receive its explicit direct/system preference");
        const reply = await instance.page.goto(modeUrl, { timeout: 15_000, waitUntil: "domcontentloaded" });
        assert.equal(reply?.status(), 200); assert.equal(await instance.page.locator("body").innerText(), modeMarker);
        assert.deepEqual(store.getProfile(profile.id)?.proxy, profile.proxy, "Firefox mode changes preserve saved proxy authentication");
        await disconnectInspector(instance.browser); inspectors.delete(instance.browser); await stopProfile(profile.id);
      }
    }
    result = { independentRouting: true, http: { authenticated: true, marker: http.marker, requestCount: http.successes },
      socks5: { authenticated: true, marker: socks.marker, requestCount: socks.successes, remoteDns: true },
      wrongCredentials: { http: true, socks5: true }, separateProfileDirectories: true, separateRelayPorts: true,
      networkModes: { direct: { savedProxyIgnored: true, noProxyArgument: true, loopbackPageLoaded: true },
        system: { savedProxyIgnored: true, browserProxyOverrideAbsent: true, loopbackPageLoaded: true },
        ...(verifyFirefox ? { firefoxPrefs: { direct: 0 as const, system: 5 as const, loopbackPageLoaded: true as const } } : {}) } };
  } finally {
    const disconnected = await Promise.allSettled([...inspectors].map(disconnectInspector));
    try {
      // Retain provisional/failure generations as well as successful launches.
      for (const launch of store.listLaunches()) if (!launches.some((item) => item.profileId === launch.profileId && item.startedAt === launch.startedAt)) launches.push(launch);
      const stopped = await Promise.all(store.listLaunches().map((launch) => launcher.stop(launch.profileId).catch(() => false)));
      assert.ok(stopped.every(Boolean) && store.listLaunches().length === 0, "Native proxy acceptance cleanup must not leave an unconfirmed browser");
      const records = await readResourceSnapshot();
      assert.ok(records, "Final native process ownership snapshot is required");
      assert.equal(launches.some((launch) => records.some((record) => record.pid === launch.pid)), false, "No acceptance browser root PID may remain present after cleanup");
      cleanupConfirmed = true;
      assert.ok(disconnected.every((item) => item.status === "fulfilled"), "Every remaining CDP inspector must disconnect without closing the shared driver");
    } finally {
      const closures = await Promise.allSettled(fixtures.map((fixture) => fixture.close()));
      localPage?.stop(true);
      store.close();
      if (previousRuntime === undefined) delete process.env.ALIASMODE_PLAYWRIGHT_RUNTIME;
      else process.env.ALIASMODE_PLAYWRIGHT_RUNTIME = previousRuntime;
      if (cleanupConfirmed) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      assert.ok(closures.every((closure) => closure.status === "fulfilled"), "Local proxy sockets must close within their bounded cleanup");
    }
  }
  assert.ok(result && cleanupConfirmed, "Proxy acceptance did not finish its verified cleanup");
  return { ...result, confirmedNativeCleanup: true };
}
