import { transformOutsideMarkdownCode } from "./outgoing-text.js";

export interface ApplicationEmoji {
  readonly name: string;
  readonly id: string;
  readonly animated: boolean;
}

const EMOJI_NAME = /^[A-Za-z0-9_]{2,32}$/;
const EMOJI_REFERENCE = /<a?:[A-Za-z0-9_]{2,32}:\d+>|:([A-Za-z0-9_]{2,32}):/g;

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
    return transformOutsideMarkdownCode(text, replace);
  }

  resolveReaction(value: string): string {
    const match = /^:([A-Za-z0-9_]{2,32}):$/.exec(value.trim());
    return match ? this.entries.get(match[1]!)?.id ?? value : value;
  }
}
