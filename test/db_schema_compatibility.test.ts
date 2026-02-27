import { expect, test, describe } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { chatRooms } from '../src/db/schema';

// Mock migrations (or manually create schema)
describe('Schema Compatibility', () => {
  test('should support ON CONFLICT DO NOTHING', async () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);

    // Manually create schema matching chatRooms
    sqlite.run(`
      CREATE TABLE chat_rooms (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        language TEXT DEFAULT 'en' NOT NULL,
        system_prompt TEXT,
        context_limit INTEGER,
        temperature REAL,
        max_tokens INTEGER,
        allow_tools INTEGER,
        auto_reply_all INTEGER,
        created_at INTEGER NOT NULL
      )
    `);

    const chatId = 'test-room-123';

    // First insert (should succeed)
    await db.insert(chatRooms).values({
      id: chatId,
      platform: 'whatsapp',
      language: 'en',
      created_at: new Date(),
    } as any).onConflictDoNothing();

    const check1 = await db.select().from(chatRooms);
    expect(check1.length).toBe(1);

    // Second insert (duplicate PK, should do nothing)
    await db.insert(chatRooms).values({
      id: chatId,
      platform: 'discord', // Changing platform to verify it wasn't updated
      language: 'id',
      created_at: new Date(),
    } as any).onConflictDoNothing();

    const check2 = await db.select().from(chatRooms);
    expect(check2.length).toBe(1);
    expect(check2[0].platform).toBe('whatsapp'); // Should remain whatsapp
  });
});
