import { useRef } from 'react';

/**
 * Drag handle between workspace columns. Arco has no splitter, so this is a
 * custom control with full keyboard support: role=separator, arrow keys step
 * the width (Shift for a bigger step), double-click resets to the default.
 * The handle always sits on the left edge of a right-side panel, so dragging
 * left widens it.
 */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  onChange,
  onReset,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  // The budget can be tighter than the current width (narrow window, other
  // panel open). Clamping to that max would snap the panel smaller on the
  // first nudge, so the cap never sits below the value it constrains.
  const cap = Math.max(max, value);
  const clamp = (width: number) => Math.min(cap, Math.max(min, Math.round(width)));

  return (
    // biome-ignore lint/a11y/useSemanticElements: no semantic element exists for a splitter; role=separator is the ARIA pattern
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      // Negative margins make the 8px hit strip overlap the column border, so
      // it costs no layout width.
      className="group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none"
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: value };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        onChange(clamp(start.startWidth + (start.startX - event.clientX)));
      }}
      onPointerUp={(event) => {
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16;
        if (event.key === 'ArrowLeft') {
          onChange(clamp(value + step));
          event.preventDefault();
        } else if (event.key === 'ArrowRight') {
          onChange(clamp(value - step));
          event.preventDefault();
        } else if (event.key === 'Enter') {
          onReset();
          event.preventDefault();
        }
      }}
      onDoubleClick={onReset}
    >
      <div className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded bg-tint-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </div>
  );
}
