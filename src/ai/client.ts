export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

import { logger } from '../utils/logger';
import { ToolDefinition } from '../tools/BaseTool';

export class AIClient {
  private baseUrl: string;
  private apiKey: string;
  private modelName: string;

  constructor() {
    // If no URL is provided, it falls back to a placeholder Modal URL that you will get after running `modal deploy`
    // Alternatively, for Google AI Studio (Gemini), use: "https://generativelanguage.googleapis.com/v1beta/openai/"
    this.baseUrl = process.env.AI_API_BASE_URL || 'https://<your-username>--elastra-gpbot-vllm-fastapi-app.modal.run/v1';
    this.apiKey = process.env.AI_API_KEY || 'dummy';
    // Model name defaults to the Llama 3 model deployed on Modal. 
    // If using Gemini, set this to e.g., "gemini-2.5-flash"
    this.modelName = process.env.AI_MODEL_NAME || 'meta-llama/Meta-Llama-3-8B-Instruct';
  }

  async chatCompletion(
    messages: AIChatMessage[],
    tools?: ToolDefinition[]
  ): Promise<any> {
    const payload: any = {
      model: this.modelName,
      messages,
      temperature: 0.7,
      max_tokens: 1000,
    };

    if (tools && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }

    const endpoint = this.baseUrl.endsWith('/chat/completions') 
      ? this.baseUrl 
      : `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;

    logger.debug({ endpoint, model: this.modelName }, 'Sending request to AI provider...');
    const startTime = Date.now();

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      const errText = await response.text();
      logger.error({ status: response.status, errText, elapsed }, 'Error response from LLM');
      throw new Error(`LLM API returned ${response.status}: ${errText}`);
    }

    const data = await response.json();
    logger.debug({ elapsed, tokenUsage: data.usage }, 'Received response from AI provider');
    
    // Return the entire message object so we can inspect 'tool_calls'
    return data.choices?.[0]?.message || { content: 'No response generated.' };
  }
}
