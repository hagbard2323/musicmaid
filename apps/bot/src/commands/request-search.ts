export class SearchReplaced extends Error {
  constructor() { super("This search was replaced by your newer request."); }
}

/** Keep one active search per member and guild, including result presentation. */
export class MemberSearches {
  private current = new Map<string, AbortController>();
  async run<T>(guildId: string, memberId: string, search: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = `${guildId}:${memberId}`, previous = this.current.get(key);
    if (!previous && this.current.size >= 500) throw new Error("Music searches are busy. Try again shortly.");
    previous?.abort(new SearchReplaced());
    const controller = new AbortController(); this.current.set(key, controller);
    try { return await search(controller.signal); }
    finally { if (this.current.get(key) === controller) this.current.delete(key); }
  }
  close(): void {
    for (const controller of this.current.values()) controller.abort(new Error("MusicMaid is restarting. Submit your search again shortly."));
    this.current.clear();
  }
}
