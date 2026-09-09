import type { ExecutionStore } from "@umiro/core";

export interface DiscordProgressTransport {
  sendText(channelId: string, text: string): Promise<{ readonly messageId: string }>;
  editText(channelId: string, messageId: string, text: string): Promise<{ readonly messageId: string }>;
}

/** Best-effort transient stream that becomes durable only after the Run succeeds. */
export class DiscordStreamingDelivery {
  private text = "";
  private messageId?: string;
  private lastEditAt = 0;
  private disabled = false;

  constructor(
    private readonly channelId: string,
    private readonly transport: DiscordProgressTransport,
    private readonly store: Pick<ExecutionStore, "markDeliveryDelivered">,
    private readonly now: () => number = Date.now,
    private readonly onFailure: (error: unknown) => void = () => undefined,
  ) {}

  async delta(value: string): Promise<void> {
    if (this.disabled || !value) return;
    this.text += value;
    try {
      if (!this.messageId) {
        const sent = await this.transport.sendText(this.channelId, this.preview());
        this.messageId = sent.messageId;
        this.lastEditAt = this.now();
      } else if (this.now() - this.lastEditAt >= 750) {
        await this.transport.editText(this.channelId, this.messageId, this.preview());
        this.lastEditAt = this.now();
      }
    } catch (error) { this.disabled = true; this.onFailure(error); }
  }

  async finalize(deliveryId: string, finalText: string, deliveredAt: string): Promise<boolean> {
    if (this.disabled || !this.messageId || finalText.length > 1_900) return false;
    try {
      const edited = await this.transport.editText(this.channelId, this.messageId, finalText || "(empty response)");
      await this.store.markDeliveryDelivered(deliveryId, deliveredAt, { transport: "discord", messageId: edited.messageId, channelId: this.channelId, streamed: true });
      return true;
    } catch (error) { this.disabled = true; this.onFailure(error); return false; }
  }

  private preview(): string {
    return this.text.length <= 1_900 ? this.text : `…${this.text.slice(-1_899)}`;
  }
}
