/**
 * @file src/core/FlowHandler.ts
 * @description Multi-step interactive flow dispatcher for ElastraX.
 *
 * Some tools (e.g., multi-step wizards) need to hold state across several user
 * messages.  `FlowHandler` bridges the gap between the stateless agent loop and
 * those stateful interactions by:
 *
 *  1. Letting tools register a named `FlowProcessor` callback via `FlowHandler.register()`.
 *  2. Intercepting every incoming message and checking `SessionManager` to see whether
 *     the sender is currently inside an active flow.
 *  3. Routing the message to the appropriate registered processor, or cancelling the
 *     flow if the user types a recognised cancel command (e.g., `/cancel`, `/batal`).
 *
 * Usage example (inside a tool's `execute` method):
 * ```ts
 * FlowHandler.register('my_flow', async (ctx, data, flowId) => {
 *   // Handle the next step of the wizard
 * });
 * SessionManager.set(ctx.senderId, 'my_flow', { flow: 'my_flow', step: 'step1', data: {} }, ctx.platform);
 * ```
 */

import { MessageContext } from './MessageContext';
import { SessionManager, type FlowSession } from '../utils/SessionManager';
import { logger } from '../utils/logger';
import { t } from '../utils/i18n';
import { CANCEL_COMMANDS } from './constants';

/**
 * Callback signature for a registered interactive flow.
 *
 * @param ctx            - The incoming message context for this step.
 * @param activeFlowData - The current flow session data (step, collected inputs, etc.).
 * @param flowId         - The unique name of the flow (same key used in `FlowHandler.register`).
 */
export type FlowProcessor = (ctx: MessageContext, activeFlowData: FlowSession, flowId: string) => Promise<void>;

export class FlowHandler {
  private static flows: Record<string, FlowProcessor> = {};

  /**
   * Registers a new interactive flow processor.
   */
  static register(flowName: string, processor: FlowProcessor) {
    this.flows[flowName] = processor;
    logger.debug({ flowName }, '[FlowHandler] Registered flow processor');
  }

  /**
   * Intercepts incoming messages if the user is currently in an active programmatic session.
   * Returns true if the message was handled by a flow, false if it should be passed to commands or the LLM.
   */
  static async handle(ctx: MessageContext): Promise<boolean> {
    const activeFlow = SessionManager.getActiveFlow(ctx.senderId, ctx.platform);

    if (!activeFlow) {
      return false; // User is not in an active flow
    }

    const { flowId, flow } = activeFlow;

    const flowProcessor = this.flows[flow.flow];
    if (flowProcessor) {
      // If user types a new slash command while in a flow, let the router handle it
      // unless they explicitly type /cancel
      if (ctx.text.startsWith('/')) {
         if (CANCEL_COMMANDS.includes(ctx.text.trim())) {
            SessionManager.clear(ctx.senderId, flowId, ctx.platform);
            await ctx.react?.('✅');
            await ctx.reply(t(ctx.language, 'flow.cancelled'));
            return true;
         }

         // Clear active flow to prevent being stuck if they start a new command
         SessionManager.clear(ctx.senderId, flowId, ctx.platform);
         return false;
      }

      try {
        await flowProcessor(ctx, flow, flowId);
        return true;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'unknown error';
        logger.error(err, `[FlowHandler] Error in flow: ${flow.flow}`);
        await ctx.reply(t(ctx.language, 'flow.error', { msg: errMsg }));
        SessionManager.clear(ctx.senderId, flowId, ctx.platform);
        return true;
      }
    }

    // Flow processor missing (e.g. after deploy where flow code was removed).
    // Clear stale session so user is not stuck with a dangling active flow forever.
    SessionManager.clear(ctx.senderId, flowId, ctx.platform);
    logger.warn(
      { flow: flow.flow, senderId: ctx.senderId, platform: ctx.platform },
      '[FlowHandler] No processor registered for active flow; session cleared',
    );
    return false;
  }
}
