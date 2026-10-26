/**
 * The app's inline SVG icons (Feather-style outlines). Inline rather
 * than an icon-font/library dependency: a few 15px glyphs don't justify
 * one, and `stroke="currentColor"` means they inherit the surrounding
 * text color (muted normally, danger red in a delete confirm) with no
 * extra styling.
 *
 * `aria-hidden`: the icon itself is decoration — the control wrapping it
 * always carries the accessible name.
 */
import type { ReactNode } from 'react';

function Outline({
  size = 15,
  children,
}: {
  size?: number;
  children: ReactNode;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function PencilIcon() {
  return (
    <Outline>
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </Outline>
  );
}

export function TrashIcon() {
  return (
    <Outline>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </Outline>
  );
}

export function XIcon() {
  return (
    <Outline>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Outline>
  );
}

/** "Match system": a disc, half filled — both themes at once. */
export function HalfDiscIcon() {
  return (
    <Outline size={17}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" />
    </Outline>
  );
}

export function SunIcon() {
  return (
    <Outline size={17}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Outline>
  );
}

export function MoonIcon() {
  return (
    <Outline size={17}>
      <path d="M20.5 14.1A8.5 8.5 0 1 1 9.9 3.5a6.6 6.6 0 0 0 10.6 10.6Z" />
    </Outline>
  );
}
