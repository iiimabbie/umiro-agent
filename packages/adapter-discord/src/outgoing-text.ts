const INLINE_MARKDOWN_LINK = /(!?\[[^\]\n]*\]\(\s*)(<[^>\n]+>|[^)\s]+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\))/g;
const BARE_URL = /https?:\/\/[^\s<>\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A'"\u2019\u201D]+/giu;
const TRAILING_PUNCTUATION = /[.,!?;:\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A'"\u2019\u201D]$/u;

function transformOutsideInlineCode(line: string, transform: (value: string) => string): string {
  let output = "";
  let cursor = 0;
  let codeDelimiter: string | undefined;
  for (const match of line.matchAll(/`+/g)) {
    const index = match.index;
    const delimiter = match[0];
    if (!codeDelimiter) {
      output += transform(line.slice(cursor, index));
      codeDelimiter = delimiter;
    } else {
      output += line.slice(cursor, index);
      if (delimiter === codeDelimiter) codeDelimiter = undefined;
    }
    output += line.slice(index, index + delimiter.length);
    cursor = index + delimiter.length;
  }
  output += codeDelimiter ? line.slice(cursor) : transform(line.slice(cursor));
  return output;
}

/** Apply a text transform while preserving fenced and inline Markdown code. */
export function transformOutsideMarkdownCode(text: string, transform: (value: string) => string): string {
  const lines = text.split("\n");
  let fence: { readonly marker: string } | undefined;
  return lines.map(line => {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { marker: marker[1]! };
      else if (marker[1]![0] === fence.marker[0] && marker[1]!.length >= fence.marker.length && !marker[2]!.trim()) fence = undefined;
      return line;
    }
    return fence ? line : transformOutsideInlineCode(line, transform);
  }).join("\n");
}

function stripTrailingPunctuation(candidate: string): { readonly url: string; readonly suffix: string } {
  let url = candidate;
  let suffix = "";
  while (TRAILING_PUNCTUATION.test(url)) {
    suffix = url.at(-1)! + suffix;
    url = url.slice(0, -1);
  }
  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
    const count = (value: string, token: string) => [...value].filter(character => character === token).length;
    while (url.endsWith(closing) && count(url, closing) > count(url, opening)) {
      suffix = closing + suffix;
      url = url.slice(0, -1);
    }
  }
  return { url, suffix };
}

function wrapBareUrls(value: string): string {
  return value.replace(BARE_URL, (candidate, offset: number) => {
    if (offset > 0 && value[offset - 1] === "<") return candidate;
    const { url, suffix } = stripTrailingPunctuation(candidate);
    return url ? `<${url}>${suffix}` : candidate;
  });
}

function preserveMarkdownLinks(value: string): string {
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(INLINE_MARKDOWN_LINK)) {
    output += wrapBareUrls(value.slice(cursor, match.index));
    const destination = match[2]!;
    output += `${match[1]}${destination.startsWith("<") ? destination : wrapBareUrls(destination)}${match[3]}`;
    cursor = match.index + match[0].length;
  }
  return output + wrapBareUrls(value.slice(cursor));
}

/** Suppress Discord link-preview embeds by wrapping bare URLs in angle brackets. */
export function suppressDiscordLinkEmbeds(text: string): string {
  return transformOutsideMarkdownCode(text, preserveMarkdownLinks);
}
