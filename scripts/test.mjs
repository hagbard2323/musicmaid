import { readdir } from "node:fs/promises";
// Direct registration also works on hosts where the test runner's child-process
// isolation is restricted. node:test still owns execution, reporting and exit status.
const directory = new URL("../apps/bot/test/", import.meta.url);
const files = (await readdir(directory)).filter(name => name.endsWith(".test.ts")).sort();
if (!files.length) throw new Error("No tests found");
for (const file of files) await import(new URL(file, directory));
