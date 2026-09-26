export const MAX_WEB_BODY_CHARACTERS = 50_000;

const ENTITY_NAMES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", copy: "©", reg: "®", trade: "™", times: "×", euro: "€", pound: "£", yen: "¥",
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:#(x[\da-f]+|\d+)|([a-z][a-z\d]+));/gi, (whole, numeric: string | undefined, named: string | undefined) => {
    if (numeric) {
      const codepoint = numeric[0]?.toLowerCase() === "x" ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10);
      return Number.isInteger(codepoint) && codepoint > 0 && codepoint <= 0x10ffff && !(codepoint >= 0xd800 && codepoint <= 0xdfff)
        ? String.fromCodePoint(codepoint) : whole;
    }
    return ENTITY_NAMES[named?.toLowerCase() ?? ""] ?? whole;
  });
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function boundedLines(lines: readonly string[], limit: number): { body: string; truncated: boolean; readableCharacters: number } {
  const unique: string[] = [];
  const seen = new Set<string>();
  let readableCharacters = 0;
  for (const line of lines) {
    const normalized = line.replace(/[\t \u00a0]+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    readableCharacters += normalized.length + 1;
    unique.push(normalized);
  }
  let body = "";
  let truncated = false;
  for (const line of unique) {
    const room = limit - body.length - (body ? 1 : 0);
    if (room <= 0) { truncated = true; break; }
    body += `${body ? "\n" : ""}${line.slice(0, room)}`;
    if (line.length > room) { truncated = true; break; }
  }
  return { body, truncated: truncated || readableCharacters > body.length + 1, readableCharacters };
}

export function readableHtml(html: string, limit = MAX_WEB_BODY_CHARACTERS): { body: string; truncated: boolean; readableCharacters: number; extraction: "readable_text" | "none" } {
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|nav|footer|header|aside|form|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*\b(?:hidden|aria-hidden\s*=\s*["']?true)[^>]*>[\s\S]*?<\/[^>]+>/gi, " ");
  const title = [...visible.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)].map(match => plainText(match[1] ?? ""));
  const headings = [...visible.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi)].map(match => plainText(match[1] ?? ""));
  const tableRows = [...visible.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map(match =>
    plainText((match[1] ?? "").replace(/<\/(?:td|th)\s*>/gi, " | "))).filter(line => line.includes("|"));
  const text = visible
    .replace(/<\/(?:title|h[1-6]|p|div|section|article|li|ul|ol|tr|table|blockquote|pre|br)\s*>/gi, "\n")
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:td|th)\s*>/gi, " | ")
    .replace(/<[^>]*>/g, " ");
  const lines = decodeEntities(text).split(/\n+/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const specification = /(?:\b(?:display|screen|resolution|size|inch|panel|refresh|hz|hdmi|usb|type.c|price|weight|dimension|port|battery|brightness|contrast|warranty|specification|model)\b|\d+(?:\.\d+)?\s*(?:inch|in|cm|mm|hz|px|kg|g|nit|cd\/m²)|\d{3,4}\s*[×x]\s*\d{3,4}|(?:尺寸|解析度|螢幕|介面|價格|重量|規格|亮度|刷新率|型號))/i;
  const prioritized = [...title, ...headings, ...tableRows, ...lines.filter(line => specification.test(line)), ...lines];
  const result = boundedLines(prioritized, limit);
  return result.body
    ? { ...result, extraction: "readable_text" }
    : { body: "[No readable page text could be extracted; this page may require JavaScript.]", truncated: false, readableCharacters: 0, extraction: "none" };
}

export function boundedText(text: string, limit = MAX_WEB_BODY_CHARACTERS): { body: string; truncated: boolean; readableCharacters: number } {
  return { body: text.slice(0, limit), truncated: text.length > limit, readableCharacters: text.length };
}
