/** Longest edge requested for Discord images sent to a model. */
export const MODEL_IMAGE_EDGE = 768;

const DISCORD_CDN_HOST = "cdn.discordapp.com";
const DISCORD_RESIZING_HOST = "media.discordapp.net";

/**
 * Return a Discord CDN rendition bounded by the model image edge.
 *
 * Discord attachment URLs are signed, so all existing query parameters are
 * retained while width and height are added/replaced. URLs without reliable
 * dimensions, and URLs outside Discord's two image hosts, are left alone.
 */
export function boundedDiscordImageUrl(
  url: string,
  width?: number,
  height?: number,
  edge = MODEL_IMAGE_EDGE,
): string {
  if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return url;
  if (!Number.isFinite(edge) || edge <= 0 || (width <= edge && height <= edge)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== DISCORD_CDN_HOST && parsed.hostname !== DISCORD_RESIZING_HOST) return url;
    const scale = edge / Math.max(width, height);
    parsed.hostname = DISCORD_RESIZING_HOST;
    parsed.searchParams.set("width", String(Math.max(1, Math.round(width * scale))));
    parsed.searchParams.set("height", String(Math.max(1, Math.round(height * scale))));
    return parsed.toString();
  } catch {
    return url;
  }
}
