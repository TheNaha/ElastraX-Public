import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const chatRooms = sqliteTable('chat_rooms', {
  id: text('id').primaryKey(), // The chat/group JID
  platform: text('platform').notNull(), // 'whatsapp' | 'discord'
  systemPrompt: text('system_prompt'), // Optional custom constraint
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatRoomId: text('chat_room_id')
    .notNull()
    .references(() => chatRooms.id),
  senderId: text('sender_id').notNull(),
  senderName: text('sender_name').notNull(),
  role: text('role').notNull(), // 'user' | 'assistant'
  content: text('content').notNull(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export type ChatRoom = typeof chatRooms.$inferSelect;
export type Message = typeof messages.$inferSelect;
