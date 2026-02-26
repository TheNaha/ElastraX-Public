import { MessageContext } from './MessageContext';
import { SessionManager } from '../utils/SessionManager';
import { logger } from '../utils/logger';
import { t } from '../utils/i18n';
import { CANCEL_COMMANDS } from './constants';

export type FlowProcessor = (ctx: MessageContext, activeFlowData: any, flowId: string) => Promise<void>;

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
    const session = SessionManager.get(ctx.senderId, ctx.platform);

    if (!session || !session.activeFlow) {
      return false; // User is not in an active flow
    }

    const activeFlowData = session.flows[session.activeFlow];
    if (!activeFlowData) return false;

    const flowProcessor = this.flows[activeFlowData.flow];
    if (flowProcessor) {
      // If user types a new slash command while in a flow, let the router handle it
      // unless they explicitly type /cancel
      if (ctx.text.startsWith('/')) {
         if (CANCEL_COMMANDS.includes(ctx.text.trim())) {
            SessionManager.clear(ctx.senderId, session.activeFlow, ctx.platform);
            await ctx.react?.('✅');
            await ctx.reply(t(ctx.language, 'flow.cancelled'));
            return true;
         }

         // Clear active flow to prevent being stuck if they start a new command
         SessionManager.clear(ctx.senderId, session.activeFlow, ctx.platform);
         return false;
      }

      try {
        await flowProcessor(ctx, activeFlowData, session.activeFlow);
        return true;
      } catch (err: any) {
        logger.error(err, `[FlowHandler] Error in flow: ${activeFlowData.flow}`);
        await ctx.reply(t(ctx.language, 'flow.error', { msg: err.message }));
        SessionManager.clear(ctx.senderId, session.activeFlow, ctx.platform);
        return true;
      }
    }

    return false;
  }
}
