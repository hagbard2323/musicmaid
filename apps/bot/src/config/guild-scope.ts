/** Pure scope checks shared by production wiring and reusable state-machine tests. */
export function validateConfiguredGuildId(value: unknown): string {
  if (typeof value !== "string" || !/^\d{5,22}$/.test(value.trim())) throw new Error("DISCORD_GUILD_ID must identify the single Discord server served by this MusicMaid installation.");
  return value.trim();
}

export function assertGuildScope(actualGuildId: string | null | undefined, allowedGuildId?: string): void {
  if (allowedGuildId !== undefined && actualGuildId !== allowedGuildId) throw new Error("This MusicMaid instance only serves its configured server.");
}
