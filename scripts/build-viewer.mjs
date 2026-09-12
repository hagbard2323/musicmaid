import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
await mkdir("dist/viewer", { recursive: true });
await build({ entryPoints: ["apps/viewer/src/app.ts"], outfile: "dist/viewer/app.js", bundle: true, format: "esm", platform: "browser", target: ["es2022"], minify: true, sourcemap: false, logLevel: "warning" });
await copyFile("apps/viewer/index.html", "dist/viewer/index.html");
