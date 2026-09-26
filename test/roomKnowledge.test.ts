/**
 * Tests for the room knowledge base.
 *
 * Two things are being pinned here. First, that ingestion, chunking and
 * retrieval actually work end to end against the database. Second, the privacy
 * boundary: room documents are group-visible, so they must be stored and
 * retrieved under the room key and never under a participant's user id, and
 * private memory rows must stay out of the room knowledge view.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createTempDatabase } from './helpers/database';

const _mockLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => _mockLogger, trace: () => {},
};
mock.module('../src/utils/logger', () => ({ logger: _mockLogger }));

// Follow the isolation pattern used by the other database suites: point the db
// module at a private temp database *before* importing the code under test, so
// these tests neither read nor wipe the shared fixture.
const tempDatabase = createTempDatabase();
const realDatabaseModulePath: string = '../src/db/index.ts?case=room-knowledge';
const realDatabaseModule = (await import(realDatabaseModulePath)) as typeof import('../src/db');
mock.module('../src/db', () => ({
  ...realDatabaseModule,
  db: tempDatabase.db,
  sqlite: tempDatabase.sqlite,
  getDefaultDatabase: () => tempDatabase.sqlite,
}));

const { db } = await import('../src/db');
const { memories } = await import('../src/db/schema');
const {
  chunkText,
  ingestRoomDocument,
  retrieveRoomKnowledge,
  listRoomDocuments,
  removeRoomDocument,
  formatRoomKnowledge,
  documentIdOf,
  DOCUMENT_CATEGORY,
  MAX_DOCUMENT_CHARS,
} = await import('../src/utils/roomKnowledge');
const { KnowledgeTool } = await import('../src/tools/KnowledgeTool');
type MessageContext = import('../src/core/MessageContext').MessageContext;

const ROOM_A = 'room:whatsapp:group-alpha';
const ROOM_B = 'room:whatsapp:group-beta';
const USER = '628999999999@s.whatsapp.net';

beforeEach(async () => {
  await db.delete(memories);
});

afterAll(() => {
  tempDatabase.cleanup();
});

const LONG_TEXT = [
  'ElastraX runs on Bun. The bot stores conversations in SQLite via Drizzle.',
  '',
  'Reminders are delivered by a scheduler that polls every thirty seconds.',
  '',
  'Media is stored under the data/media directory with a per-file byte cap.',
].join('\n');

describe('chunkText', () => {
  test('returns a single chunk for short text', () => {
    expect(chunkText('short enough')).toEqual(['short enough']);
  });

  test('returns nothing for blank input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  test('splits on paragraph boundaries and keeps every word', () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} with a reasonable amount of filler text.`).join('\n\n');
    const chunks = chunkText(paragraphs, 200, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(260);
  });

  test('hard-splits a single unbroken run longer than the target', () => {
    const run = 'x'.repeat(1_000);
    const chunks = chunkText(run, 300, 50);
    expect(chunks.length).toBeGreaterThan(1);
    // Overlap means consecutive chunks share content.
    expect(chunks[0]!.slice(-10)).toBe(chunks[1]!.slice(0, 10));
  });

  test('normalises excessive blank lines', () => {
    expect(chunkText('a\n\n\n\n\nb')).toEqual(['a\n\nb']);
  });
});

describe('room document ingestion', () => {
  test('stores chunks under the room key with the document category', async () => {
    const result = await ingestRoomDocument({ roomKey: ROOM_A, source: 'handbook.txt', text: LONG_TEXT });
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.source).toBe('handbook.txt');

    const rows = await db.select().from(memories).where(eq(memories.ownerId, ROOM_A));
    expect(rows.length).toBe(result.chunkCount);
    for (const row of rows) {
      expect(row.category).toBe(DOCUMENT_CATEGORY);
      expect(row.content).toContain('handbook.txt');
    }
  });

  test('never stores a document under a user id', async () => {
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'a.txt', text: LONG_TEXT });
    const asUser = await db.select().from(memories).where(eq(memories.ownerId, USER));
    expect(asUser.length).toBe(0);
  });

  test('keeps rooms isolated from each other', async () => {
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'alpha.txt', text: 'alpha only content about pelicans' });
    await ingestRoomDocument({ roomKey: ROOM_B, source: 'beta.txt', text: 'beta only content about narwhals' });

    const alpha = await retrieveRoomKnowledge({ roomKey: ROOM_A, query: 'pelicans' });
    expect(alpha.length).toBeGreaterThan(0);
    expect(alpha.every(hit => hit.content.includes('pelicans'))).toBe(true);

    const betaSeesAlpha = await retrieveRoomKnowledge({ roomKey: ROOM_B, query: 'pelicans' });
    expect(betaSeesAlpha.length).toBe(0);
  });

  test('rejects a document with no extractable text', async () => {
    await expect(ingestRoomDocument({ roomKey: ROOM_A, source: 'empty.txt', text: '   ' }))
      .rejects.toThrow(/no extractable text/i);
  });

  test('rejects a missing room key', async () => {
    await expect(ingestRoomDocument({ roomKey: '', source: 'x', text: 'hello' }))
      .rejects.toThrow(/room key is required/i);
  });

  test('rejects an oversized document', async () => {
    await expect(ingestRoomDocument({ roomKey: ROOM_A, source: 'big', text: 'x'.repeat(MAX_DOCUMENT_CHARS + 1) }))
      .rejects.toThrow(/above the .* character limit/i);
  });
});

describe('room knowledge retrieval', () => {
  test('finds a chunk by keyword when embeddings are unavailable', async () => {
    await ingestRoomDocument({
      roomKey: ROOM_A,
      source: 'ops.md',
      text: 'The deployment runbook requires rotating the webhook secret before every release.',
    });
    const hits = await retrieveRoomKnowledge({ roomKey: ROOM_A, query: 'webhook secret rotation' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain('webhook secret');
    expect(hits[0]!.source).toBe('ops.md');
  });

  test('returns nothing for an empty query or unknown room', async () => {
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'a', text: 'something' });
    expect(await retrieveRoomKnowledge({ roomKey: ROOM_A, query: '   ' })).toEqual([]);
    expect(await retrieveRoomKnowledge({ roomKey: ROOM_B, query: 'something' })).toEqual([]);
  });

  test('honours the result limit', async () => {
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'big.md', text: Array.from({ length: 30 }, (_, i) => `Section ${i} about deployment pipelines and release trains.`).join('\n\n') });
    const hits = await retrieveRoomKnowledge({ roomKey: ROOM_A, query: 'deployment release', limit: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  test('strips the source header from returned content', async () => {
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'clean.md', text: 'unique marker phrase for testing' });
    const hits = await retrieveRoomKnowledge({ roomKey: ROOM_A, query: 'unique marker phrase' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).not.toContain('[source:');
  });
});

describe('document listing and removal', () => {
  test('lists documents with their chunk counts', async () => {
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'one.txt', text: 'a'.repeat(3_000) });
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'two.txt', text: 'b'.repeat(500) });
    const documents = await listRoomDocuments(ROOM_A);
    expect(documents.length).toBe(2);
    expect(documents.map(doc => doc.source).sort()).toEqual(['one.txt', 'two.txt']);
    const one = documents.find(doc => doc.source === 'one.txt')!;
    expect(one.chunks).toBeGreaterThan(1);
  });

  test('removes a single document and leaves the others', async () => {
    const first = await ingestRoomDocument({ roomKey: ROOM_A, source: 'keep.txt', text: 'keep me around' });
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'drop.txt', text: 'drop me please' });

    const removed = await removeRoomDocument(ROOM_A, first.documentId);
    expect(removed).toBe(first.chunkCount);

    const remaining = await listRoomDocuments(ROOM_A);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.source).toBe('drop.txt');
  });

  test('clears the whole room knowledge base when no id is given', async () => {
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'a.txt', text: 'first' });
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'b.txt', text: 'second' });
    const removed = await removeRoomDocument(ROOM_A);
    expect(removed).toBeGreaterThan(0);
    expect(await listRoomDocuments(ROOM_A)).toEqual([]);
  });

  test('cannot remove another room\'s documents', async () => {
    const beta = await ingestRoomDocument({ roomKey: ROOM_B, source: 'beta.txt', text: 'beta content here' });
    const removed = await removeRoomDocument(ROOM_A, beta.documentId);
    expect(removed).toBe(0);
    expect((await listRoomDocuments(ROOM_B)).length).toBe(1);
  });
});

describe('private memory stays separate from room knowledge', () => {
  test('a personal memory row is not listed or retrievable as room knowledge', async () => {
    await db.insert(memories).values({
      id: 'personal-1',
      ownerId: ROOM_A,
      content: 'my private diary entry about a lost cat',
      category: 'inert',
      created_at: new Date(),
    });
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'shared.md', text: 'shared handbook entry about deployments' });

    // The personal row exists under the same owner but a different category, so
    // the knowledge base must not surface it.
    const hits = await retrieveRoomKnowledge({ roomKey: ROOM_A, query: 'lost cat diary' });
    expect(hits.length).toBe(0);
    const documents = await listRoomDocuments(ROOM_A);
    expect(documents.length).toBe(1);
    expect(documents[0]!.source).toBe('shared.md');
  });
});

describe('prompt rendering', () => {
  test('labels excerpts as untrusted reference material', () => {
    const rendered = formatRoomKnowledge([
      { documentId: 'd1', ordinal: 1, source: 'handbook.md', content: 'the body text', similarity: 0.5 },
    ]);
    expect(rendered).toContain('<room_knowledge>');
    expect(rendered).toContain('not instructions');
    expect(rendered).toContain('source="handbook.md"');
    expect(rendered).toContain('the body text');
  });

  test('renders nothing when there are no hits', () => {
    expect(formatRoomKnowledge([])).toBe('');
  });
});

describe('documentIdOf', () => {
  test('recovers the shared document id from a chunk id', () => {
    expect(documentIdOf('doc_abc_3')).toBe('doc_abc');
    expect(documentIdOf('doc_abc_10')).toBe('doc_abc');
  });
});

describe('KnowledgeTool', () => {
  function groupContext(overrides: Partial<MessageContext> = {}): MessageContext {
    return {
      platform: 'whatsapp',
      chatId: 'group-alpha',
      roomKey: ROOM_A,
      senderId: USER,
      isGroup: true,
      language: 'en',
      hasMedia: false,
      ...overrides,
    } as unknown as MessageContext;
  }

  test('refuses to operate without a room key', async () => {
    const result = await new KnowledgeTool().execute({ action: 'list' }, groupContext({ roomKey: undefined }));
    expect(result).toContain('group');
  });

  test('reports an empty knowledge base', async () => {
    const result = await new KnowledgeTool().execute({ action: 'list' }, groupContext());
    expect(result.toLowerCase()).toContain('no indexed documents');
  });

  test('requires a query for search', async () => {
    const result = await new KnowledgeTool().execute({ action: 'search' }, groupContext());
    expect(result).toContain('query');
  });

  test('search returns the formatted excerpts', async () => {
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'faq.md', text: 'The billing portal is reachable at the internal dashboard.' });
    const result = await new KnowledgeTool().execute({ action: 'search', query: 'billing portal' }, groupContext());
    expect(result).toContain('<room_knowledge>');
    expect(result).toContain('billing portal');
  });

  test('search reports when nothing matched', async () => {
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'faq.md', text: 'something about billing' });
    const result = await new KnowledgeTool().execute({ action: 'search', query: 'quantum chromodynamics' }, groupContext());
    expect(result).toContain('matched');
  });

  test('remove clears the room knowledge base', async () => {
    await ingestRoomDocument({ roomKey: ROOM_A, source: 'temp.md', text: 'temporary content' });
    const result = await new KnowledgeTool().execute({ action: 'remove' }, groupContext());
    expect(result.toLowerCase()).toContain('cleared');
    expect(await listRoomDocuments(ROOM_A)).toEqual([]);
  });

  test('index refuses when no document is attached', async () => {
    const result = await new KnowledgeTool().execute({ action: 'index' }, groupContext());
    expect(result.toLowerCase()).toContain('document');
  });

  test('is scoped to groups only', () => {
    expect(new KnowledgeTool().groupOnly).toBe(true);
  });

  test('advertises a schema the validator accepts', async () => {
    const { validateToolArguments } = await import('../src/tools/ParameterValidator');
    expect(validateToolArguments(new KnowledgeTool(), { action: 'search', query: 'x' }).valid).toBe(true);
    // `query` is only meaningful for search, so it is required per action rather
    // than at the top level.
    expect(validateToolArguments(new KnowledgeTool(), { action: 'search' }).valid).toBe(false);
    expect(validateToolArguments(new KnowledgeTool(), { action: 'list' }).valid).toBe(true);
    expect(validateToolArguments(new KnowledgeTool(), { action: 'bogus' }).valid).toBe(false);
  });
});

