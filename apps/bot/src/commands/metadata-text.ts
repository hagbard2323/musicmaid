import { escapeMarkdown } from "discord.js";

/** Cut escaped text without letting a partial escape consume our closing markup. */
export function truncateMetadata(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let result = value.slice(0, Math.max(0, Math.floor(limit)));
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  const slashes = /\\+$/.exec(result)?.[0].length ?? 0;
  return slashes % 2 ? result.slice(0, -1) : result;
}

/** Metadata is literal text, including when placed inside a bot-generated link. */
export function metadataText(value: string, limit = Infinity): string {
  // escapeMarkdown's maskedLink option only handles complete links. Escape every
  // delimiter so a fragment cannot break out of the link label surrounding it.
  const escaped = escapeMarkdown(value).replace(/[\[\]()]/g, "\\$&");
  return truncateMetadata(escaped, limit);
}
