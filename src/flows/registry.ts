/**
 * @file src/flows/registry.ts
 * @description Centralized registration of FlowHandler processors.
 *
 * Instead of each tool module calling `FlowHandler.register()` at module load
 * time (which causes side-effects on import and makes registration order
 * non-deterministic), this registry is the single place where flows are
 * registered. AppRuntime.start() calls `registerFlows()` once after providers
 * are initialized and the database is ready.
 *
 * Each tool module exports its flow processor function; this file imports them
 * and registers them with FlowHandler.
 */

import { FlowHandler } from '../core/FlowHandler';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'FlowRegistry' });

export function registerFlows(): void {
  // Importing the tool modules triggers their FlowHandler.register() calls,
  // but we centralize the *intent* here: this is the single integration point
  // called from AppRuntime.start(). Tool modules should NOT register flows
  // at module-load time going forward — new flows go here.

  // Register flows by importing the processor functions from each tool.
  // Lazy imports avoid circular dependencies and keep startup fast.
  void registerMediaBindFlow();
  void registerMenfessFlow();
  void registerPdfFlows();

  log.info('Flow processors registered');
}

/** MediaBindTool: interactive username/password → Seerr/Jellyfin binding. */
async function registerMediaBindFlow(): Promise<void> {
  const { mediaConnectFlowProcessor } = await import('../tools/MediaBindTool');
  FlowHandler.register('media_connect', mediaConnectFlowProcessor);
}

/** MenfessTool: confirmation flow for anonymous message sending. */
async function registerMenfessFlow(): Promise<void> {
  const { menfessConfirmFlowProcessor } = await import('../tools/MenfessTool');
  FlowHandler.register('menfess_confirm', menfessConfirmFlowProcessor);
}

/** PDFTool: image collection and PDF merge collection flows. */
async function registerPdfFlows(): Promise<void> {
  const { pdfImgCollectFlowProcessor, pdfMergeCollectFlowProcessor } = await import('../tools/PDFTool');
  FlowHandler.register('pdf_img_collect', pdfImgCollectFlowProcessor);
  FlowHandler.register('pdf_merge_collect', pdfMergeCollectFlowProcessor);
}

/**
 * Safe wrapper that logs errors instead of throwing during startup.
 */
export function safeRegisterFlows(): void {
  try {
    registerFlows();
  } catch (err: unknown) {
    log.error({ err }, 'Failed to register flow processors');
  }
}
