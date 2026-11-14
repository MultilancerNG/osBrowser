import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DESKTOP_PROTOCOL,
  DesktopCredentialBridge,
  ManagedDesktopRuntime,
  agentControlNonce,
  desktopHealthMetadata,
  desktopReadyRecord,
  isDesktopShutdownCommand,
} from "./desktop-runtime.ts";

const NONCE = "ab".repeat(32);

function admission(inFlight = 0, queued = 0): any {
  return { stats: () => ({ inFlight, queued }) };
}

test("desktop health metadata requires a nonce, version, and root", () => {
  expect(desktopHealthMetadata({}, undefined)).toBeNull();
  expect(desktopHealthMetadata({
    ALIASMODE_DESKTOP_NONCE: NONCE,
    ALIASMODE_DESKTOP_VERSION: "0.1.0-beta.1",
  }, "C:\\Users\\me\\AppData\\Roaming\\com.aliasmode.desktop")).toEqual({
    instance: NONCE,
    version: "0.1.0-beta.1",
    root: "C:\\Users\\me\\AppData\\Roaming\\com.aliasmode.desktop",
  });
  expect(() => desktopHealthMetadata({
    ALIASMODE_DESKTOP_NONCE: "not-a-nonce",
    ALIASMODE_DESKTOP_VERSION: "0.1.0-beta.1",
  }, "root")).toThrow("64 lowercase hexadecimal");
});

test("agent control uses a separate validated desktop nonce", () => {
  expect(agentControlNonce({})).toBeNull();
  expect(agentControlNonce({ ALIASMODE_AGENT_NONCE: NONCE })).toBe(NONCE);
  expect(() => agentControlNonce({ ALIASMODE_AGENT_NONCE: "invalid" }))
    .toThrow("ALIASMODE_AGENT_NONCE");
});

test("desktop readiness is emitted only for a valid owned port and pid", () => {
  expect(desktopReadyRecord(NONCE, 49_152, 42)).toEqual({
    protocol: DESKTOP_PROTOCOL,
    event: "ready",
    nonce: NONCE,
    pid: 42,
    port: 49_152,
  });
  expect(() => desktopReadyRecord(NONCE, 0, 42)).toThrow("port is invalid");
  expect(() => desktopReadyRecord(NONCE, 49_152, 0)).toThrow("pid is invalid");
});

test("desktop control accepts only the fixed nonce-bound shutdown command", () => {
  const valid = JSON.stringify({ protocol: DESKTOP_PROTOCOL, command: "shutdown", nonce: NONCE });
  expect(isDesktopShutdownCommand(valid, NONCE)).toBe(true);
  expect(isDesktopShutdownCommand(JSON.stringify({ protocol: DESKTOP_PROTOCOL, command: "shutdown", nonce: "cd".repeat(32) }), NONCE)).toBe(false);
  expect(isDesktopShutdownCommand(JSON.stringify({ protocol: DESKTOP_PROTOCOL, command: "run", nonce: NONCE }), NONCE)).toBe(false);
  expect(isDesktopShutdownCommand("not json", NONCE)).toBe(false);
});

test("desktop control gracefully shuts down when the parent stdin pipe closes", () => {
  const source = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
  expect(source).toContain('process.stdin.once("end", shutdown);');
  expect(source).toContain('process.stdin.once("close", shutdown);');
});

test("desktop Cloud automation API receives the shared Cloud browser lifecycle", () => {
  const source = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
  const cloudStart = source.indexOf('if (configuredMode.mode === "cloud")');
  const automationStart = source.indexOf("serveDesktopAutomationApi({", cloudStart);
  const automationEnd = source.indexOf("})", automationStart);
  const automationSetup = source.slice(automationStart, automationEnd);
  expect(automationSetup).toContain("cloudBrowser,");
});

test("desktop credential bridge waits for a nonce-bound parent acknowledgement", async () => {
  const output: string[] = [];
  const bridge = new DesktopCredentialBridge(NONCE, (line) => { output.push(line); });
  const stored = bridge.persistRefreshToken("rotated-refresh");
  const request = JSON.parse(output[0]!) as { request: number };
  expect(bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: "cd".repeat(32),
    request: request.request,
    ok: true,
  }))).toBe(false);
  expect(bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: NONCE,
    request: request.request,
    ok: true,
  }))).toBe(true);
  await stored;
});

test("desktop credential bridge surfaces Credential Manager rejection", async () => {
  const output: string[] = [];
  const bridge = new DesktopCredentialBridge(NONCE, (line) => { output.push(line); });
  const stored = bridge.persistRefreshToken("rotated-refresh");
  const request = JSON.parse(output[0]!) as { request: number };
  bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: NONCE,
    request: request.request,
    ok: false,
  }));
  await expect(stored).rejects.toThrow("Credential Manager rejected");
});

test("desktop credential bridge clears refresh and device credentials", async () => {
  const output: string[] = [];
  const bridge = new DesktopCredentialBridge(NONCE, (line) => { output.push(line); });
  const cleared = bridge.clearCloudSessionCredentials();
  const refresh = JSON.parse(output[0]!) as { request: number; event: string; key: string };
  expect(refresh).toMatchObject({ event: "credential-delete", key: "refresh_token" });
  bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: NONCE,
    request: refresh.request,
    ok: true,
  }));
  await Promise.resolve();
  const device = JSON.parse(output[1]!) as { request: number; event: string; key: string };
  expect(device).toMatchObject({ event: "credential-delete", key: "device_credential" });
  bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: NONCE,
    request: device.request,
    ok: true,
  }));
  await cleared;
  expect(output.map((line) => JSON.parse(line).key)).toEqual(["refresh_token", "device_credential"]);
  expect(output.join("\n")).not.toContain("queue_encryption_key");
});

test("desktop credential bridge attempts both Cloud credential deletes after one rejection", async () => {
  const output: string[] = [];
  const bridge = new DesktopCredentialBridge(NONCE, (line) => { output.push(line); });
  const cleared = bridge.clearCloudSessionCredentials();
  expect(output).toHaveLength(2);
  const requests = output.map((line) => JSON.parse(line) as { request: number; key: string });
  for (const request of requests) {
    bridge.handleLine(JSON.stringify({
      protocol: DESKTOP_PROTOCOL,
      event: "credential-result",
      nonce: NONCE,
      request: request.request,
      ok: request.key === "device_credential",
    }));
  }
  await expect(cleared).rejects.toThrow("could not clear Cloud credentials");
  expect(requests.map((request) => request.key)).toEqual(["refresh_token", "device_credential"]);
  expect(output.join("\n")).not.toContain("queue_encryption_key");
});

test("desktop shutdown coalesces and closes both listeners before authoritative local launches", async () => {
  const events: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { events.push("dashboard"); } },
    automationServer: { stop: async () => { events.push("automation"); } },
    admission: admission(),
    store: {
      listLaunches: () => [{ profileId: "one" }, { profileId: "two" }],
      close: () => { events.push("store"); },
    },
    launcher: { stop: async (id) => { events.push(`stop:${id}`); return true; } },
    stopInbox: () => { events.push("inbox"); },
  });

  const first = runtime.shutdown();
  const second = runtime.shutdown();
  expect(first).toBe(second);
  await first;
  expect(events.slice(0, 2).sort()).toEqual(["automation", "dashboard"]);
  expect(events.slice(2)).toEqual(["inbox", "stop:one", "stop:two", "store"]);
});

test("desktop shutdown stops script workers before browser capture and store close", async () => {
  const events: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { events.push("server"); }, stopScripts: async () => { events.push("scripts"); } },
    admission: admission(),
    store: { listLaunches: () => [{ profileId: "one" }], close: () => { events.push("store"); } },
    launcher: { stop: async () => { events.push("browser"); return true; } },
  });
  await runtime.shutdown();
  expect(events).toEqual(["server", "scripts", "browser", "store"]);
});

test("desktop shutdown attempts both listener stops when one fails", async () => {
  const events: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { events.push("dashboard"); } },
    automationServer: { stop: async () => { events.push("automation"); throw new Error("automation stop failed"); } },
    admission: admission(),
    store: { listLaunches: () => [], close: () => { events.push("store"); } },
    launcher: { stop: async () => true },
  });

  await expect(runtime.shutdown()).rejects.toThrow("automation stop failed");
  expect(events.slice(0, 2).sort()).toEqual(["automation", "dashboard"]);
  expect(events.at(-1)).toBe("store");
});

test("desktop shutdown delegates remote capture and release to the coordinator drain", async () => {
  const events: string[] = [];
  let remainingMs = 0;
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { events.push("server"); } },
    admission: admission(),
    store: { listLaunches: () => [], close: () => { events.push("store"); } },
    launcher: { stop: async () => { throw new Error("local stop must not run"); } },
    remoteShutdown: async (remaining) => { remainingMs = remaining; events.push("releaseAll"); },
  });
  await runtime.shutdown();
  expect(events).toEqual(["server", "releaseAll", "store"]);
  expect(remainingMs).toBeGreaterThan(0);
});

test("desktop shutdown attempts every local browser after one stop throws", async () => {
  const attempted: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => {} },
    admission: admission(),
    store: {
      listLaunches: () => [{ profileId: "one" }, { profileId: "two" }],
      close: () => {},
    },
    launcher: {
      stop: async (id) => {
        attempted.push(id);
        if (id === "one") throw new Error("stop failed");
        return true;
      },
    },
  });
  await expect(runtime.shutdown()).rejects.toThrow("browser teardown was not confirmed");
  expect(attempted).toEqual(["one", "two"]);
});

test("desktop shutdown fails closed when browser teardown is unconfirmed", async () => {
  let storeClosed = false;
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => {} },
    admission: admission(),
    store: { listLaunches: () => [{ profileId: "one" }], close: () => { storeClosed = true; } },
    launcher: { stop: async () => false },
  });
  await expect(runtime.shutdown()).rejects.toThrow("browser teardown was not confirmed");
  expect(storeClosed).toBe(true);
});

test("the Windows installer blocks running applications without terminating an image-name match", () => {
  const hooks = readFileSync(
    join(import.meta.dir, "src-tauri", "windows", "installer-hooks.nsh"),
    "utf8",
  );
  expect(hooks).toContain("!macro NSIS_HOOK_PREINSTALL");
  // Native installer acceptance also proves both app and sidecar sentinel
  // processes survive rejected installation. Keep the unsafe path out of hooks.
  expect(hooks).toContain("!macroundef CheckIfAppIsRunning");
  expect(hooks).toContain("FindProcessCurrentUser");
  expect(hooks).toContain("SetErrorLevel 2");
  expect(hooks).toContain("!macro NSIS_HOOK_PREUNINSTALL");
  expect(hooks).not.toMatch(/taskkill|::KillProcess/i);
});

test("the pinned NSIS template discovers additional plugins before compiling early hooks", () => {
  const directory = join(import.meta.dir, "src-tauri", "windows", "tauri-nsis");
  const template = readFileSync(join(directory, "installer.nsi"), "utf8");
  const provenance = JSON.parse(readFileSync(join(directory, "provenance.json"), "utf8"));
  const config = JSON.parse(readFileSync(join(import.meta.dir, "src-tauri", "tauri.conf.json"), "utf8"));
  const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const earlyRegistration = '; StakeMode modification: register unsigned plugins before hooks compile plugin calls.\n'
    + '; Exact upstream source and one-block relocation are recorded in NOTICE.md.\n'
    + '!addplugindir "{{additional_plugins_path}}"\n\n';
  expect(config.bundle.windows.nsis.template).toBe("windows/tauri-nsis/installer.nsi");
  expect(config.bundle.resources["windows/tauri-nsis/"]).toBe("notices/tauri-nsis/");
  expect(provenance.upstreamCommit).toBe("8909f221d1515955fc843808032bdc5d62209c96");
  expect(provenance.upstreamGitBlob).toBe("d372e3c391770cf231db974422a1e4f8adaac3a6");
  expect(provenance.upstreamSha256).toBe("20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079");
  expect(sha256(template)).toBe(provenance.modifiedSha256);
  expect(template.split(earlyRegistration)).toHaveLength(2);
  const registration = template.indexOf(earlyRegistration);
  expect(registration).toBeGreaterThan(template.indexOf('${StrLoc}'));
  expect(registration).toBeGreaterThan(template.indexOf('!addplugindir "{{signed_plugins_path}}"'));
  expect(registration).toBeLessThan(template.indexOf('!include "{{installer_hooks}}"'));
  expect(template.indexOf('!include "utils.nsh"')).toBeLessThan(template.indexOf('!include "{{installer_hooks}}"'));
  const original = template.replace(earlyRegistration, "").replace(
    "; Uninstaller signing command\n",
    '# additional plugins\n!addplugindir "${ADDITIONALPLUGINSPATH}"\n\n; Uninstaller signing command\n',
  );
  // This exact hash proves the plugin relocation is the complete template diff.
  expect(sha256(original)).toBe(provenance.upstreamSha256);
  expect(createHash("sha1").update(`blob ${Buffer.byteLength(original)}\0`).update(original).digest("hex"))
    .toBe(provenance.upstreamGitBlob);
  for (const filename of ["LICENSE_MIT", "LICENSE_APACHE-2.0"]) {
    expect(sha256(readFileSync(join(directory, filename)))).toBe(provenance.licenseSha256[filename]);
  }
});
