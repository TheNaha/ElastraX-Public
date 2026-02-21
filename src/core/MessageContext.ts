export interface MessageContext {
  platform: 'whatsapp' | 'discord';
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  isGroup: boolean;
  mentionedIds?: string[];

  /**
   * Send a text message back to the same chat
   */
  reply(text: string): Promise<void>;

  /**
   * React to the message with an emoji (if supported by platform)
   */
  react?(emoji: string): Promise<void>;

  /**
   * The raw original message metadata/object from the provider.
   * Useful for provider-specific edge cases.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawMessage: any;
}
