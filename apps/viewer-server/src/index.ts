import { resolve } from "node:path";
import { createViewerServer } from "./server.js";
const clientId = process.env.DISCORD_CLIENT_ID ?? "", clientSecret = process.env.DISCORD_CLIENT_SECRET ?? "";
const publicOrigin = process.env.VIEWER_PUBLIC_ORIGIN ?? "";
const port = Number(process.env.VIEWER_PORT ?? 18080);
if (!/^\d{5,22}$/.test(clientId) || !clientSecret || !/^https:\/\/[a-z0-9.-]+$/i.test(publicOrigin) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Viewer configuration is incomplete. Run configure-viewer.sh.");
const server = createViewerServer({ clientId, clientSecret, publicOrigin, socketPath: process.env.VIEWER_SOCKET ?? "/run/musicmaid-viewer/reader.sock", assetsDir: resolve(process.env.VIEWER_ASSETS ?? "dist/viewer") });
server.listen(port, "127.0.0.1", () => console.info("MusicMaid optional viewer ready."));
function close() { server.closeAllConnections(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.once("SIGTERM", close); process.once("SIGINT", close);
