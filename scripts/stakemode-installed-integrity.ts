/** Exact unsigned NSIS payload verification for the pinned Tauri bundler. */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export const MAX_INSTALLED_MAIN_BYTES = 256 * 1024 * 1024;
const UNKNOWN = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK", "ascii");
const NSIS = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS", "ascii");
const SOURCE = Object.freeze({
  repository: "https://github.com/tauri-apps/tauri",
  commit: "8909f221d1515955fc843808032bdc5d62209c96",
  path: "crates/tauri-bundler/src/bundle.rs",
  cliVersion: "2.11.4",
});
export interface InstalledMainIntegrity {
  passed: boolean;
  method: "exact-pinned-tauri-nsis-marker";
  source: typeof SOURCE;
  marker: { offset: number; bytes: number; from: string; to: string };
  compiled: { sha256: string; bytes: number };
  expected: { sha256: string; bytes: number };
  installed: { sha256: string; bytes: number };
}
class IntegrityError extends Error {
  constructor(message: string, readonly verification?: InstalledMainIntegrity) { super(message); }
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Validate the bounded x64 executable headers, optional header and raw sections. */
function validatePe(bytes: Buffer): void {
  const fail = () => { throw new IntegrityError("Main executable is not a valid bounded Windows x64 PE image"); };
  if (bytes.length < 64 || bytes.length > MAX_INSTALLED_MAIN_BYTES || bytes.readUInt16LE(0) !== 0x5a4d) return fail();
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe > bytes.length - 24 || bytes.readUInt32LE(pe) !== 0x00004550) return fail();
  const count = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20), flags = bytes.readUInt16LE(pe + 22);
  const optional = pe + 24, sections = optional + optionalSize, sectionEnd = sections + count * 40;
  if (bytes.readUInt16LE(pe + 4) !== 0x8664 || count < 1 || count > 96 || !(flags & 2) || (flags & 0x2000)
    || optionalSize < 112 || optionalSize > 4096 || sectionEnd > bytes.length || bytes.readUInt16LE(optional) !== 0x20b) return fail();
  const headerSize = bytes.readUInt32LE(optional + 60), directories = bytes.readUInt32LE(optional + 108);
  if (headerSize < sectionEnd || headerSize > bytes.length || directories > Math.floor((optionalSize - 112) / 8)) return fail();
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < count; index++) {
    const section = sections + index * 40, size = bytes.readUInt32LE(section + 16), offset = bytes.readUInt32LE(section + 20);
    if (!size) continue;
    if (offset < headerSize || offset > bytes.length || size > bytes.length - offset) return fail();
    ranges.push([offset, offset + size]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (!ranges.length || ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1]![1])) return fail();
}

/** No marker masking: derive one complete expected image, then compare every byte. */
export function verifyInstalledNsisMain(compiled: Buffer, installed: Buffer): InstalledMainIntegrity {
  validatePe(compiled); validatePe(installed);
  const offset = compiled.indexOf(UNKNOWN);
  // Other full variant constants occur in Tauri's bundle_type() match arms.
  // They remain immutable bytes; only the one pristine UNKNOWN is replaced.
  if (offset < 0 || compiled.indexOf(UNKNOWN, offset + 1) !== -1 || UNKNOWN.length !== NSIS.length) {
    throw new IntegrityError("Compiled main must contain exactly one pristine Tauri bundle marker");
  }
  const after = offset + UNKNOWN.length;
  const expectedHash = createHash("sha256").update(compiled.subarray(0, offset)).update(NSIS).update(compiled.subarray(after)).digest("hex");
  const proof: InstalledMainIntegrity = {
    passed: false, method: "exact-pinned-tauri-nsis-marker", source: SOURCE,
    marker: { offset, bytes: UNKNOWN.length, from: UNKNOWN.toString("ascii"), to: NSIS.toString("ascii") },
    compiled: { sha256: sha256(compiled), bytes: compiled.length },
    expected: { sha256: expectedHash, bytes: compiled.length },
    installed: { sha256: sha256(installed), bytes: installed.length },
  };
  if (installed.length !== compiled.length || !compiled.subarray(0, offset).equals(installed.subarray(0, offset))
    || !NSIS.equals(installed.subarray(offset, after)) || !compiled.subarray(after).equals(installed.subarray(after))
    || proof.installed.sha256 !== proof.expected.sha256) {
    throw new IntegrityError("Installed main differs from the exact pinned NSIS payload", proof);
  }
  return { ...proof, passed: true };
}

async function readBoundedPe(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 64 || before.size > MAX_INSTALLED_MAIN_BYTES) {
      throw new IntegrityError("Main executable exceeds its bounded regular-file policy");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new IntegrityError("Main executable changed during integrity verification");
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) {
      throw new IntegrityError("Main executable changed during integrity verification");
    }
    return bytes;
  } finally { await file.close(); }
}
export async function verifyInstalledNsisFiles(compiledPath: string, installedPath: string): Promise<InstalledMainIntegrity> {
  const compiled = await readBoundedPe(compiledPath), installed = await readBoundedPe(installedPath);
  return verifyInstalledNsisMain(compiled, installed);
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 4) throw new IntegrityError("Expected compiled and installed main executable arguments");
    console.log(JSON.stringify(await verifyInstalledNsisFiles(process.argv[2]!, process.argv[3]!)));
  } catch (error) {
    // Never print filesystem errors, paths, arguments or arbitrary child output.
    console.log(JSON.stringify({ ...(error instanceof IntegrityError ? error.verification : undefined), passed: false,
      error: error instanceof IntegrityError ? error.message : "Main executable integrity verification could not read its inputs" }));
    process.exitCode = 1;
  }
}
