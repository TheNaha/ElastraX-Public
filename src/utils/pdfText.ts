/**
 * @file src/utils/pdfText.ts
 * @description Shared PDF text extraction.
 *
 * Extracted so the PDF tool and the room knowledge base share one
 * implementation. `pdf-parse` is imported lazily because it is optional: a
 * deployment without it still gets every other PDF operation.
 */

export class PdfTextExtractionUnavailableError extends Error {
  constructor() {
    super('PDF text extraction is unavailable. Install the optional "pdf-parse" dependency to enable it.');
    this.name = 'PdfTextExtractionUnavailableError';
  }
}

/**
 * Extract plain text from PDF bytes. Throws
 * `PdfTextExtractionUnavailableError` when the optional parser is not installed,
 * and returns an empty string for a PDF that contains no text layer (a scan,
 * for example) so callers can distinguish "unavailable" from "no text".
 */
export async function extractPdfText(pdfBytes: Buffer): Promise<string> {
  let PDFParse: typeof import('pdf-parse').PDFParse;
  try {
    ({ PDFParse } = await import('pdf-parse'));
  } catch {
    throw new PdfTextExtractionUnavailableError();
  }
  const parser = new PDFParse({ data: Buffer.from(pdfBytes) });
  try {
    const data = await parser.getText();
    return data.text?.trim() ?? '';
  } finally {
    await parser.destroy?.();
  }
}
