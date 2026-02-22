export interface SendMediaOptions {
  caption?: string;
  mimetype?: string;
  filename?: string;
  /** If true, audio is sent as a WhatsApp voice note (PTT) */
  ptt?: boolean;
}

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
   * Canonical Baileys message type, e.g. 'imageMessage', 'audioMessage', 'conversation'.
   * viewOnce messages are unwrapped to their inner type.
   */
  messageType: string;

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
   * A Promise that resolves once background media download has completed.
   * Tools that require the media buffer should `await ctx.mediaReady` before
   * reading `ctx.mediaPath` / `ctx.mimeType`. Resolves immediately if there
   * is nothing to download.
   */
  mediaReady: Promise<void>;

  /**
   * If this message is a reply to another message, this contains the quoted message context
   */
  quoted?: {
    /** Canonical Baileys message type of the quoted message */
    messageType: string;
    /** Multi-source text: text || caption || contentText || selectedDisplayText || title */
    body: string;
    /** Retained for backwards-compat — same as body */
    text: string;
    senderId: string;
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
   * Download the media buffer from the current OR quoted message (if applicable).
   * Prefer using mediaReady + mediaPath when possible to avoid re-downloading.
   */
  downloadMedia?(): Promise<Buffer | null>;

  /**
   * Send a binary media file back to the same chat (image, audio, video, document).
   * For WhatsApp stickers, use sendSticker instead.
   */
  sendMedia?(buffer: Buffer, options?: SendMediaOptions): Promise<void>;

  /**
   * Send a composed webp sticker natively back to the current chat
   */
  sendSticker?(buffer: Buffer): Promise<void>;

  /**
   * Delete a message. Defaults to the current incoming message if no key is provided.
   * On WhatsApp, only the bot's own messages can be deleted for everyone.
   */
  deleteMessage?(key?: any): Promise<void>;

  /**
   * Forward the current message to another chat JID / channel ID.
   */
  forwardMessage?(targetJid: string): Promise<void>;

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
