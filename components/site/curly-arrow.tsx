// Hand-drawn curly arrow — the marker that points from the hero
// caption at the left into the $9.99 sticker at the right.
//
// Shape (unchanged from the approved reference): tail curl at the
// left, single clockwise loop in the middle, swoosh out to the right
// ending in an arrowhead.
//
// Design notes — why this is one SVG piece now:
//   The previous iteration drew the body as a stroked <path> and the
//   arrowhead as a separate <polygon>. The two never lined up
//   perfectly because the polygon's coordinates were hardcoded and
//   didn't track the path's terminal tangent. Fix: use SVG
//   `<marker>` on the path's `marker-end`. The browser computes the
//   marker's rotation from the last path segment's tangent and
//   anchors its `refX`/`refY` to the path's endpoint, so the
//   arrowhead ALWAYS meets the line seamlessly regardless of what
//   cubic beziers the body uses.
//
// Animation: the whole arrow fades in together on mount (parent
// container handles the fade via Tailwind). We dropped the earlier
// stroke-dasharray "self-draw" effect because animating a dashed
// stroke while the marker-end sits at the fully-drawn terminus made
// the triangle appear before the line reached it. A simple
// opacity-in reads cleanly and keeps the triangle + line as one
// visual piece at all animation frames.

export interface CurlyArrowProps {
  /** Overall arrow dimensions in px. Defaults to 160×96. */
  width?: number;
  height?: number;
  className?: string;
}

export function CurlyArrow({
  width = 160,
  height = 96,
  className,
}: CurlyArrowProps) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 160 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <defs>
        {/* Arrowhead marker — a solid filled triangle that the
            browser rotates to match the path's terminal tangent.
            `orient="auto"` means "align to the path direction at
            attach point"; `refX=9, refY=5` puts the marker's tip at
            the path's end coordinate (so the body flows INTO the
            arrowhead without a visible seam). `markerUnits=
            "strokeWidth"` scales the marker with the line weight so
            the triangle stays proportional even if we bump stroke. */}
        <marker
          id="curly-arrowhead"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          markerUnits="strokeWidth"
          orient="auto"
        >
          <path d="M 0 0 L 10 5 L 0 10 Z" fill="currentColor" stroke="none" />
        </marker>
      </defs>

      {/* Body path — tail curl → stem → loop → exit. Ends at roughly
          (144, 66) with a rightward-and-slightly-down exit tangent.
          The marker-end triangle picks up from there, rotated to
          match that tangent. */}
      <path
        d="
          M 10 32
          q -6 12, 8 14
          c 14 0, 24 -6, 40 -4
          c 16 2, 18 20, 2 20
          c -18 0, -10 -24, 10 -18
          c 20 6, 42 14, 72 24
        "
        markerEnd="url(#curly-arrowhead)"
        className="motion-safe:animate-[fade-up_0.5s_ease-out_both_0.3s]"
      />
    </svg>
  );
}
