import { randomUUID } from "node:crypto";

/** Short-lived, requester-bound state; IDs contain no URLs or credentials. */
export class InteractionState<T> {
  private entries = new Map<string, { owner: string; guildId: string; expires: number; value: T }>();
  constructor(private now: () => number = Date.now) {}
  create(owner: string, guildId: string, value: T, ttlMs = 120_000): string {
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(id);
    if (this.entries.size >= 500) throw new Error("Too many open menus. Try again in a moment.");
    const id = randomUUID(); this.entries.set(id, { owner, guildId, expires: this.now() + ttlMs, value }); return id;
  }
  read(id: string, owner: string, guildId: string, consume = false): T {
    const entry = this.entries.get(id);
    if (!entry || entry.expires <= this.now()) { this.entries.delete(id); throw new Error("This control expired. Open a fresh command or menu."); }
    if (entry.owner !== owner || entry.guildId !== guildId) throw new Error("Only the person who opened this menu can use it.");
    if (consume) this.entries.delete(id);
    return entry.value;
  }
}
export function parsePosition(input: string): number {
  if (!/^\d+(?::[0-5]\d){0,2}$/.test(input.trim())) throw new Error("Use seconds, mm:ss, or hh:mm:ss (for example 1:28).");
  return input.trim().split(":").reduce((total, part) => total * 60 + Number(part), 0) * 1000;
}
