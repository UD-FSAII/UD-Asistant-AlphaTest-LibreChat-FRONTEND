import { memo } from 'react';
import { Info } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import type { TMessage } from 'librechat-data-provider';

/**
 * UD Assistant customization: per-response token usage.
 * Shows how many tokens the assistant read (context) and produced (response),
 * to help users build intuition for what a token is. Renders nothing when the
 * message carries no provider usage (e.g. user messages, or responses from
 * before `streamUsage: true` was enabled).
 *
 * In Deep Thinking mode the response total includes the model's private
 * reasoning. If the provider reports `reasoning_tokens` we break it out;
 * vLLM does not currently do so, in which case we show the total only and
 * the tooltip explains why short answers can look expensive.
 */
const TOKEN_TOOLTIP =
  'Tokens are how the AI counts text — roughly three-quarters of a word each. ' +
  'Context is everything the AI reads before answering: your conversation, its ' +
  'instructions, and any documents or search results. Response is what it wrote. ' +
  'In Deep Thinking mode this includes the model\u2019s private reasoning, so even ' +
  'short answers can show a high number.';

function TokenFooter({ message }: { message: TMessage }) {
  const usage = message?.metadata?.usage as
    | {
        input?: number;
        output?: number;
        output_token_details?: { reasoning?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      }
    | undefined;

  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;

  // Providers report this under different names; use whichever is present.
  const reasoning =
    usage?.output_token_details?.reasoning ??
    usage?.completion_tokens_details?.reasoning_tokens ??
    0;

  const showReasoning = reasoning > 0 && reasoning <= output;

  if (message?.isCreatedByUser === true || (input === 0 && output === 0)) {
    return null;
  }

  return (
    <span className="flex items-center gap-1 text-xs text-text-secondary">
      Tokens: Context {input.toLocaleString()} · Response {output.toLocaleString()}
      {showReasoning ? ` (${reasoning.toLocaleString()} thinking)` : ''}
      <TooltipAnchor
        side="top"
        description={TOKEN_TOOLTIP}
        render={
          <span
            role="img"
            aria-label="What do these numbers mean?"
            className="inline-flex cursor-help"
          >
            <Info className="h-3 w-3" aria-hidden="true" />
          </span>
        }
      />
    </span>
  );
}

export default memo(TokenFooter);