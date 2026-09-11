export interface ApplicationEmoji {
  readonly name: string;
  readonly id: string;
  readonly animated: boolean;
}

const EMOJI_NAME = /^[A-Za-z0-9_]{2,32}$/;
const EMOJI_REFERENCE = /<a?:[A-Za-z0-9_]{2,32}:\d+>|:([A-Za-z0-9_]{2,32}):/g;

function replaceOutsideInlineCode(line: string, replace: (value: string) => string): string {
  let output = "";
  let cursor = 0;
  let codeDelimiter: string | undefined;
  for (const match of line.matchAll(/`+/g)) {
    const index = match.index;
    const delimiter = match[0];
    if (!codeDelimiter) {
      output += replace(line.slice(cursor, index));
      codeDelimiter = delimiter;
    } else {
      output += line.slice(cursor, index);
      if (delimiter === codeDelimiter) codeDelimiter = undefined;
    }
    output += line.slice(index, index + delimiter.length);
    cursor = index + delimiter.length;
  }
  output += codeDelimiter ? line.slice(cursor) : replace(line.slice(cursor));
  return output;
}

/** In-memory Application Emoji catalog owned by one Discord adapter instance. */
export class ApplicationEmojiCatalog {
  private entries = new Map<string, ApplicationEmoji>();

  replace(entries: Iterable<ApplicationEmoji>): void {
    const next = new Map<string, ApplicationEmoji>();
    for (const emoji of entries) {
      if (!EMOJI_NAME.test(emoji.name) || !/^\d+$/.test(emoji.id)) continue;
      next.set(emoji.name, { ...emoji });
    }
    this.entries = next;
  }

  list(): readonly ApplicationEmoji[] {
    return [...this.entries.values()].map(emoji => ({ ...emoji })).sort((left, right) => left.name.localeCompare(right.name));
  }

  resolveText(text: string): string {
    if (!text || this.entries.size === 0) return text;
    const replace = (value: string) => value.replace(EMOJI_REFERENCE, (reference, name: string | undefined) => {
      if (!name) return reference;
      const emoji = this.entries.get(name);
      if (!emoji) return reference;
      return `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
    });
    const lines = text.split("\n");
    let fence: { readonly marker: string } | undefined;
    return lines.map(line => {
      const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (marker) {
        if (!fence) fence = { marker: marker[1]! };
        else if (marker[1]![0] === fence.marker[0] && marker[1]!.length >= fence.marker.length && !marker[2]!.trim()) fence = undefined;
        return line;
      }
      return fence ? line : replaceOutsideInlineCode(line, replace);
    }).join("\n");
  }

  resolveReaction(value: string): string {
    const match = /^:([A-Za-z0-9_]{2,32}):$/.exec(value.trim());
    return match ? this.entries.get(match[1]!)?.id ?? value : value;
  }
}
