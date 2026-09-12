import "dotenv/config";
import { pathToFileURL } from "node:url";

export class ReadinessError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}
export async function checkServices({ base, auth, cipherUrl, requireHttp = false, fetcher = fetch }) {
  async function get(service, url, headers = {}) {
    let response;
    try { response = await fetcher(url, { headers, signal: AbortSignal.timeout(8000) }); }
    catch (error) { throw new ReadinessError(`${service} is starting or unreachable at ${url.host} (${error.cause?.code ?? error.name}).`); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ReadinessError(`${service} at ${url.host} returned HTTP ${response.status}. Check service identity and authentication.`, [401, 403, 404].includes(response.status) ? 2 : 1);
    }
    return response;
  }
  const response = await get("Lavalink", new URL("/v4/info", base), { Authorization: auth });
  let info;
  try { info = await response.json(); } catch { throw new ReadinessError("Lavalink returned an invalid readiness response.", 2); }
  if (info?.version?.semver !== "4.2.2" || !Array.isArray(info.plugins) || !info.plugins.some(p => p.name === "youtube-plugin" && p.version === "1.18.2")) throw new ReadinessError("Unexpected audio service versions. Check the installed Lavalink configuration.", 2);
  if (requireHttp && !info.sourceManagers?.includes("http")) throw new ReadinessError("Authenticated YouTube requires the configured HTTP audio source.", 2);
  const cipher = await get("Cipher", new URL("/metrics", cipherUrl));
  await cipher.body?.cancel();
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const base = new URL(process.env.LAVALINK_URL?.includes("://") ? process.env.LAVALINK_URL : "http://" + (process.env.LAVALINK_URL ?? "127.0.0.1:2333"));
    await checkServices({ base, auth: process.env.LAVALINK_AUTH ?? "youshallnotpass", cipherUrl: process.env.CIPHER_URL ?? "http://127.0.0.1:18001", requireHttp: Boolean(process.env.YOUTUBE_COOKIE_FILE) });
    console.log("Audio services are ready. Audible playback still requires the listening test.");
  } catch (error) {
    console.error(`Readiness: ${error.message}`);
    process.exitCode = error instanceof ReadinessError ? error.exitCode : 2;
  }
}
