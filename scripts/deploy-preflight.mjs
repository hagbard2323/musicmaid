import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// An occupied port is only acceptable when every listener belongs to the
// existing, systemd-managed MusicMaid cipher container being upgraded.
export function checkCipherPort(run = (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), port = 18001) {
  const listeners = run("ss", ["-H", "-ltnp", `( sport = :${port} )`]).trim();
  if (!listeners) return;
  const failure = new Error(`Cipher port ${port} is occupied by another service or its owner cannot be verified. Deployment stopped before changing services.`);
  try {
    const unit = run("podman", ["inspect", "--format", '{{index .Config.Labels "PODMAN_SYSTEMD_UNIT"}}', "audiobot-cipher"]).trim();
    if (unit !== "audiobot-cipher.service") throw failure;
    const owners = new Set(run("podman", ["top", "audiobot-cipher", "hpid"]).split(/\s+/).filter(value => /^\d+$/.test(value)));
    for (const line of listeners.split("\n")) {
      const pids = [...line.matchAll(/pid=(\d+)/g)].map(match => match[1]);
      if (!pids.length || pids.some(pid => !owners.has(pid))) throw failure;
    }
  } catch { throw failure; }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { checkCipherPort(); console.log("Preflight: cipher port 18001 is available or owned by MusicMaid."); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
