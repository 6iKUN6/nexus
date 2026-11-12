import { Link } from '@arco-design/web-react';
import { normalizeLocalUrl } from '@nexus/protocol';
import { Fragment } from 'react';

/**
 * Minimal rich text for the prototype: paragraphs, `inline code`, and local
 * dev-server URLs as clickable chips (ADR 0014). Chips only appear when the
 * host passes onOpenLocalUrl, so a shell without a preview pane is unaffected.
 */
const CODE_CLASS =
  'rounded bg-tint-3 px-1 py-px font-mono text-[12px] [.bg-bubble-out_&]:bg-on-accent/20';

// Agents print dev-server addresses in prose; trailing CJK/Western sentence
// punctuation is excluded from the path so "localhost:5173。" stays clean.
const LOCAL_URL =
  /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s，。；：、）】」』"']*)?|(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:\/[^\s，。；：、）】」』"']*)?)/g;

function LocalUrlChip({ text, onOpen }: { text: string; onOpen: (url: string) => void }) {
  const url = normalizeLocalUrl(text);
  if (!url) return <>{text}</>;
  return (
    <Link className="font-mono text-[12px]" onClick={() => onOpen(url)}>
      {text}
    </Link>
  );
}

// Index keys are safe here: a message's text is immutable once rendered, so
// segments never reorder.
export function MessageText({
  text,
  onOpenLocalUrl,
}: {
  text: string;
  onOpenLocalUrl?: (url: string) => void;
}) {
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
            ) : onOpenLocalUrl ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: immutable text, see above
              <Fragment key={i}>
                {part.split(LOCAL_URL).map((segment, j) =>
                  j % 2 === 1 ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: immutable text, see above
                    <LocalUrlChip key={j} text={segment} onOpen={onOpenLocalUrl} />
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: immutable text, see above
                    <Fragment key={j}>{segment}</Fragment>
                  ),
                )}
              </Fragment>
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
