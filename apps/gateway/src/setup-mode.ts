export interface SetupConfiguration {
  readonly baseUrl?: string | undefined;
  readonly model?: string | undefined;
  readonly discordToken?: string | undefined;
  readonly ownerDiscordId?: string | undefined;
  readonly discordConnectionFailed?: boolean;
}

export function configurationRequirements(input: SetupConfiguration): string[] {
  const required: string[] = [];
  if (!input.baseUrl?.trim()) required.push("LLM_BASE_URL");
  const model = input.model?.trim();
  if (!model || model === "not-configured") required.push("LLM_MODEL");
  if (!input.discordToken?.trim()) required.push("DISCORD_TOKEN");
  if (!input.ownerDiscordId?.trim()) required.push("UMIRO_OWNER_DISCORD_ID");
  if (input.discordConnectionFailed) required.push("DISCORD_CONNECTION");
  return required;
}

export function modelEndpoint(baseUrl: string | undefined): string {
  return baseUrl?.trim() || "http://127.0.0.1";
}
