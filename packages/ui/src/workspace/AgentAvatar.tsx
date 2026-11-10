import type { HarnessId } from '@nexus/protocol';
import { PERSONAS } from '../model/types';

const SIZES = { xs: 'size-4 text-[9px]', sm: 'size-6 text-[11px]', md: 'size-8 text-[13px]' };

export function AgentAvatar({
  agent,
  size = 'md',
}: {
  agent: HarnessId;
  size?: keyof typeof SIZES;
}) {
  const persona = PERSONAS[agent];
  return (
    <span
      aria-hidden
      className={`${SIZES[size]} ${persona.tone} inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-on-accent`}
    >
      {persona.monogram}
    </span>
  );
}
