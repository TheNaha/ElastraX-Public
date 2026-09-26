import { BaseTool, type ToolArgs, type ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { resolveTargetMedia, loadMediaBytes } from '../utils/mediaResolve';
import {
  ingestRoomDocument,
  listRoomDocuments,
  retrieveRoomKnowledge,
  removeRoomDocument,
  formatRoomKnowledge,
} from '../utils/roomKnowledge';
import { extractPdfText, PdfTextExtractionUnavailableError } from '../utils/pdfText';
import { transcribeImage, readOcrConfig } from '../utils/ocr';

const log = logger.child({ module: 'KnowledgeTool' });

type KnowledgeArgs = ToolArgs & {
  action?: 'index' | 'search' | 'list' | 'remove';
  query?: string;
  document_id?: string;
  title?: string;
};

const MAX_INDEX_BYTES = 6 * 1024 * 1024;

export class KnowledgeTool extends BaseTool<KnowledgeArgs> {
  readonly name = 'knowledge';
  readonly description = "Manage this room's shared document knowledge base: index an attached or quoted document, search it, list indexed documents, or remove one. Use it when the user shares a document for later reference, or asks what a previously shared document said.";
  readonly aliases = ['kb', 'docs', 'knowledge_base'];
  readonly category = 'productivity';
  readonly permissions = 'user';
  override readonly groupOnly = true;
  override readonly triggerPatterns = [/\b(remember this|save this (doc|file|pdf)|index this|knowledge ?base|what did (i|we) (say|send) about)\b/i];
  override readonly mutability = 'local-write' as const;
  override readonly cost = 2;

  get definition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['index', 'search', 'list', 'remove'],
              description: 'index: store an attached/quoted document; search: find relevant excerpts; list: show indexed documents; remove: delete a document (or all when no id is given).',
            },
            query: {
              type: 'string',
              description: 'Question or keywords to search the knowledge base for. Required for action=search.',
            },
            document_id: {
              type: 'string',
              description: 'Document id from action=list. Omit on action=remove to clear the whole room knowledge base.',
            },
            title: {
              type: 'string',
              description: 'Optional label for the stored document. Defaults to the attached file name.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(args: KnowledgeArgs, ctx: MessageContext): Promise<string> {
    // The knowledge base is room state, so an ownerless DM has no room key to
    // scope it to and must not silently fall back to a per-user store.
    if (!ctx.roomKey) return t(ctx.language, 'kb.no_room');

    try {
      switch (args.action) {
        case 'index':
          return await this.index(args, ctx);
        case 'search': {
          const query = typeof args.query === 'string' ? args.query.trim() : '';
          if (!query) return t(ctx.language, 'kb.query_required');
          const hits = await retrieveRoomKnowledge({ roomKey: ctx.roomKey, query, limit: 5 });
          if (hits.length === 0) return t(ctx.language, 'kb.no_results');
          return formatRoomKnowledge(hits);
        }
        case 'list': {
          const documents = await listRoomDocuments(ctx.roomKey);
          if (documents.length === 0) return t(ctx.language, 'kb.empty');
          const lines = documents.map(doc => `• ${doc.source} — ${doc.chunks} chunk(s) — id: ${doc.documentId}`);
          return [t(ctx.language, 'kb.list_header'), ...lines].join('\n');
        }
        case 'remove': {
          const documentId = typeof args.document_id === 'string' ? args.document_id.trim() : '';
          const removed = await removeRoomDocument(ctx.roomKey, documentId || undefined);
          log.info({ chatId: ctx.chatId, documentId: documentId || '(all)', removed }, 'Removed room knowledge');
          return documentId
            ? t(ctx.language, 'kb.removed', { count: removed })
            : t(ctx.language, 'kb.cleared', { count: removed });
        }
        default:
          return t(ctx.language, 'kb.usage');
      }
    } catch (error: unknown) {
      log.error({ err: error, chatId: ctx.chatId }, 'Knowledge base operation failed');
      return t(ctx.language, 'kb.error', { msg: getErrorMessage(error) });
    }
  }

  private async index(args: KnowledgeArgs, ctx: MessageContext): Promise<string> {
    // Re-checked here: execute() already returned for a missing roomKey, but the
    // narrowing does not carry into this method.
    if (!ctx.roomKey) return t(ctx.language, 'kb.no_room');
    const hasTarget = ctx.hasMedia || Boolean(ctx.quoted?.hasMedia);
    if (!hasTarget) return t(ctx.language, 'kb.no_document');

    const target = ctx.hasMedia ? ctx : ctx.quoted!;
    const canDownload = typeof ctx.downloadMedia === 'function';
    const media = await resolveTargetMedia(ctx, {
      useDownloader: canDownload,
      beforeDownload: () => ctx.react?.('⏳'),
    });
    if (!media) return t(ctx.language, canDownload ? 'kb.download_failed' : 'kb.download_not_supported');

    const buffer = await loadMediaBytes(media);
    if (buffer.byteLength === 0) return t(ctx.language, 'kb.empty_document');
    if (buffer.byteLength > MAX_INDEX_BYTES) {
      return t(ctx.language, 'kb.too_large', { mb: Math.round(MAX_INDEX_BYTES / (1024 * 1024)) });
    }

    const mime = media.mime || target.mimeType || '';
    const isPdf = mime.includes('pdf') || /\.pdf$/i.test(media.path ?? '') || (args.title ?? '').toLowerCase().endsWith('.pdf');
    const ocrConfig = readOcrConfig();

    /** Transcribe an image (or a text-less PDF) with the vision model. */
    const viaOcr = async (): Promise<string> => {
      if (!ocrConfig.enabled) return '';
      await ctx.react?.('👀').catch(() => {});
      const { text } = await transcribeImage(buffer, mime || 'image/jpeg', { config: ocrConfig, signal: ctx.signal });
      return text;
    };

    let text: string;
    if (isPdf) {
      try {
        text = await extractPdfText(buffer);
      } catch (error: unknown) {
        if (error instanceof PdfTextExtractionUnavailableError) {
          text = ocrConfig.enabled ? await viaOcr() : '';
        } else {
          log.debug({ err: error }, 'PDF text extraction failed');
          text = '';
        }
      }
      // A scan has no text layer; fall back to vision before giving up.
      if (!text.trim() && ocrConfig.enabled) text = await viaOcr();
    } else if (mime.startsWith('text/') || /\.(txt|md|markdown|csv|json|log)$/i.test(media.path ?? '')) {
      text = buffer.toString('utf8');
    } else if (mime.startsWith('image/')) {
      if (!ocrConfig.enabled) return t(ctx.language, 'kb.image_unsupported');
      try {
        text = await viaOcr();
      } catch (error: unknown) {
        log.warn({ err: error }, 'Image transcription failed');
        return t(ctx.language, 'kb.ocr_failed', { msg: getErrorMessage(error) });
      }
    } else {
      return t(ctx.language, 'kb.unsupported_type', { mime: mime || 'unknown' });
    }

    if (!text.trim()) {
      return mime.startsWith('image/') ? t(ctx.language, 'kb.ocr_no_text') : t(ctx.language, 'kb.no_text');
    }

    const source = (args.title ?? '').trim() || basenameOf(media.path) || 'document';
    const result = await ingestRoomDocument({ roomKey: ctx.roomKey, source, text });
    return t(ctx.language, 'kb.indexed', {
      source: result.source,
      chunks: result.chunkCount,
      embedded: result.embedded,
    });
  }
}

function basenameOf(path: string | null | undefined): string {
  if (!path) return '';
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}
