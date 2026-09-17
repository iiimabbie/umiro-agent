interface DiscordTextValue {
  readonly content?: string | null;
  readonly embeds?: readonly { readonly toJSON?: () => unknown }[];
  readonly components?: readonly { readonly toJSON?: () => unknown }[];
  readonly messageSnapshots?: { values(): Iterable<DiscordTextValue> } | null;
}

/** Extract every user-visible text field carried by a Discord message. */
export function extractDiscordMessageText(message: DiscordTextValue): string {
  const texts: string[] = [];
  const addText = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) texts.push(value);
  };

  addText(message.content);

  for (const embedValue of message.embeds ?? []) {
    const embed = (embedValue.toJSON ? embedValue.toJSON() : embedValue) as {
      readonly author?: { readonly name?: unknown };
      readonly title?: unknown;
      readonly description?: unknown;
      readonly fields?: unknown;
      readonly footer?: { readonly text?: unknown };
    };
    addText(embed.author?.name);
    addText(embed.title);
    addText(embed.description);
    if (Array.isArray(embed.fields)) {
      for (const fieldValue of embed.fields) {
        if (!fieldValue || typeof fieldValue !== "object") continue;
        const field = fieldValue as { readonly name?: unknown; readonly value?: unknown };
        addText(field.name);
        addText(field.value);
      }
    }
    addText(embed.footer?.text);
  }

  const visitComponent = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const component = value as { readonly type?: unknown; readonly content?: unknown; readonly components?: unknown };
    if (component.type === 10) addText(component.content);
    if (Array.isArray(component.components)) {
      for (const child of component.components) visitComponent(child);
    }
  };
  for (const component of message.components ?? []) {
    visitComponent(component.toJSON ? component.toJSON() : component);
  }

  for (const snapshot of message.messageSnapshots?.values() ?? []) {
    const snapshotText = extractDiscordMessageText(snapshot);
    if (snapshotText) texts.push(snapshotText);
  }

  return texts.join("\n");
}
