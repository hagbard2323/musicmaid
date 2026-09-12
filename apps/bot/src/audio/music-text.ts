export function normalizeText(value: string): string {
  return value.normalize("NFKD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1").normalize("NFC").toLocaleLowerCase("en")
    .replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
}
export function versionTerms(value: string): string[] {
  const terms: string[] = normalizeText(value).match(/\b(?:remix|flip|cover|karaoke|tribute|nightcore|slowed|reverb|sped up|bootleg|mashup|edit|acoustic|instrumental|remaster(?:ed)?)\b/g) ?? [];
  if (/[([][^)\]]*\blive\b[^)\]]*[)\]]|\blive\s+(?:at|from|in|version|performance|session)\b|\bin concert\b/i.test(value) || /\blive$/.test(normalizeText(value))) terms.push("live");
  if (/耳コピ|歌ってみた|演奏してみた/.test(value)) terms.push("cover");
  if (/\binst(?:版)?\b/i.test(value)) terms.push("instrumental");
  return [...new Set(terms.map(term => /^remaster/.test(term) ? "remaster" : term))];
}
export function cleanedTitle(value: string): string {
  return normalizeText(value.replace(/[([][^)\]]*[)\]]/g, part => /\b(?:official|audio|music video|video|lyrics?|visualizer|hd|hq|4k)\b/i.test(part) && !versionTerms(part).length ? " " : part));
}
export function artistName(value: string): string {
  const normalized = normalizeText(value);
  return normalized.replace(/(?:\s+[- ]*)?(?:vevo|official|topic)$/, "").replace(/\s+/g, " ").trim() || normalized;
}
export function sameArtist(value: string, expected: string): boolean {
  const actual = artistName(value).replace(/\s+/g, "");
  const artist = artistName(expected).replace(/\s+/g, "");
  return Boolean(artist) && (actual === artist || actual === artist + "music");
}
