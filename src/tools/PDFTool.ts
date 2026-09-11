import { BaseTool, type ToolArgs, ToolDefinition } from './BaseTool';
import { MessageContext } from '../core/MessageContext';
import { FlowHandler } from '../core/FlowHandler';
import { t } from '../utils/i18n';
import { logger } from '../utils/logger';
import { getErrorMessage } from '../utils/errorUtils';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolveTargetMedia } from '../utils/mediaResolve';

const log = logger.child({ module: 'PDFTool' });

const ACTIONS = [
  'info', 'compress', 'merge', 'split', 'rotate',
  'remove_pages', 'add_page_numbers', 'add_watermark',
  'img_to_pdf', 'to_text', 'flatten', 'edit_metadata',
] as const;
type PDFAction = (typeof ACTIONS)[number];

const DONE_WORDS = ['done', 'selesai', 'finish', 'ok', 'beres', 'jadi'];
const MAX_COLLECT_FILES = 20;
const COLLECT_TTL = 300; // 5 minutes

type PDFArgs = ToolArgs & {
  action?: PDFAction | string;
  start_page?: number;
  end_page?: number;
  pages?: string;
  degrees?: number;
  watermark_text?: string;
  title?: string;
  author?: string;
  subject?: string;
};

export class PDFTool extends BaseTool<PDFArgs> {
  readonly name = 'pdf_tool';
  readonly description =
    'PDF toolkit: info, compress, merge, split, rotate, remove pages, page numbers, watermark, image-to-PDF, extract text, flatten forms, edit metadata.';
  readonly aliases = ['pdf'];
  override readonly triggerPatterns = [/application\/pdf/i, /\b(pdf|merge|gabung|gambar ke pdf)\b/i];
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
              enum: [...ACTIONS],
              description:
                'Operation: info | compress | merge (quote one PDF, attach another) | split (start_page, end_page) | rotate (degrees) | remove_pages (pages) | add_page_numbers | add_watermark (watermark_text) | img_to_pdf (attach image) | to_text | flatten | edit_metadata (title, author, subject)',
            },
            start_page: { type: 'number', description: 'split: first page (1-based inclusive)' },
            end_page: { type: 'number', description: 'split: last page (1-based inclusive)' },
            pages: {
              type: 'string',
              description: 'remove_pages: comma-separated 1-based page numbers, e.g. "1,3,5"',
            },
            degrees: { type: 'number', description: 'rotate: clockwise degrees (90, 180, or 270)' },
            watermark_text: { type: 'string', description: 'add_watermark: diagonal text overlay' },
            title: { type: 'string', description: 'edit_metadata: document title' },
            author: { type: 'string', description: 'edit_metadata: document author' },
            subject: { type: 'string', description: 'edit_metadata: document subject' },
          },
          required: ['action'],
        },
      },
    };
  }

  private isPdf(mime: string, path: string): boolean {
    return mime.includes('pdf') || path.toLowerCase().endsWith('.pdf');
  }

  private async sendPdf(
    ctx: MessageContext,
    bytes: Uint8Array,
    filename: string,
  ): Promise<void> {
    if (!ctx.sendMedia) {
      throw new Error('PDFTool: sendMedia is not supported by the current provider');
    }
    await ctx.sendMedia(Buffer.from(bytes), {
      mimetype: 'application/pdf',
      filename,
    });
  }

  async execute(args: PDFArgs, ctx: MessageContext): Promise<string> {
    const lang = ctx.language ?? 'en';
    const action = String(args.action || 'info') as PDFAction;

    // Actions with special media requirements — handle before generic PDF resolve
    if (action === 'img_to_pdf') return this.imgToPdf(ctx, lang);
    if (action === 'merge') return this.mergePdfs(ctx, lang);

    const media = await resolveTargetMedia(ctx);
    if (!media?.path) return t(lang, 'pdf.no_file');
    if (!this.isPdf(media.mime, media.path)) return t(lang, 'pdf.not_pdf');

    try {
      const { PDFDocument, StandardFonts, degrees: degreesOf, rgb } = await import('pdf-lib');

      const pdfBytes = await readFile(media.path);
      const sizeKb = Math.round(pdfBytes.length / 1024);
      if (sizeKb > 100000) {
        return t(lang, 'pdf.error', { msg: 'PDF file is too large to process safely (max 100MB).' }) || 'PDF file is too large to process safely (max 100MB).';
      }

      log.debug({ action, sizeKb, chatId: ctx.chatId }, 'PDF loaded');

      switch (action) {
        case 'info': {
          const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          return t(lang, 'pdf.info', {
            pages: String(doc.getPageCount()),
            size: String(sizeKb),
          });
        }

        case 'compress': {
          if (!ctx.sendMedia) return t(lang, 'pdf.not_supported');
          await ctx.react?.('⏳');
          const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          const compressed = await doc.save({ useObjectStreams: true });
          if (compressed.length >= pdfBytes.length) {
            return t(lang, 'pdf.already_optimized');
          }
          const savedKb = Math.round(compressed.length / 1024);
          const pct = Math.round((1 - compressed.length / pdfBytes.length) * 100);
          await this.sendPdf(ctx, compressed, 'compressed.pdf');
          return t(lang, 'pdf.compress_done', {
            from: String(sizeKb),
            to: String(savedKb),
            pct: String(pct),
          });
        }

        case 'split': {
          if (!ctx.sendMedia) return t(lang, 'pdf.not_supported');
          const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          const total = doc.getPageCount();
          const start = Math.max(1, Math.min(Number(args.start_page) || 1, total));
          const end = Math.max(start, Math.min(Number(args.end_page) || total, total));
          await ctx.react?.('⏳');
          const newDoc = await PDFDocument.create();
          const indices = Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i);
          const pages = await newDoc.copyPages(doc, indices);
          for (const p of pages) newDoc.addPage(p);
          const splitBytes = await newDoc.save();
          await this.sendPdf(ctx, splitBytes, `pages_${start}-${end}.pdf`);
          return t(lang, 'pdf.split_done', {
            start: String(start),
            end: String(end),
            pages: String(indices.length),
          });
        }

        case 'rotate': {
          if (!ctx.sendMedia) return t(lang, 'pdf.not_supported');
          const deg = [90, 180, 270].includes(Number(args.degrees))
            ? Number(args.degrees)
            : 90;
          await ctx.react?.('⏳');
          const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          for (const page of doc.getPages()) {
            page.setRotation(degreesOf(page.getRotation().angle + deg));
          }
          const rotated = await doc.save();
          await this.sendPdf(ctx, rotated, `rotated_${deg}.pdf`);
          return t(lang, 'pdf.rotate_done', { degrees: String(deg) });
        }

        case 'remove_pages': {
          if (!ctx.sendMedia) return t(lang, 'pdf.not_supported');
          const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          const total = doc.getPageCount();
          const toRemove = String(args.pages || '')
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => n >= 1 && n <= total);
          if (toRemove.length === 0) return t(lang, 'pdf.invalid_pages');
          if (toRemove.length >= total) return t(lang, 'pdf.cannot_remove_all');
          await ctx.react?.('⏳');
          const sorted = [...new Set(toRemove)].sort((a, b) => b - a);
          for (const pageNum of sorted) doc.removePage(pageNum - 1);
          const result = await doc.save();
          await this.sendPdf(ctx, result, 'pages_removed.pdf');
          return t(lang, 'pdf.remove_done', {
            removed: String(sorted.length),
            remaining: String(doc.getPageCount()),
          });
        }

        case 'add_page_numbers': {
          if (!ctx.sendMedia) return t(lang, 'pdf.not_supported');
          await ctx.react?.('⏳');
          const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          const font = await doc.embedFont(StandardFonts.Helvetica);
          const pages = doc.getPages();
          for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const { width } = page.getSize();
            const text = String(i + 1);
            const tw = font.widthOfTextAtSize(text, 12);
            page.drawText(text, {
              x: (width - tw) / 2,
              y: 20,
              size: 12,
              font,
              color: rgb(0, 0, 0),
            });
          }
          const numbered = await doc.save();
          await this.sendPdf(ctx, numbered, 'numbered.pdf');
          return t(lang, 'pdf.page_numbers_done', { pages: String(pages.length) });
        }

        case 'add_watermark': {
          if (!ctx.sendMedia) return t(lang, 'pdf.not_supported');
          const wmText = String(args.watermark_text || 'WATERMARK');
          await ctx.react?.('⏳');
          const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          const font = await doc.embedFont(StandardFonts.HelveticaBold);
          for (const page of doc.getPages()) {
            const { width, height } = page.getSize();
            const fontSize = Math.min(width, height) / 8;
            const tw = font.widthOfTextAtSize(wmText, fontSize);
            const rad = (45 * Math.PI) / 180;
            page.drawText(wmText, {
              x: (width - tw * Math.cos(rad)) / 2,
              y: (height - tw * Math.sin(rad)) / 2,
              size: fontSize,
              font,
              color: rgb(0.75, 0.75, 0.75),
              opacity: 0.3,
              rotate: degreesOf(45),
            });
          }
          const watermarked = await doc.save();
          await this.sendPdf(ctx, watermarked, 'watermarked.pdf');
          return t(lang, 'pdf.watermark_done');
        }

        case 'to_text': {
          await ctx.react?.('⏳');
          let PDFParse: typeof import('pdf-parse').PDFParse;
          try {
            ({ PDFParse } = await import('pdf-parse'));
          } catch {
            return 'pdf-parse is not installed. Run `bun add pdf-parse` to enable text extraction.';
          }
          const parser = new PDFParse({ data: Buffer.from(pdfBytes) });
          const data = await parser.getText();
          const text = data.text?.trim();
          if (!text) return t(lang, 'pdf.no_text');
          // Truncate for WhatsApp readability
          return text.length > 4000
            ? text.slice(0, 4000) + '\n\n[... truncated]'
            : text;
        }

        case 'flatten': {
          if (!ctx.sendMedia) return t(lang, 'pdf.not_supported');
          await ctx.react?.('⏳');
          const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          const form = doc.getForm();
          const fields = form.getFields();
          if (fields.length === 0) return t(lang, 'pdf.no_forms');
          form.flatten();
          const flattened = await doc.save();
          await this.sendPdf(ctx, flattened, 'flattened.pdf');
          return t(lang, 'pdf.flatten_done');
        }

        case 'edit_metadata': {
          if (!ctx.sendMedia) return t(lang, 'pdf.not_supported');
          if (!args.title && !args.author && !args.subject) {
            return t(lang, 'pdf.metadata_missing');
          }
          const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          if (args.title) doc.setTitle(args.title);
          if (args.author) doc.setAuthor(args.author);
          if (args.subject) doc.setSubject(args.subject);
          const updated = await doc.save();
          await this.sendPdf(ctx, updated, 'metadata_updated.pdf');
          return t(lang, 'pdf.metadata_done');
        }

        default:
          return t(lang, 'pdf.error', { msg: `Unknown action: ${action}` });
      }
    } catch (error: unknown) {
      log.error({ err: error, action, chatId: ctx.chatId }, 'PDF operation failed');
      return t(lang, 'pdf.error', { msg: getErrorMessage(error).slice(0, 200) });
    }
  }

  /** Merge PDFs: instant if two attached, otherwise start collection flow. */
  private async mergePdfs(ctx: MessageContext, lang: string): Promise<string> {
    if (!ctx.sendMedia) return t(lang, 'pdf.not_supported');
    await ctx.mediaReady;

    const file1 = ctx.quoted?.mediaPath;
    const file2 = ctx.mediaPath;
    const hasTwoFiles = file1 && file2 && existsSync(file1) && existsSync(file2);

    // Fast path: quote one PDF + attach another → instant merge
    if (hasTwoFiles) {
      return this.doMerge(ctx, lang, [file1, file2]);
    }

    // Collect the first file if one is attached
    const files: string[] = [];
    const singleFile = file2 ?? file1;
    if (singleFile && existsSync(singleFile)) files.push(singleFile);

    // Start collection flow
    FlowHandler.setSession(
      ctx.senderId,
      'pdf_merge_collect',
      { flow: 'pdf_merge_collect', step: 'collecting', data: { files, chatId: ctx.chatId } },
      ctx.platform,
      COLLECT_TTL,
    );

    const countMsg = files.length === 1
      ? t(lang, 'pdf.merge_collect_started_one')
      : t(lang, 'pdf.merge_collect_started');
    return countMsg;
  }

  /** Execute the actual merge from an array of file paths. */
  private async doMerge(ctx: MessageContext, lang: string, filePaths: string[]): Promise<string> {
    try {
      const { PDFDocument } = await import('pdf-lib');
      await ctx.react?.('⏳');
      const merged = await PDFDocument.create();
      for (const fp of filePaths) {
        const bytes = await readFile(fp);
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        for (const p of pages) merged.addPage(p);
      }
      const mergedBytes = await merged.save();
      await this.sendPdf(ctx, mergedBytes, 'merged.pdf');
      return t(lang, 'pdf.merge_done', { pages: String(merged.getPageCount()) });
    } catch (error: unknown) {
      log.error({ err: error, chatId: ctx.chatId }, 'PDF merge failed');
      return t(lang, 'pdf.error', { msg: getErrorMessage(error).slice(0, 200) });
    }
  }

  /** Convert image(s) to PDF: instant for one image, collection flow for multiple. */
  private async imgToPdf(ctx: MessageContext, lang: string): Promise<string> {
    if (!ctx.sendMedia) return t(lang, 'pdf.not_supported');
    const media = await resolveTargetMedia(ctx);

    const isImage = !!media && media.path !== undefined &&
      (/image\/(jpeg|jpg|png)/i.test(media.mime) || /\.(jpe?g|png)$/i.test(media.path));

    if (isImage && media?.path) {
      // Single image → instant convert
      return this.doImgToPdf(ctx, lang, [media.path]);
    }

    // No image attached → start collection flow
    FlowHandler.setSession(
      ctx.senderId,
      'pdf_img_collect',
      { flow: 'pdf_img_collect', step: 'collecting', data: { files: [], mimes: [], chatId: ctx.chatId } },
      ctx.platform,
      COLLECT_TTL,
    );
    return t(lang, 'pdf.img_collect_started');
  }

  /** Build a PDF from an array of image file paths. */
  private async doImgToPdf(
    ctx: MessageContext,
    lang: string,
    filePaths: string[],
    mimeTypes?: string[],
  ): Promise<string> {
    try {
      const { PDFDocument } = await import('pdf-lib');
      await ctx.react?.('⏳');
      const doc = await PDFDocument.create();
      for (let i = 0; i < filePaths.length; i++) {
        const imgBytes = await readFile(filePaths[i]);
        const mime = mimeTypes?.[i] || '';
        const isPng = mime.includes('png') || filePaths[i].toLowerCase().endsWith('.png');
        const image = isPng ? await doc.embedPng(imgBytes) : await doc.embedJpg(imgBytes);
        const page = doc.addPage([image.width, image.height]);
        page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      }
      const pdfBytes = await doc.save();
      await this.sendPdf(ctx, pdfBytes, 'images.pdf');
      return t(lang, 'pdf.img_to_pdf_done', { pages: String(filePaths.length) });
    } catch (error: unknown) {
      log.error({ err: error, chatId: ctx.chatId }, 'img_to_pdf failed');
      return t(lang, 'pdf.error', { msg: getErrorMessage(error).slice(0, 200) });
    }
  }
}

// ─── Flow processors for multi-file collection ─────────────────────────

/** Helper: check if the user typed a "done" trigger. */
function isDone(text: string): boolean {
  return DONE_WORDS.includes(text.trim().toLowerCase());
}

function isImage(mime: string, path: string): boolean {
  return /image\/(jpeg|jpg|png)/i.test(mime) || /\.(jpe?g|png)$/i.test(path);
}

function isPdf(mime: string, path: string): boolean {
  return mime.includes('pdf') || path.toLowerCase().endsWith('.pdf');
}

// ── Image collection flow ──────────────────────────────────────────────
FlowHandler.register('pdf_img_collect', async (ctx, flowData, flowId) => {
  const lang = ctx.language ?? 'en';
  const files = (flowData.data.files ?? []) as string[];
  const mimes = (flowData.data.mimes ?? []) as string[];

  if (isDone(ctx.text) && files.length > 0) {
    FlowHandler.clearSession(ctx.senderId, flowId, ctx.platform);
    const tool = new PDFTool();
    const result = await tool['doImgToPdf'](ctx, lang, files, mimes);
    await ctx.reply(result);
    return;
  }

  if (isDone(ctx.text) && files.length === 0) {
    await ctx.reply(t(lang, 'pdf.img_collect_empty'));
    return;
  }

  const media = await resolveTargetMedia(ctx);
  if (!media?.path || !isImage(media.mime, media.path)) {
    await ctx.reply(t(lang, 'pdf.img_collect_hint', { count: String(files.length) }));
    return;
  }

  if (files.length >= MAX_COLLECT_FILES) {
    await ctx.reply(t(lang, 'pdf.collect_max', { max: String(MAX_COLLECT_FILES) }));
    return;
  }

  files.push(media.path);
  mimes.push(media.mime);
  FlowHandler.setSession(
    ctx.senderId,
    flowId,
    { flow: 'pdf_img_collect', step: 'collecting', data: { ...flowData.data, files, mimes } },
    ctx.platform,
    COLLECT_TTL,
  );
  await ctx.react?.('📄');
  await ctx.reply(t(lang, 'pdf.img_collect_added', { count: String(files.length) }));
});

// ── PDF merge collection flow ──────────────────────────────────────────
FlowHandler.register('pdf_merge_collect', async (ctx, flowData, flowId) => {
  const lang = ctx.language ?? 'en';
  const files = (flowData.data.files ?? []) as string[];

  if (isDone(ctx.text) && files.length >= 2) {
    FlowHandler.clearSession(ctx.senderId, flowId, ctx.platform);
    const tool = new PDFTool();
    const result = await tool['doMerge'](ctx, lang, files);
    await ctx.reply(result);
    return;
  }

  if (isDone(ctx.text)) {
    await ctx.reply(t(lang, 'pdf.merge_collect_need_more', { count: String(files.length) }));
    return;
  }

  const media = await resolveTargetMedia(ctx);
  if (!media?.path || !isPdf(media.mime, media.path)) {
    await ctx.reply(t(lang, 'pdf.merge_collect_hint', { count: String(files.length) }));
    return;
  }

  if (files.length >= MAX_COLLECT_FILES) {
    await ctx.reply(t(lang, 'pdf.collect_max', { max: String(MAX_COLLECT_FILES) }));
    return;
  }

  files.push(media.path);
  FlowHandler.setSession(
    ctx.senderId,
    flowId,
    { flow: 'pdf_merge_collect', step: 'collecting', data: { ...flowData.data, files } },
    ctx.platform,
    COLLECT_TTL,
  );
  await ctx.react?.('📄');
  await ctx.reply(t(lang, 'pdf.merge_collect_added', { count: String(files.length) }));
});

