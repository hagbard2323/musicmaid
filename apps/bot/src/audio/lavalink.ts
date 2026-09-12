import type { Client } from "discord.js";
import { Connectors, Shoukaku, type NodeOption } from "shoukaku";
import { env } from "../config/env.js";
import { incident, safeError } from "./diagnostics.js";
import { CancellableRest } from "./lavalink-rest.js";

let lavalink: Shoukaku | undefined;
let recoveryTimer: NodeJS.Timeout | undefined;
let lastNodeAddAttemptAt = 0;

const nodeAddThrottleMs = 10_000;
const recoveryIntervalMs = 15_000;

export function createLavalink(client: Client): Shoukaku {
  const shoukaku = new Shoukaku(
    new Connectors.DiscordJS(client),
    [createNodeOptions()],
    {
      resume: true,
      resumeTimeout: 120,
      resumeByLibrary: false,
      reconnectTries: 5,
      reconnectInterval: 5,
      restTimeout: 8,
      structures: { rest: CancellableRest },
      moveOnDisconnect: false,
      voiceConnectionTimeout: 15
    }
  );
  lavalink = shoukaku;

  shoukaku.on("ready", (name, lavalinkResume, libraryResume) => {
    console.log(
      `Lavalink node ready: ${name} (lavalinkResume=${lavalinkResume}, libraryResume=${libraryResume})`
    );
  });

  shoukaku.on("error", (name, error) => {
    incident("lavalink_error", { name, error: safeError(error) });
  });

  shoukaku.on("close", (name, code, reason) => {
    console.warn(`Lavalink node closed: ${name} (${code}) ${reason}`);
  });

  startLavalinkRecoveryLoop();

  return shoukaku;
}

export function getLavalink(): Shoukaku {
  if (!lavalink) {
    throw new Error("Lavalink has not been initialized yet.");
  }

  return lavalink;
}

export function ensureLavalinkNode(reason = "health check"): void {
  const shoukaku = getLavalink();
  const existingNode = shoukaku.nodes.get(env.lavalinkName);

  if (existingNode) {
    return;
  }

  const now = Date.now();

  if (now - lastNodeAddAttemptAt < nodeAddThrottleMs) {
    return;
  }

  lastNodeAddAttemptAt = now;
  console.warn(`Lavalink node missing; re-adding ${env.lavalinkName} (${reason}).`);
  shoukaku.addNode(createNodeOptions());
}

export function getLavalinkStatusLines(): string[] {
  const shoukaku = getLavalink();
  const nodes = [...shoukaku.nodes.values()];

  if (nodes.length === 0) {
    return [
      "Lavalink: no node registered",
      `Players: ${shoukaku.players.size}`,
      `Voice connections: ${shoukaku.connections.size}`
    ];
  }

  return [
    ...nodes.map((node) =>
      [
        `Lavalink ${node.name}: ${stateLabel(node.state)}`,
        `reconnects=${node.reconnects}`,
        `players=${shoukaku.players.size}`,
        `penalties=${node.penalties}`
      ].join(" | ")
    ),
    `Voice connections: ${shoukaku.connections.size}`
  ];
}

function createNodeOptions(): NodeOption {
  return {
    name: env.lavalinkName,
    url: env.lavalinkUrl,
    auth: env.lavalinkAuth,
    secure: false
  };
}

function startLavalinkRecoveryLoop(): void {
  if (recoveryTimer) {
    return;
  }

  recoveryTimer = setInterval(() => {
    try {
      ensureLavalinkNode("recovery loop");
    } catch (error) {
      incident("lavalink_reconnect_error", { error: safeError(error) });
    }
  }, recoveryIntervalMs);

  recoveryTimer.unref();
}

function stateLabel(state: number): string {
  switch (state) {
    case 0:
      return "connecting";
    case 1:
      return "connected";
    case 2:
      return "disconnecting";
    case 3:
      return "disconnected";
    default:
      return `unknown (${state})`;
  }
}
