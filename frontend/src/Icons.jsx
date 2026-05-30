import React from 'react';

/* ─────────────────────────────────────────────────────────────────────────────
   ICON SYSTEM
   One cohesive stroke-based set (24×24 grid, currentColor, round caps/joins).
   Usage:  <Icon name="pill" size={20} />            // inherits text color
           <Icon name="pill" size={20} color="var(--sage)" />
           <Icon name="check" size={16} strokeWidth={2.2} />
   Color is driven by `currentColor`, so set it via the `color` prop or a parent.
───────────────────────────────────────────────────────────────────────────── */

const PATHS = {
  /* Brand mark — a speech bubble carrying a heartbeat pulse.
     "Text it to me, doc" = messaging + medical, in one glyph. */
  logo: (
    <>
      <path d="M20.5 11.3a8 8 0 0 1-11.9 7L3.5 19.5l1.3-4.2A8 8 0 1 1 20.5 11.3Z" />
      <path d="M7.5 11.6h2L10.8 9l1.7 5 1.3-2.4h2.7" />
    </>
  ),

  /* Capsule pill — medications */
  pill: (
    <>
      <path d="M10.5 20.5 3.5 13.5a4.95 4.95 0 0 1 7-7l7 7a4.95 4.95 0 0 1-7 7Z" />
      <path d="m8.5 8.5 7 7" />
    </>
  ),

  /* Sliders — settings */
  sliders: (
    <>
      <path d="M5 21v-7M5 10V3M12 21v-9M12 8V3M19 21v-5M19 12V3" />
      <path d="M2.5 14h5M9.5 8h5M16.5 16h5" />
    </>
  ),

  /* Navigation */
  chevronLeft:  <path d="m15 18-6-6 6-6" />,
  chevronDown:  <path d="m6 9 6 6 6-6" />,
  arrowUp:      <path d="M12 19V5M6 11l6-6 6 6" />,

  /* Camera — capture prescription */
  camera: (
    <>
      <path d="M14.5 4h-5L7.5 6.5h-3A1.5 1.5 0 0 0 3 8v10a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V8a1.5 1.5 0 0 0-1.5-1.5h-3L14.5 4Z" />
      <circle cx="12" cy="12.8" r="3.3" />
    </>
  ),

  /* Scan + text — reading the prescription */
  scan: (
    <>
      <path d="M3 7.5V6a2.5 2.5 0 0 1 2.5-2.5H7M17 3.5h1.5A2.5 2.5 0 0 1 21 6v1.5M21 16.5V18a2.5 2.5 0 0 1-2.5 2.5H17M7 20.5H5.5A2.5 2.5 0 0 1 3 18v-1.5" />
      <path d="M7.5 9h6M7.5 12h9M7.5 15h7" />
    </>
  ),

  /* Sparkles — AI / sample / success */
  sparkles: (
    <>
      <path d="m12 3-1.7 5.1a2 2 0 0 1-1.2 1.2L4 11l5.1 1.7a2 2 0 0 1 1.2 1.2L12 19l1.7-5.1a2 2 0 0 1 1.2-1.2L20 11l-5.1-1.7a2 2 0 0 1-1.2-1.2L12 3Z" />
      <path d="M5 4v3M3.5 5.5h3M19 16v3M17.5 17.5h3" />
    </>
  ),

  /* Calendar — schedule / upcoming */
  calendar: (
    <>
      <rect x="3" y="4.5" width="18" height="16.5" rx="2.5" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </>
  ),

  /* CPU — AI understanding step */
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1.2" />
      <path d="M9 2.5v2M15 2.5v2M9 19.5v2M15 19.5v2M2.5 9h2M2.5 15h2M19.5 9h2M19.5 15h2" />
    </>
  ),

  /* Sun — today */
  sun: (
    <>
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.5 1.5M17.9 17.9l1.5 1.5M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.5-1.5M17.9 6.1l1.5-1.5" />
    </>
  ),

  /* Lightbulb — instructions / tips */
  bulb: (
    <>
      <path d="M9 18h6M10 21.5h4" />
      <path d="M12 2.5a6.5 6.5 0 0 0-4 11.6c.7.6 1.1 1.2 1.3 1.9h5.4c.2-.7.6-1.3 1.3-1.9A6.5 6.5 0 0 0 12 2.5Z" />
    </>
  ),

  /* Message — chat */
  message: (
    <path d="M20.5 11.4a8 8 0 0 1-11.9 7L3.5 19.5l1.3-4.2A8 8 0 1 1 20.5 11.4Z" />
  ),

  /* Alert triangle — disclaimer / overdue */
  alert: (
    <>
      <path d="M10.3 4.2 2 18.5A1.8 1.8 0 0 0 3.6 21.2h16.8A1.8 1.8 0 0 0 22 18.5L13.7 4.2a1.95 1.95 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4.2M12 17.2h.01" />
    </>
  ),

  /* Clock — dose times */
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.3 2" />
    </>
  ),

  /* Check — taken / completed */
  check: <path d="M20 6.5 9.2 17.3 4 12.1" />,

  /* Close */
  close: <path d="M18 6 6 18M6 6l12 12" />,
};

export default function Icon({
  name,
  size = 20,
  color,
  strokeWidth = 1.75,
  style,
  className,
  ...rest
}) {
  const glyph = PATHS[name];
  if (!glyph) return null;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ color, display: 'block', flexShrink: 0, ...style }}
      aria-hidden="true"
      {...rest}
    >
      {glyph}
    </svg>
  );
}
