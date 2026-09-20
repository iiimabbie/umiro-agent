/** Keeps operational logs useful without copying configured credentials into them. */
export function safeErrorMessage(error: unknown, secrets: readonly (string | undefined)[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  message = message.replace(/data:[^\s,;]+;base64,[A-Za-z0-9+/=]+/gi, "data:[REDACTED]");
  message = message.replace(/https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/[^\s]+/gi, "[ATTACHMENT_URL_REDACTED]");
  message = message.replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, "$1[REDACTED]");
  return message.slice(0, 500) || "Unknown error";
}
