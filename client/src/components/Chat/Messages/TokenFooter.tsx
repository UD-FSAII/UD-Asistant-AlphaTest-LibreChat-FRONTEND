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
 */
const TOKEN_TOOLTIP =
  'These are tokens, the units the AI reads and writes (roughly three-quarters of ' +
  'a word each). Context is everything it read to write this reply: its instructions, ' +
  'your conversation so far, plus any documents or web results used. Response is the ' +
  'length of its answer.';

function TokenFooter({ message }: { message: TMessage }) {
    const usage = message?.metadata?.usage as
    | { input?: number; output?: number }
    | undefined;

  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;

  if (message?.isCreatedByUser === true || (input === 0 && output === 0)) {
    return null;
  }

  return (
    <span className="flex items-center gap-1 text-xs text-text-secondary">
      Tokens: Context {input.toLocaleString()} · Response {output.toLocaleString()}
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