import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MusicStorage } from "../storage/types.js";
import { incident } from "../audio/diagnostics.js";
export const restartUnits = { bot: "audiobot.service", audio: "lavalink.service", cipher: "audiobot-cipher.service", viewer: "audiobot-viewer.service" } as const;
export type RestartTarget = keyof typeof restartUnits;
export function reserveRestart(store: MusicStorage, target: RestartTarget, userId: string, now = Date.now()): void {
  const previous = Number(store.getValue("last_service_restart") ?? 0);
  if (now - previous < 60_000) throw new Error("A service was restarted recently. Wait one minute before restarting another service.");
  store.setValue("last_service_restart", String(now));
  incident("mod_restart", { target, userId });
}
export async function restartService(target: RestartTarget): Promise<void> {
  if (target === "bot") { setTimeout(() => process.exit(0), 750); return; }
  // Fixed executable + fixed unit names. The polkit rule grants only these restart actions.
  await promisify(execFile)("/usr/bin/systemctl", ["--no-ask-password", "restart", restartUnits[target]], { timeout: 30_000 });
}
