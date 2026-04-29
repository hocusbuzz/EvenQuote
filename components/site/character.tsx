// Shared character illustration — a simple editorial-line-art figure
// that carries the brand voice through the page. Uses ink strokes on
// cream/transparent backgrounds, with occasional lime accents. Each
// variant tells a beat of the user's journey:
//
//   - stressed  → pre-EvenQuote frustration (juggling phones)
//   - magic     → the AI taking over (phone radiating energy)
//   - reading   → the payoff (reading the report, relaxed)
//   - puzzled   → the "fair to ask" mood of the FAQ section
//
// Design rules:
//   - 1.75px stroke weight so lines read at small + large sizes.
//   - stroke-linecap + stroke-linejoin round for a hand-drawn feel.
//   - No gradients, no shadows — keep it editorial.
//   - Lime used only for "magic" state (phone glow) and "puzzled"
//     accent, so the accent doesn't lose meaning from overuse.
//   - Each variant is responsible for its own animation (stress lines
//     shake, phone rays pulse, question marks bob).
//
// All animations are gated behind `motion-safe:` — `prefers-reduced-
// motion: reduce` viewers get a static illustration.

import type { CSSProperties } from 'react';

export type CharacterVariant = 'stressed' | 'magic' | 'reading' | 'puzzled';

export interface CharacterProps {
  variant: CharacterVariant;
  /** Pixel size of the rendered SVG (square). Defaults to 96. */
  size?: number;
  /** Extra className applied to the root <svg>. */
  className?: string;
  /** Inline style — mainly for animation-delay stagger. */
  style?: CSSProperties;
}

/**
 * Renders the character in the specified variant. Returns an inline
 * SVG so the icon can be styled from the outside via currentColor.
 */
export function Character({ variant, size = 96, className, style }: CharacterProps) {
  switch (variant) {
    case 'stressed':
      return <Stressed size={size} className={className} style={style} />;
    case 'magic':
      return <Magic size={size} className={className} style={style} />;
    case 'reading':
      return <Reading size={size} className={className} style={style} />;
    case 'puzzled':
      return <Puzzled size={size} className={className} style={style} />;
  }
}

// ─── Variant: stressed ─────────────────────────────────────────────
// Person with hand to forehead, juggling a phone. Three short
// motion-lines radiate from the head and shake in a loop to signal
// "overwhelmed". The phone itself wobbles slightly as if being
// fumbled.

function Stressed({ size, className, style }: Omit<CharacterProps, 'variant'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      {/* Stress marks — three short strokes radiating from above the head */}
      <g className="motion-safe:animate-[stress-shake_0.6s_ease-in-out_infinite] origin-[30px_18px]">
        <path d="M22 14 L18 8" />
        <path d="M30 10 L30 3" />
        <path d="M38 14 L42 8" />
      </g>

      {/* Head */}
      <circle cx="30" cy="30" r="10" />

      {/* Eyes — squinted in frustration */}
      <path d="M26 28 L28 30" />
      <path d="M32 30 L34 28" />

      {/* Mouth — flat line */}
      <path d="M27 35 L33 35" />

      {/* Hand to forehead (left arm) */}
      <path d="M24 40 L18 36 L16 28" />

      {/* Body */}
      <path d="M30 40 L30 68" />

      {/* Right arm holding phone */}
      <path d="M30 48 L52 52" />

      {/* Legs */}
      <path d="M30 68 L22 88" />
      <path d="M30 68 L38 88" />

      {/* Phone in right hand — wobbles on a loop */}
      <g className="motion-safe:animate-[phone-wobble_1.4s_ease-in-out_infinite] origin-[55px_56px]">
        <rect x="49" y="46" width="12" height="20" rx="2" />
        <path d="M53 50 L57 50" />
        <circle cx="55" cy="62" r="0.8" fill="currentColor" stroke="none" />
      </g>

      {/* Extra phones flying around (chaos) */}
      <g className="motion-safe:animate-[phone-wobble_1.6s_ease-in-out_infinite_0.3s] origin-[72px_30px] opacity-60">
        <rect x="68" y="24" width="8" height="14" rx="1.5" transform="rotate(22 72 31)" />
      </g>
      <g className="motion-safe:animate-[phone-wobble_1.3s_ease-in-out_infinite_0.15s] origin-[78px_60px] opacity-60">
        <rect x="74" y="54" width="8" height="14" rx="1.5" transform="rotate(-28 78 61)" />
      </g>
    </svg>
  );
}

// ─── Variant: magic ────────────────────────────────────────────────
// Person holding a single phone. Lime rays radiate outward from the
// phone in a pulsing loop — the phone is "doing the work". The
// character's expression is relaxed: round eyes, tiny smile.

function Magic({ size, className, style }: Omit<CharacterProps, 'variant'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      {/* Lime rays pulsing out of the phone */}
      <g className="text-lime stroke-lime motion-safe:animate-[ray-pulse_1.8s_ease-in-out_infinite] origin-[68px_46px]">
        <path d="M80 46 L88 46" strokeWidth="2" />
        <path d="M78 38 L86 34" strokeWidth="2" />
        <path d="M78 54 L86 58" strokeWidth="2" />
        <path d="M68 34 L68 26" strokeWidth="2" />
        <path d="M68 58 L68 66" strokeWidth="2" />
      </g>

      {/* Head */}
      <circle cx="30" cy="30" r="10" />

      {/* Eyes — calm, round */}
      <circle cx="27" cy="29" r="1" fill="currentColor" stroke="none" />
      <circle cx="33" cy="29" r="1" fill="currentColor" stroke="none" />

      {/* Smile */}
      <path d="M27 34 Q30 37 33 34" />

      {/* Body */}
      <path d="M30 40 L30 68" />

      {/* Left arm, relaxed */}
      <path d="M30 46 L22 58" />

      {/* Right arm holding phone, outstretched */}
      <path d="M30 46 L60 46" />

      {/* Legs */}
      <path d="M30 68 L22 88" />
      <path d="M30 68 L38 88" />

      {/* Phone */}
      <rect x="60" y="38" width="14" height="20" rx="2" fill="hsl(var(--background))" />
      <path d="M64 42 L70 42" />
      <circle cx="67" cy="54" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

// ─── Variant: reading ──────────────────────────────────────────────
// Person relaxed, holding a report (folded paper). Content smile.
// Tiny check-mark accent on the paper in lime.

function Reading({ size, className, style }: Omit<CharacterProps, 'variant'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      {/* Head */}
      <circle cx="30" cy="30" r="10" />

      {/* Eyes — looking down at paper */}
      <path d="M26 30 Q27 32 28 30" />
      <path d="M32 30 Q33 32 34 30" />

      {/* Contented smile */}
      <path d="M27 34 Q30 37 33 34" />

      {/* Body */}
      <path d="M30 40 L30 68" />

      {/* Arms holding paper up */}
      <path d="M30 46 L40 48" />
      <path d="M30 46 L50 50" />

      {/* Legs — one crossed over the other, relaxed */}
      <path d="M30 68 L24 88" />
      <path d="M30 68 L40 84 L36 88" />

      {/* Report — folded paper with lines */}
      <rect x="40" y="42" width="22" height="28" rx="1" fill="hsl(var(--background))" />
      <path d="M44 48 L58 48" />
      <path d="M44 54 L58 54" />
      <path d="M44 60 L54 60" />

      {/* Lime check mark on the paper */}
      <path
        d="M55 62 L58 65 L62 60"
        className="stroke-lime"
        strokeWidth="2.5"
      />
    </svg>
  );
}

// ─── Variant: puzzled ──────────────────────────────────────────────
// Person with two ?? floating above head, bobbing. Head slightly
// tilted. Used in FAQ section.

function Puzzled({ size, className, style }: Omit<CharacterProps, 'variant'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      {/* Floating question marks — bob in loop, staggered */}
      <g className="motion-safe:animate-[question-bob_2.2s_ease-in-out_infinite]">
        <text
          x="52"
          y="20"
          fontFamily="var(--font-fraunces), serif"
          fontSize="18"
          fontWeight="700"
          fill="currentColor"
          stroke="none"
        >
          ?
        </text>
      </g>
      <g className="motion-safe:animate-[question-bob_2.2s_ease-in-out_infinite_0.4s] text-lime">
        <text
          x="64"
          y="14"
          fontFamily="var(--font-fraunces), serif"
          fontSize="14"
          fontWeight="700"
          fill="currentColor"
          stroke="none"
        >
          ?
        </text>
      </g>

      {/* Head — slightly tilted */}
      <g transform="rotate(-6 38 34)">
        <circle cx="38" cy="34" r="11" />
        {/* Eyes — one raised brow */}
        <circle cx="34" cy="33" r="1" fill="currentColor" stroke="none" />
        <circle cx="42" cy="33" r="1" fill="currentColor" stroke="none" />
        <path d="M40 29 L44 30" />
        {/* Tilted mouth — puzzled */}
        <path d="M35 39 Q38 38 41 40" />
      </g>

      {/* Body */}
      <path d="M38 46 L38 72" />

      {/* Arms — one hand on chin */}
      <path d="M38 52 L32 54 L30 48" />
      <path d="M38 52 L48 60" />

      {/* Legs */}
      <path d="M38 72 L30 90" />
      <path d="M38 72 L46 90" />
    </svg>
  );
}
