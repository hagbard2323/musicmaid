import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const rootFiles = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.viewer.json", "docker-compose.yml",
  "apps/viewer/index.html", "apps/spotify-stream/Cargo.toml", "apps/spotify-stream/Cargo.lock", "bin/SHA256SUMS"];
const directories = ["apps/bot/src", "apps/viewer/src", "apps/viewer-server/src", "apps/spotify-stream/src", "scripts", "deploy", "infra"];

/** Stable across git archives, platforms and directory enumeration order. */
export function sourceInputs(root) {
  const files = [];
  function collect(name) {
    const path = join(root, name);
    let info;
    try { info = lstatSync(path); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (info.isSymbolicLink()) throw new Error("Release inputs must not be symbolic links.");
    if (info.isDirectory()) {
      for (const child of readdirSync(path)) {
        if (child !== "__pycache__") collect(`${name}/${child}`);
      }
    } else if (info.isFile() && (!name.startsWith("scripts/") || /\.(mjs|py|sh|java)$/.test(name))) files.push(name);
  }
  [...rootFiles, ...directories].forEach(collect);
  return files.sort();
}

export function sourceHash(root) {
  return hash(sourceInputs(root).map(name => `${name}\0${hash(readFileSync(join(root, name)))}\n`).join(""));
}

export function validateManifest(root, manifest, requireClean = false) {
  if (manifest?.version !== 1 || !/^(unknown|[a-f0-9]{40})$/.test(manifest.revision) || typeof manifest.dirty !== "boolean"
    || !Number.isFinite(Date.parse(manifest.builtAt)) || !/^[a-f0-9]{64}$/.test(manifest.sourceHash)
    || manifest.dependencyHash !== hash(readFileSync(join(root, "package-lock.json")))) throw new Error("Release metadata or dependency lock does not match.");
  if (requireClean && (manifest.dirty || manifest.revision === "unknown")) throw new Error("Deployment requires a clean, committed release.");
  // A compiled-only bundle can report its original source digest without claiming to verify absent sources.
  if (existsSync(join(root, "apps/bot/src/index.ts")) && manifest.sourceHash !== sourceHash(root)) throw new Error("Release source inputs changed since the recorded build.");
  return manifest;
}

export function buildManifest(root) {
  const sourceDigest = sourceHash(root);
  const dependencyHash = hash(readFileSync(join(root, "package-lock.json")));
  let revision = "unknown", dirty = true;
  let isCheckout = false;
  try {
    isCheckout = resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) === resolve(root);
  } catch { /* Extracted releases carry their own checked manifest. */ }
  if (isCheckout) {
    revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const tracked = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" });
    const untracked = new Set(execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0"));
    dirty = Boolean(tracked.trim()) || sourceInputs(root).some(name => untracked.has(name));
  } else if (existsSync(join(root, "release-manifest.json"))) {
    return validateManifest(root, JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8")));
  }
  return { version: 1, revision, dirty, builtAt: new Date().toISOString(), dependencyHash, sourceHash: sourceDigest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[3] ?? dirname(dirname(fileURLToPath(import.meta.url))));
  if (process.argv[2] === "--check") {
    validateManifest(root, JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8")), true);
  } else {
    const manifest = buildManifest(root);
    const bytes = JSON.stringify(manifest, null, 2) + "\n";
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "release-manifest.json"), bytes);
    writeFileSync(join(root, "dist/release.json"), bytes);
    console.info(`Build revision ${manifest.revision}${manifest.dirty ? " (uncommitted changes)" : ""}.`);
  }
}
