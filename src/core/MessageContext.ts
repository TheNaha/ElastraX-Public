export interface MessageContext {
  platform: 'whatsapp' | 'discord';
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  isGroup: boolean;
  mentionedIds?: string[];

  /**
   * The active language for this chat room ('en' | 'id'). Populated by the agent
   * before invoking tools so that responses can be localized.  Defaults to 'en'.
   */
  language?: string;

  /**
   * True if the message contains an image, video, audio, or document
   */
  hasMedia: boolean;

  /**
   * V7.2 Local cached path of the downloaded media (if applicable)
   */
  mediaPath?: string;

  /**
   * V7.2 Mime type of the media (if applicable)
   */
  mimeType?: string;

  /**
   * If this message is a reply to another message, this contains the quoted message context
   */
  quoted?: {
    senderId: string;
    text: string;
    hasMedia: boolean;
    mediaPath?: string;
    mimeType?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rawMessage: any;
  };

  /**
   * V7.4 Unique identifier of the message from the provider system
   */
  messageId: string;

  /**
   * Send a text message back to the same chat
   */
  reply(text: string): Promise<void>;

  /**
   * React to the message with an emoji (if supported by platform)
   */
  react?(emoji: string): Promise<void>;

  /**
   * Download the media buffer from the current OR quoted message (if applicable)
   */
  downloadMedia?(): Promise<Buffer | null>;

  /**
   * Send a composed webp sticker natively back to the current chat
   */
  sendSticker?(buffer: Buffer): Promise<void>;

  /**
   * Action methods for Group Administration
   */
  updateGroupParticipants?(action: 'add' | 'remove', userIds: string[]): Promise<void>;

  /**
   * Check if the sender has the required permissions
   */
  checkPermissions(required: 'user' | 'admin' | 'owner'): Promise<boolean>;

  /**
   * The raw original message metadata/object from the provider.
   * Useful for provider-specific edge cases.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawMessage: any;
}
