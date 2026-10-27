export function chunkText(text: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Chunk limit must be positive.');
  const characters = Array.from(text);
  if (characters.length === 0) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += limit) {
    chunks.push(characters.slice(offset, offset + limit).join(''));
  }
  return chunks;
}

export function chunkTextSmart(text: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Chunk limit must be positive.');
  const characters = Array.from(text);
  if (characters.length === 0) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += limit) {
    let end = Math.min(offset + limit, characters.length);
    if (end < characters.length) {
      const searchStart = Math.max(offset + Math.floor(limit / 2), offset + 1);
      const boundary = characters.slice(searchStart, end);
      const lastBreak = boundary.lastIndexOf('\n');
      const lastSpace = boundary.lastIndexOf(' ');
      const breakAt = Math.max(lastBreak, lastSpace);
      if (breakAt >= 0) end = searchStart + breakAt + 1;
    }
    chunks.push(characters.slice(offset, end).join(''));
  }
  return chunks;
}