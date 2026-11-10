import { Fragment } from 'react';

/**
 * Minimal rich text for the prototype: paragraphs and `inline code`.
 * M1 replaces this with a streaming Markdown renderer.
 */
const CODE_CLASS =
  'rounded bg-tint-3 px-1 py-px font-mono text-[12px] [.bg-bubble-out_&]:bg-on-accent/20';

// Index keys are safe here: a message's text is immutable once rendered, so
// segments never reorder.
export function MessageText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n\n').map((paragraph, p) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: immutable text, see above
        <p key={p} className="m-0 whitespace-pre-wrap [&+p]:mt-2">
          {paragraph.split(/(`[^`]+`)/g).map((part, i) =>
            part.startsWith('`') && part.endsWith('`') ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: immutable text, see above
              <code key={i} className={CODE_CLASS}>
                {part.slice(1, -1)}
              </code>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: immutable text, see above
              <Fragment key={i}>{part}</Fragment>
            ),
          )}
        </p>
      ))}
    </>
  );
}
