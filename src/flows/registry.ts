import { FlowHandler } from '../core/FlowHandler';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'FlowRegistry' });
let registration: Promise<void> | null = null;

export async function registerFlows(): Promise<void> {
  if (registration) return registration;
  registration = (async () => {
    const { mediaConnectFlowProcessor } = await import('../tools/MediaBindTool');
    FlowHandler.register('media_connect', mediaConnectFlowProcessor);
    const { menfessConfirmFlowProcessor } = await import('../tools/MenfessTool');
    FlowHandler.register('menfess_confirm', menfessConfirmFlowProcessor);
    const { pdfImgCollectFlowProcessor, pdfMergeCollectFlowProcessor } = await import('../tools/PDFTool');
    FlowHandler.register('pdf_img_collect', pdfImgCollectFlowProcessor);
    FlowHandler.register('pdf_merge_collect', pdfMergeCollectFlowProcessor);
    log.info('Flow processors registered');
  })().catch((error: unknown) => {
    registration = null;
    log.error({ err: error }, 'Failed to register flow processors');
    throw error;
  });
  return registration;
}

export async function safeRegisterFlows(): Promise<void> {
  try {
    await registerFlows();
  } catch {
    return;
  }
}
