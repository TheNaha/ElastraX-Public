import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

const log = logger.child({ module: 'PDFTool' });

type PDFArgs = ToolArgs & {
  action?: 'info' | 'compress' | string;
};

export class PDFTool extends BaseTool<PDFArgs> {
  readonly name = 'pdf_tool';
  readonly description = 'PDF operations on an attached/quoted file: info (metadata) or compress (reduce size).';
  readonly aliases = ['pdf'];
  override readonly triggerPatterns = [/application\/pdf/i];
  readonly category = 'utility';
  readonly permissions = 'user';

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
              enum: ['info', 'compress'],
              description: '"info" to show PDF metadata, "compress" to reduce file size.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  async execute(args: PDFArgs, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    const action = String(args.action || 'info');

    let mediaPath = ctx.mediaPath;
    let mimeType = ctx.mimeType || '';

    if (!mediaPath && ctx.quoted?.mediaPath) {
      mediaPath = ctx.quoted.mediaPath;
      mimeType = ctx.quoted.mimeType || '';
    }

    if (!mediaPath) {
      await ctx.mediaReady;
      mediaPath = ctx.mediaPath;
      mimeType = ctx.mimeType || '';
    }

    if (!mediaPath || !existsSync(mediaPath)) {
      return t(lang, 'pdf.no_file');
    }

    if (!mimeType.includes('pdf') && !mediaPath.toLowerCase().endsWith('.pdf')) {
      return t(lang, 'pdf.not_pdf');
    }

    try {
      let PDFDocument: typeof import('pdf-lib').PDFDocument;
      try {
        ({ PDFDocument } = await import('pdf-lib'));
      } catch {
        return 'pdf-lib is not installed. Run `bun add pdf-lib` to enable PDF features.';
      }

      const pdfBytes = await readFile(mediaPath);
      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const pageCount = pdfDoc.getPageCount();
      const sizeKb = Math.round(pdfBytes.length / 1024);

      log.debug({ action, pageCount, sizeKb, chatId: ctx.chatId }, 'PDF loaded');

      if (action === 'info') {
        return t(lang, 'pdf.info', {
          pages: String(pageCount),
          size: String(sizeKb),
        });
      }

      if (action === 'compress') {
        if (!ctx.sendMedia) return t(lang, 'pdf.not_supported');

        await ctx.react?.('??');
        const compressedBytes = await pdfDoc.save({ useObjectStreams: true });
        const savedKb = Math.round(compressedBytes.length / 1024);
        const savingPercent = Math.round((1 - compressedBytes.length / pdfBytes.length) * 100);

        if (compressedBytes.length >= pdfBytes.length) {
          return 'This PDF is already well-optimized; no significant compression was possible.';
        }

        await ctx.sendMedia(Buffer.from(compressedBytes), {
          mimetype: 'application/pdf',
          filename: 'compressed.pdf',
        });

        return `PDF compressed: ${sizeKb}KB -> ${savedKb}KB (saved ~${savingPercent}%)`;
      }

      return t(lang, 'pdf.error', { msg: `Unknown action: ${action}` });
    } catch (error: unknown) {
      log.error({ err: error, action, chatId: ctx.chatId }, 'PDF operation failed');
      return t(lang, 'pdf.error', { msg: getErrorMessage(error).slice(0, 200) });
    }
  }
}

