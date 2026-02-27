/**
 * @file src/tools/PDFTool.ts
 * @description PDF utility tool for basic PDF operations.
 *
 * Provides information about a PDF and basic operations via pdf-lib.
 *
 * Actions:
 *   info     — Show page count and file size of an attached PDF.
 *   compress — Compress a PDF by re-encoding it (lossy; good for large scanned PDFs).
 *   to_images— Convert PDF pages to images via FFmpeg/Ghostscript (requires Ghostscript).
 *
 * Works conversationally ("how many pages is this PDF?", "compress this PDF")
 * and via slash command: /pdf [action]   — attach or reply to a PDF file.
 *
 * Slash command aliases: /pdf
 *
 * Dependencies: pdf-lib (install: bun add pdf-lib)
 */

import { BaseTool, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

export class PDFTool extends BaseTool {
  readonly name = 'pdf_tool';
  readonly description = 'Perform operations on a PDF file attached to the current or quoted message. Actions: "info" (show page count and size), "compress" (reduce file size). The user must attach or reply to a PDF file.';
  readonly aliases = ['pdf'];
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

  async execute(args: Record<string, any>, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    const action = String(args.action || 'info');

    // Resolve media source
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

    // Validate it's actually a PDF
    if (!mimeType.includes('pdf') && !mediaPath.toLowerCase().endsWith('.pdf')) {
      return t(lang, 'pdf.not_pdf');
    }

    try {
      // Lazy-import pdf-lib to avoid crashing if not installed
      let PDFDocument: any;
      try {
        const pdfLib: any = await import('pdf-lib');
        PDFDocument = pdfLib.PDFDocument;
      } catch {
        return '❌ pdf-lib is not installed. Run `bun add pdf-lib` to enable PDF features.';
      }

      const pdfBytes = await readFile(mediaPath);
      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const pageCount = pdfDoc.getPageCount();
      const sizeKb = Math.round(pdfBytes.length / 1024);

      if (action === 'info') {
        return t(lang, 'pdf.info', {
          pages: String(pageCount),
          size: String(sizeKb),
        });
      }

      if (action === 'compress') {
        if (!ctx.sendMedia) return t(lang, 'pdf.not_supported');

        await ctx.react?.('⚙️');
        // Re-serialize the document — pdf-lib removes unused objects on save
        const compressedBytes = await pdfDoc.save({ useObjectStreams: true });
        const savedKb = Math.round(compressedBytes.length / 1024);
        const savingPercent = Math.round((1 - compressedBytes.length / pdfBytes.length) * 100);

        if (compressedBytes.length >= pdfBytes.length) {
          return '📄 This PDF is already well-optimized; no significant compression was possible.';
        }

        await ctx.sendMedia(Buffer.from(compressedBytes), {
          mimetype: 'application/pdf',
          filename: 'compressed.pdf',
        });

        return `✅ PDF compressed! ${sizeKb}KB → ${savedKb}KB (saved ~${savingPercent}%)`;
      }

      return t(lang, 'pdf.error', { msg: `Unknown action: ${action}` });
    } catch (err: any) {
      logger.error({ err }, '[PDFTool] PDF operation failed');
      return t(lang, 'pdf.error', { msg: err.message.slice(0, 200) });
    }
  }
}
