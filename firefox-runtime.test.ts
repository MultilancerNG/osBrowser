import { expect, test } from "bun:test";
import { createServer, type RequestListener } from "node:http";
import {
  callFirefoxOwner,
  firefoxEndpoint,
  firefoxOwnerReady,
  forgetFirefoxOwner,
  getFirefoxOwnerDiagnostics,
  reserveFirefoxOwner,
  type FirefoxOwner,
} from "./firefox-runtime.ts";
import { PLAYWRIGHT_MAX_MESSAGE_BYTES, runPlaywrightWorker } from "./playwright-runtime.ts";
import { firefoxLaunchOptions, observedFirefoxCaptureUrl } from "./firefox-worker.mjs";

async function ownerServer(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const owner: FirefoxOwner = {
    endpoint: `http://127.0.0.1:${address.port}/`,
    token: "private-owner-token",
    generation: "generation-1",
    pid: 12,
    browserPid: 34,
  };
  return { server, owner };
}

test("Firefox owner passes native proxy preferences", () => {
  const proxy = { server: "http://proxy.example:8080" };
  expect(firefoxLaunchOptions({ executablePath: "firefox.exe", proxy })).toMatchObject({
    executablePath: "firefox.exe",
    viewport: null,
    proxy,
    firefoxUserPrefs: {
      "media.peerconnection.ice.proxy_only": true,
      "media.peerconnection.ice.default_address_only": true,
      "media.peerconnection.ice.no_host": true,
    },
  });
  expect(firefoxLaunchOptions({ executablePath: "firefox.exe", proxy })).not.toHaveProperty("firefoxUserPrefs.browser.startup.page");
  expect(firefoxLaunchOptions({ executablePath: "firefox.exe" }).firefoxUserPrefs).toEqual({
    "media.peerconnection.ice.default_address_only": true,
    "fission.webContentIsolationStrategy": 1,
  });
});

test("Firefox owner excludes its temporary fingerprint page from capture history", () => {
  expect(observedFirefoxCaptureUrl("https://fingerprint.aliasmode.invalid/?__aliasmode_fingerprint__=1")).toBeUndefined();
  expect(observedFirefoxCaptureUrl("http://aliasmode-fixture.test:8080/first")?.origin).toBe("http://aliasmode-fixture.test:8080");
  expect(observedFirefoxCaptureUrl("about:blank")).toBeUndefined();
});

test("Firefox owner preserves pre-readiness worker error codes", () => {
  const error = (() => {
    try {
      firefoxOwnerReady({ version: 1, ok: false, error: { code: "runtime_unavailable" } });
    } catch (failure) {
      return failure;
    }
  })();
  expect(error).toMatchObject({ name: "FirefoxOwnerError", code: "runtime_unavailable", message: "Firefox owner failed before ready" });
});

test("Firefox owner endpoints are opaque and route worker operations privately", async () => {
  let authorization = "";
  let request: any;
  const { server, owner } = await ownerServer(async (incoming, response) => {
    authorization = incoming.headers.authorization ?? "";
    request = JSON.parse(await new Response(incoming as any).text());
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: 1, ok: true, result: { injected: true } }));
  });
  try {
    const endpoint = firefoxEndpoint(owner);
    expect(endpoint).toBe(`firefox://127.0.0.1:${new URL(owner.endpoint).port}/generation-1`);
    expect(endpoint).not.toContain(owner.token);
    await expect(runPlaywrightWorker<{ injected: boolean }>("ensure-cookies", {
      endpoint,
      cookies: [],
    })).resolves.toEqual({ injected: true });
    expect(authorization).toBe(`Bearer ${owner.token}`);
    expect(request).toEqual({
      version: 1,
      operation: "ensure-cookies",
      payload: { endpoint, cookies: [], ownerGeneration: owner.generation },
    });
  } finally {
    forgetFirefoxOwner(owner);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Firefox owner forwards RPC details to worker callers", async () => {
  const { server, owner } = await ownerServer((_incoming, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      version: 1,
      ok: false,
      error: { code: "operation_failed", message: "capture failed", details: { operation: "origin_storage", outcome: "failure" } },
    }));
  });
  try {
    const endpoint = firefoxEndpoint(owner);
    const error = await runPlaywrightWorker("session-capture", { endpoint, captureSeed: { origins: [] } })
      .then(() => null, (failure) => failure);
    expect(error).toMatchObject({
      code: "operation_failed",
      details: { operation: "origin_storage", outcome: "failure" },
    });
  } finally {
    forgetFirefoxOwner(owner);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Firefox owner honors caller-provided RPC timeouts", async () => {
  const { server, owner } = await ownerServer(() => {});
  try {
    const endpoint = firefoxEndpoint(owner);
    const error = await runPlaywrightWorker("session-capture", {
      endpoint,
      captureSeed: { origins: [] },
    }, { timeoutMs: 1 }).then(() => null, (failure) => failure);
    expect(error).toMatchObject({ code: "timeout" });
    await expect(callFirefoxOwner(owner, "status", {}, { timeoutMs: 1 })).rejects.toMatchObject({ code: "timeout" });
  } finally {
    forgetFirefoxOwner(owner);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Firefox owner reservations keep tokens out of their endpoint", async () => {
  const reservation = await reserveFirefoxOwner();
  expect(reservation.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  expect(reservation.endpoint).not.toContain(reservation.token);
  expect(reservation.generation).not.toContain(reservation.token);
});

test("Firefox RPC diagnostics retain only fixed categories and observed byte counts", async () => {
  const privateValue = "private-payload-and-response-秘密";
  const body = JSON.stringify({ version: 1, ok: true, result: privateValue });
  let requests = 0;
  const { server, owner } = await ownerServer((_incoming, response) => {
    requests++;
    response.writeHead(200, { "content-type": "application/json; private-header=secret-value" });
    response.end(body);
  });
  try {
    await expect(callFirefoxOwner(owner, privateValue, { secret: privateValue }, { timeoutMs: 800 })).resolves.toBe(privateValue);
    const diagnostic = getFirefoxOwnerDiagnostics().at(-1)!;
    expect(diagnostic).toMatchObject({ transport: "http", operation: "other", phase: "complete", outcome: "ok",
      timeoutMs: 800, httpStatus: 200, contentType: "json", bodyBytes: Buffer.byteLength(body) });
    expect(diagnostic.startedAt).toBeGreaterThan(0);
    expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(diagnostic).sort()).toEqual(["sequence", "startedAt", "elapsedMs", "transport", "operation", "phase",
      "outcome", "timeoutMs", "httpStatus", "contentType", "bodyBytes"].sort());
    for (const secret of [owner.endpoint, owner.token, owner.generation, privateValue, "private-header", "secret-value"]) {
      expect(JSON.stringify(diagnostic)).not.toContain(secret);
    }
    diagnostic.operation = "close";
    diagnostic.bodyBytes = -1;
    expect(getFirefoxOwnerDiagnostics().at(-1)).toMatchObject({ operation: "other", bodyBytes: Buffer.byteLength(body) });
    expect(requests).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Firefox RPC diagnostics distinguish malformed JSON, protocol, remote errors and HTTP errors without retry", async () => {
  const cases = [
    { status: 502, type: "text/html; secret=private-mime", body: "<h1>private-response-body</h1>", outcome: "invalid-json", phase: "json", category: "html", code: "invalid_response" },
    { status: 204, type: "application/json", body: "", outcome: "invalid-json", phase: "json", category: "json", code: "invalid_response" },
    { status: 200, type: "text/plain", body: JSON.stringify({ version: 2, ok: true }), outcome: "invalid-protocol", phase: "protocol", category: "text", code: "invalid_response" },
    { status: 400, type: "application/problem+json", body: JSON.stringify({ version: 1, ok: false, error: { code: "timeout", message: "private-remote-message" } }), outcome: "remote-timeout", phase: "remote", category: "json", code: "timeout" },
    { status: 401, type: "application/octet-stream", body: JSON.stringify({ version: 1, ok: false, error: { code: "runtime_unavailable", details: { secret: "private-remote-details" } } }), outcome: "remote-error", phase: "remote", category: "binary", code: "runtime_unavailable" },
    { status: 500, type: "application/x-private-mime", body: JSON.stringify({ version: 1, ok: true, result: null }), outcome: "http-error", phase: "protocol", category: "other", code: "operation_failed" },
  ];
  let current = cases[0]!, requests = 0;
  const { server, owner } = await ownerServer((_incoming, response) => {
    requests++;
    response.writeHead(current.status, { "content-type": current.type }); response.end(current.body);
  });
  try {
    for (const value of cases) {
      current = value;
      await expect(callFirefoxOwner(owner, "status", {}, { timeoutMs: 800 })).rejects.toMatchObject({ code: value.code });
      const diagnostic = getFirefoxOwnerDiagnostics().at(-1)!;
      expect(diagnostic).toMatchObject({ operation: "status", phase: value.phase, outcome: value.outcome,
        timeoutMs: 800, httpStatus: value.status, contentType: value.category, bodyBytes: Buffer.byteLength(value.body) });
      expect(JSON.stringify(diagnostic)).not.toContain("private");
    }
    expect(requests).toBe(cases.length);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Firefox RPC diagnostics expose an active 800ms status probe and preserve its timeout category", async () => {
  let received!: () => void;
  const incoming = new Promise<void>(resolve => { received = resolve; });
  let requests = 0;
  const { server, owner } = await ownerServer(() => { requests++; received(); });
  try {
    const task = callFirefoxOwner(owner, "status", {}, { timeoutMs: 800 }).then(() => null, error => error);
    await incoming;
    expect(getFirefoxOwnerDiagnostics().at(-1)).toMatchObject({ operation: "status", phase: "request", outcome: "running",
      timeoutMs: 800, httpStatus: null, contentType: "missing", bodyBytes: 0 });
    expect(await task).toMatchObject({ code: "timeout", message: "Firefox owner operation timed out" });
    const diagnostic = getFirefoxOwnerDiagnostics().at(-1)!;
    expect(diagnostic).toMatchObject({ operation: "status", phase: "request", outcome: "caller-timeout", timeoutMs: 800,
      httpStatus: null, bodyBytes: 0 });
    expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(700);
    expect(requests).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Firefox RPC diagnostics distinguish a body-read timeout from a caller abort", async () => {
  const prefix = '{"version":1,"private-body":"';
  let received!: () => void;
  let incoming = new Promise<void>(resolve => { received = resolve; });
  const { server, owner } = await ownerServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "application/json" }); response.write(prefix); received();
  });
  try {
    const task = callFirefoxOwner(owner, "playwright-endpoint", {}, { timeoutMs: 100 }).then(() => null, error => error);
    await incoming;
    expect(await task).toMatchObject({ code: "timeout" });
    expect(getFirefoxOwnerDiagnostics().at(-1)).toMatchObject({ operation: "playwright-endpoint", phase: "body",
      outcome: "caller-timeout", timeoutMs: 100, httpStatus: 200, contentType: "json", bodyBytes: Buffer.byteLength(prefix) });
    incoming = new Promise<void>(resolve => { received = resolve; });
    const controller = new AbortController();
    const aborted = callFirefoxOwner(owner, "session-capture", {}, { signal: controller.signal, timeoutMs: 1000 }).then(() => null, error => error);
    await incoming;
    controller.abort(new Error("private-abort-reason"));
    expect(await aborted).toMatchObject({ code: "runtime_unavailable" });
    expect(getFirefoxOwnerDiagnostics().at(-1)).toMatchObject({ operation: "session-capture", outcome: "caller-abort", timeoutMs: 1000 });
    expect(JSON.stringify(getFirefoxOwnerDiagnostics().at(-1))).not.toContain("private");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Firefox RPC diagnostics retain bounded response overflow evidence", async () => {
  const { server, owner } = await ownerServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(Buffer.alloc(PLAYWRIGHT_MAX_MESSAGE_BYTES + 1, 97));
  });
  try {
    await expect(callFirefoxOwner(owner, "session-capture", {}, { timeoutMs: 5000 })).rejects.toMatchObject({ code: "invalid_response" });
    const diagnostic = getFirefoxOwnerDiagnostics().at(-1)!;
    expect(diagnostic).toMatchObject({ operation: "session-capture", phase: "body", outcome: "response-overflow", httpStatus: 200, contentType: "json" });
    expect(diagnostic.bodyBytes).toBeGreaterThan(PLAYWRIGHT_MAX_MESSAGE_BYTES);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Firefox RPC diagnostic history is bounded and never retains invalid operation values", async () => {
  const owner: FirefoxOwner = { endpoint: "http://127.0.0.1:1/", token: "private-token", generation: "private-generation", pid: 1, browserPid: 2 };
  const previous = getFirefoxOwnerDiagnostics().at(-1)?.sequence ?? 0;
  for (let index = 0; index < 140; index++) {
    await expect(callFirefoxOwner(owner, `private-operation-${index}`, null)).rejects.toMatchObject({ code: "invalid_request" });
  }
  const diagnostics = getFirefoxOwnerDiagnostics();
  expect(diagnostics).toHaveLength(128);
  expect(diagnostics[0]!.sequence).toBe(previous + 13);
  expect(diagnostics.at(-1)!.sequence).toBe(previous + 140);
  expect(diagnostics.every(value => value.operation === "other" && value.phase === "request-validation"
    && value.outcome === "invalid-request" && value.bodyBytes === 0 && value.httpStatus === null)).toBe(true);
  expect(JSON.stringify(diagnostics)).not.toContain("private");
});
