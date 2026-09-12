import type { Session } from "../audio/model.js";
import type { LibraryStorage } from "./library.js";
export interface MusicStorage {
  readonly library?: LibraryStorage;
  loadSessions(guildId?: string): Session[];
  saveSession(session: Session): void;
  getValue(key: string): string | undefined;
  setValue(key: string, value: string): void;
  close(): void;
}
