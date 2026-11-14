import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_INSTALLED_MAIN_BYTES, verifyInstalledNsisFiles, verifyInstalledNsisMain } from "./stakemode-installed-integrity.ts";

const UNKNOWN = "__TAURI_BUNDLE_TYPE_VAR_UNK", NSIS = "__TAURI_BUNDLE_TYPE_VAR_NSS", MARKER_OFFSET = 640;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function image(marker = UNKNOWN): Buffer {
  const bytes = Buffer.alloc(1024);
  bytes.write("MZ"); bytes.writeUInt32LE(128, 0x3c); bytes.write("PE\0\0", 128, "ascii");
  bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(0x22, 150);
  const optional = 152, section = 392;
  bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(512, optional + 60); bytes.writeUInt32LE(16, optional + 108);
  bytes.write(".rdata", section, "ascii"); bytes.writeUInt32LE(512, section + 8); bytes.writeUInt32LE(4096, section + 12);
  bytes.writeUInt32LE(512, section + 16); bytes.writeUInt32LE(512, section + 20); bytes.writeUInt32LE(0x40000040, section + 36);
  bytes.write(marker, MARKER_OFFSET, "ascii"); return bytes;
}
test("the complete installed image must equal exactly the pinned NSIS marker replacement", () => {
  const compiled = image(), installed = image(NSIS), before = Buffer.from(compiled);
  const proof = verifyInstalledNsisMain(compiled, installed);
  expect(proof).toMatchObject({ passed: true, method: "exact-pinned-tauri-nsis-marker",
    source: { commit: "8909f221d1515955fc843808032bdc5d62209c96", cliVersion: "2.11.4", path: "crates/tauri-bundler/src/bundle.rs" },
    marker: { offset: MARKER_OFFSET, bytes: UNKNOWN.length, from: UNKNOWN, to: NSIS },
    compiled: { sha256: hash(compiled), bytes: 1024 }, expected: { sha256: hash(installed), bytes: 1024 },
    installed: { sha256: hash(installed), bytes: 1024 } });
  expect(compiled).toEqual(before);
  expect(proof.compiled.sha256).not.toBe(proof.installed.sha256);
});
test("a pristine installed image, other bundle types and every non-marker corruption fail", () => {
  for (const installed of [image(), image("__TAURI_BUNDLE_TYPE_VAR_MSI")]) {
    expect(() => verifyInstalledNsisMain(image(), installed)).toThrow("exact pinned NSIS payload");
  }
  for (const offset of [64, 511, MARKER_OFFSET - 1, MARKER_OFFSET + UNKNOWN.length, 1023]) {
    const installed = image(NSIS); installed[offset] = installed[offset]! ^ 1;
    expect(() => verifyInstalledNsisMain(image(), installed)).toThrow("exact pinned NSIS payload");
  }
  expect(() => verifyInstalledNsisMain(image(), Buffer.concat([image(NSIS), Buffer.from([0])]))).toThrow("exact pinned NSIS payload");
});
test("missing, duplicate or prepatched compiled UNKNOWN markers fail closed", () => {
  for (const marker of ["missing marker", NSIS, "__TAURI_BUNDLE_TYPE_VAR_MSI"]) {
    expect(() => verifyInstalledNsisMain(image(marker), image(NSIS))).toThrow("exactly one pristine");
  }
  const compiled = image(); compiled.write(UNKNOWN, 800, "ascii");
  expect(() => verifyInstalledNsisMain(compiled, image(NSIS))).toThrow("exactly one pristine");
});
test("legitimate bundle variant and prefix constants remain exact immutable image bytes", () => {
  const compiled = image();
  for (const [index, text] of [NSIS, "__TAURI_BUNDLE_TYPE_VAR_DEB", "__TAURI_BUNDLE_TYPE_VAR_MSI", "__TAURI_BUNDLE_TYPE_VAR_"].entries()) {
    compiled.write(text, 800 + index * 40, "ascii");
  }
  const installed = Buffer.from(compiled); installed.write(NSIS, MARKER_OFFSET, "ascii");
  expect(verifyInstalledNsisMain(compiled, installed).passed).toBe(true);
  for (const offset of [800, 840, 880, 920]) {
    const changed = Buffer.from(installed); changed[offset] = changed[offset]! ^ 1;
    expect(() => verifyInstalledNsisMain(compiled, changed)).toThrow("exact pinned NSIS payload");
  }
});
test("invalid x64 PE headers, section bounds, DLLs and truncated images are rejected", () => {
  const changes: Array<(bytes: Buffer) => void> = [
    b => { b[0] = 0; }, b => b.writeUInt32LE(0xffffffff, 0x3c), b => b.writeUInt32LE(0, 128),
    b => b.writeUInt16LE(0x14c, 132), b => b.writeUInt16LE(0, 134), b => b.writeUInt16LE(97, 134),
    b => b.writeUInt16LE(0, 148), b => b.writeUInt16LE(4097, 148), b => b.writeUInt16LE(0x2002, 150),
    b => b.writeUInt16LE(0, 150), b => b.writeUInt16LE(0x10b, 152), b => b.writeUInt32LE(16, 212),
    b => b.writeUInt32LE(2000, 212), b => b.writeUInt32LE(17, 260),
    b => b.writeUInt32LE(1024, 408), b => b.writeUInt32LE(0, 412),
  ];
  for (const mutate of changes) {
    const malformed = image(); mutate(malformed);
    expect(() => verifyInstalledNsisMain(malformed, image(NSIS))).toThrow("valid bounded Windows x64 PE");
  }
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(63), image().subarray(0, 900)]) {
    expect(() => verifyInstalledNsisMain(bytes, image(NSIS))).toThrow("valid bounded Windows x64 PE");
  }
});
test("bounded file verification reads exact inputs and CLI emits only redacted proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stakemode-integrity-"));
  try {
    const compiledPath = join(directory, "compiled.exe"), installedPath = join(directory, "installed.exe");
    await writeFile(compiledPath, image()); await writeFile(installedPath, image(NSIS));
    expect((await verifyInstalledNsisFiles(compiledPath, installedPath)).passed).toBe(true);
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./stakemode-installed-integrity.ts", import.meta.url)), compiledPath, installedPath],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(status).toBe(0); expect(stderr).toBe(""); expect(JSON.parse(stdout).passed).toBe(true);
    expect(stdout).not.toContain(directory); expect(stdout).not.toContain("compiled.exe");
    expect((await readFile(compiledPath)).equals(image())).toBe(true); expect((await readFile(installedPath)).equals(image(NSIS))).toBe(true);
    const oversized = await open(compiledPath, "r+"); try { await oversized.truncate(MAX_INSTALLED_MAIN_BYTES + 1); } finally { await oversized.close(); }
    await expect(verifyInstalledNsisFiles(compiledPath, installedPath)).rejects.toThrow("bounded regular-file policy");
    await expect(verifyInstalledNsisFiles(directory, installedPath)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("CLI rejects corruption and unreadable input without exposing paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stakemode-integrity-private-"));
  try {
    const compiledPath = join(directory, "compiled.exe"), installedPath = join(directory, "installed.exe");
    await writeFile(compiledPath, image()); const changed = image(NSIS); changed[1000] = changed[1000]! ^ 1; await writeFile(installedPath, changed);
    for (const path of [installedPath, join(directory, "secret-marker-do-not-print")]) {
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./stakemode-installed-integrity.ts", import.meta.url)), compiledPath, path],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(status).toBe(1); expect(stderr).toBe(""); const proof = JSON.parse(stdout); expect(proof.passed).toBe(false);
      expect(stdout).not.toContain(directory); expect(stdout).not.toContain("secret-marker-do-not-print");
      if (path === installedPath) { expect(proof.expected.sha256).toBe(hash(image(NSIS))); expect(proof.installed.sha256).toBe(hash(changed)); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
