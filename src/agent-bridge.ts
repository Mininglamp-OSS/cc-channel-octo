/**
 * Agent Bridge — Claude Agent SDK query() invocation.
 * Outputs AsyncIterable<string> — does not know about Octo API.
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.js';

/**
 * Build the prompt string from history, group context, and current message.
 *
 * Format:
 * [Group context]
 * <groupContext if non-empty>
 *
 * [Conversation history]
 * <historyPrefix if non-empty>
 *
 * [Current message]
 * <message>
 */
export function buildPrompt(historyPrefix: string, groupContext: string, message: string): string {
  const parts: string[] = [];
  if (groupContext) {
    parts.push(`[Group context]\n${groupContext}`);
  }
  if (historyPrefix) {
    parts.push(`[Conversation history]\n${historyPrefix}`);
  }
  parts.push(`[Current message]\n${message}`);
  return parts.join('\n\n');
}

/**
 * Query Claude Agent SDK and yield text chunks as they arrive.
 * Does not reference any Octo API — pure SDK interaction.
 *
 * @param prompt - Full prompt string (built by buildPrompt)
 * @param config - Application config (sdk.* fields used)
 * @yields string chunks of assistant text output
 */
export async function* queryAgent(prompt: string, config: Config): AsyncIterable<string> {
  const stream = sdkQuery({
    prompt,
    options: {
      cwd: config.cwd,
      systemPrompt: config.sdk.systemPrompt,
      allowedTools: config.sdk.allowedTools,
      permissionMode: config.sdk.permissionMode as any,
      maxTurns: config.sdk.maxTurns,
      model: config.sdk.model,
      settingSources: config.sdk.settingSources as any[],
      allowDangerouslySkipPermissions: config.sdk.permissionMode === 'bypassPermissions',
    },
  });

  try {
    for await (const message of stream) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text) {
            yield block.text;
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype !== 'success') {
          const errorResult = message as any;
          const errorMsg = errorResult.error || errorResult.subtype || 'Processing failed';
          yield `\n[Error: ${errorMsg}]`;
        }
      }
    }
  } finally {
    stream.close();
  }
}
