import { ChatRoom } from '../db/schema';

/**
 * Service to manage the dynamic merging of hardcoded/ENV defaults
 * with database-level overrides for a specific chat room.
 */
export class ConfigService {
  /**
   * Returns the fully resolved configuration for a given chat room.
   * If a field in the DB is null, it falls back to the .env variable or hardcoded default.
   */
  static getResolvedConfig(room: ChatRoom) {
    const defaultSystemPrompt = process.env.DEFAULT_SYSTEM_PROMPT || 
`You are ElastraX, a helpful and friendly female AI personal assistant.
You are communicating via a messaging app (WhatsApp/Discord).
If someone asks your name or identity, strictly introduce yourself as ElastraX.
Be concise but warmly conversational. Use emojis naturally where appropriate, but don't overdo it.
Do not use markdown formatting that is not supported by WhatsApp (e.g. headers). Bold and italic are fine.
If a user asks a question requiring recent information, facts, or news, you MUST use the web_search tool to find the answer.
When using web_search, always provide a summary of the findings first, and then explicitly provide a list of the source URLs you used at the bottom of your message.

CRITICAL LOCALIZATION INSTRUCTION:
You MUST respond entirely in the language specified by the user's chat room setting.
Current Room Language: {{LANGUAGE}}`;

    const envContextLimit = parseInt(process.env.CONTEXT_MESSAGE_LIMIT || '10', 10);
    const envTemperature = parseFloat(process.env.AI_TEMPERATURE || '0.7');
    const envAutoReplyAll = process.env.AUTO_REPLY_ALL === 'true';

    return {
      systemPrompt: room.systemPrompt || defaultSystemPrompt,
      contextLimit: room.contextLimit ?? envContextLimit,
      temperature: room.temperature ?? envTemperature,
      allowTools: room.allowTools ?? true, // allow tools by default unless explicitly disabled in DB
      autoReplyAll: room.autoReplyAll ?? envAutoReplyAll,
    };
  }
}
