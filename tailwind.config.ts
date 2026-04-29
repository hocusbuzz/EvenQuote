import type { Config } from 'tailwindcss';

// Phase 3 Tailwind config.
// Combines:
//   - shadcn/ui design tokens (HSL CSS variables, see app/globals.css)
//   - our custom typography stack (fraunces + geist + geist-mono)
//   - brand accent extensions (lime, cream, ink)
//
// All color tokens use CSS variables so light/dark mode "just works"
// without duplicated Tailwind classes.

const config: Config = {
  darkMode: ['class'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: {
        '2xl': '1280px',
      },
    },
    extend: {
      fontFamily: {
        // Body: Geist, a refined neo-grotesque. Avoiding Inter.
        // CSS var is set by the `geist` package (GeistSans) — variable name is
        // hard-coded in the package as `--font-geist-sans`.
        sans: ['var(--font-geist-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Display: Fraunces — serif with real personality. The hero
        // and section headings use this. Not your usual "SaaS serif".
        display: ['var(--font-fraunces)', 'Georgia', 'serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
      },
      colors: {
        // shadcn tokens (mapped to HSL CSS vars in globals.css)
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Brand tokens — referenced by name in the landing page
        lime: {
          DEFAULT: '#CEFF00',       // electric accent
          deep: '#9FCC00',          // hover/pressed state
        },
        cream: '#F5F1E8',           // warm off-white surface
        ink: '#0A0A0A',             // near-black, not pure
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        // For the Accordion component
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        // Landing-page reveal animations
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'marquee': {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        // Sticker wobble — 3° each way, like a price tag catching a draft.
        // Subtle, not a novelty; the sticker should feel *alive* but not
        // distracting. Slow + easing keeps it editorial, not cartoonish.
        'sticker-wobble': {
          '0%, 100%': { transform: 'rotate(-6deg)' },
          '50%': { transform: 'rotate(-3deg)' },
        },
        // Stamp: a tiny scale-in that feels like a rubber stamp hitting
        // paper. Used for the rotating word on each swap.
        'stamp-in': {
          '0%':   { opacity: '0', transform: 'translateY(-6px) scale(1.12)', filter: 'blur(2px)' },
          '60%':  { opacity: '1', transform: 'translateY(0)     scale(0.98)', filter: 'blur(0)' },
          '100%': { opacity: '1', transform: 'translateY(0)     scale(1)',    filter: 'blur(0)' },
        },
        // Paint-in: the lime highlight box "paints" across the word on
        // reveal. Uses a clip-path sweep from left to right.
        'paint-in': {
          '0%':   { clipPath: 'inset(0 100% 0 0)' },
          '100%': { clipPath: 'inset(0 0 0 0)' },
        },
        // Kicker caret — typewriter-style blinking pipe next to the
        // eyebrow label, just enough wit to nod to "working on it".
        'caret-blink': {
          '0%, 45%': { opacity: '1' },
          '50%, 95%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        // Arrow nudge — CTA icon peeks to the right on hover.
        'arrow-nudge': {
          '0%, 100%': { transform: 'translateX(0)' },
          '50%': { transform: 'translateX(3px)' },
        },
        // Slide-in from the left — for the eyebrow kicker on mount.
        // Short, confident. Not a delicate fade — an editorial slide.
        'slide-in-left': {
          '0%':   { opacity: '0', transform: 'translateX(-24px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        // Slam-in — diagonal arrival for the report card. Comes in
        // rotated off-axis and settles into its resting 2° tilt.
        // "Thrown onto the desk" feel. Brief blur clears on land.
        'slam-in': {
          '0%':   { opacity: '0', transform: 'translate(-24px, 40px) rotate(-8deg)', filter: 'blur(4px)' },
          '70%':  { opacity: '1', transform: 'translate(0, 0) rotate(3deg)',          filter: 'blur(0)' },
          '100%': { opacity: '1', transform: 'translate(0, 0) rotate(2deg)',          filter: 'blur(0)' },
        },
        // Thud-in — price sticker entrance. Overshoots scale, settles.
        // Followed immediately by the existing sticker-wobble loop, so
        // timing here is tight (0.55s) to hand off cleanly.
        'thud-in': {
          '0%':   { opacity: '0', transform: 'scale(0.4) rotate(-14deg)' },
          '60%':  { opacity: '1', transform: 'scale(1.08) rotate(-4deg)' },
          '100%': { opacity: '1', transform: 'scale(1) rotate(-6deg)' },
        },
        // Number punch — oversized "01/02/03" step numerals land with
        // a scale overshoot, like a stamp hitting the page. Same
        // feeling as stamp-in but scaled up for the display size.
        'number-punch': {
          '0%':   { opacity: '0', transform: 'translateY(-8px) scale(1.25)' },
          '55%':  { opacity: '1', transform: 'translateY(0) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        // Check pop — the green tick bullets in the pricing list get
        // a tiny scale+rotate pop as the user reads down. Non-looping,
        // staggered via animation-delay on each list item.
        'check-pop': {
          '0%':   { opacity: '0', transform: 'scale(0.4) rotate(-30deg)' },
          '70%':  { opacity: '1', transform: 'scale(1.15) rotate(8deg)' },
          '100%': { opacity: '1', transform: 'scale(1) rotate(0)' },
        },
        // Tilt wobble — a slower, broader sway than sticker-wobble,
        // sized for the big pricing card. Barely-there movement.
        'tilt-wobble': {
          '0%, 100%': { transform: 'rotate(-0.6deg)' },
          '50%':      { transform: 'rotate(0.6deg)' },
        },
        // Stress shake — tiny horizontal tremor for the stress marks
        // radiating from the "stressed" character's head. Short
        // amplitude so it reads as jitters, not wobble.
        'stress-shake': {
          '0%, 100%': { transform: 'translateX(0)' },
          '25%':      { transform: 'translateX(-1px) rotate(-3deg)' },
          '75%':      { transform: 'translateX(1px) rotate(3deg)' },
        },
        // Phone wobble — the "stressed" character's extra phones drift
        // around on a slow cycle. Paired with slightly offset delays
        // to avoid lock-step motion.
        'phone-wobble': {
          '0%, 100%': { transform: 'translateY(0) rotate(0deg)' },
          '50%':      { transform: 'translateY(-2px) rotate(4deg)' },
        },
        // Ray pulse — the lime rays radiating out of the "magic"
        // phone fade and scale slightly, suggesting the AI is actively
        // working. Scale origin set in the consuming element.
        'ray-pulse': {
          '0%, 100%': { opacity: '0.6', transform: 'scale(0.95)' },
          '50%':      { opacity: '1',   transform: 'scale(1.08)' },
        },
        // Question bob — floating "?" marks above the puzzled
        // character's head gently bob up and down.
        'question-bob': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%':      { transform: 'translateY(-3px)' },
        },
        // Curly draw — SVG path self-draws from 0% to 100% of its
        // length. Used by the curly arrow under the caption.
        'curly-draw': {
          '0%':   { strokeDashoffset: '1' },
          '100%': { strokeDashoffset: '0' },
        },
        // Sweep rays — the slow rotating lime-deep "rays" behind the
        // final CTA section. Adds light movement to what would
        // otherwise be a large flat block of color.
        'sweep-rays': {
          '0%':   { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'fade-up': 'fade-up 0.6s ease-out both',
        'marquee': 'marquee 40s linear infinite',
        'sticker-wobble': 'sticker-wobble 5s ease-in-out infinite',
        'stamp-in': 'stamp-in 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) both',
        'paint-in': 'paint-in 0.5s cubic-bezier(0.65, 0, 0.35, 1) both',
        'caret-blink': 'caret-blink 1.1s steps(1) infinite',
        'arrow-nudge': 'arrow-nudge 1.2s ease-in-out infinite',
        'slide-in-left': 'slide-in-left 0.5s cubic-bezier(0.22, 1, 0.36, 1) both',
        'slam-in': 'slam-in 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) both',
        'thud-in': 'thud-in 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) both',
        'number-punch': 'number-punch 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) both',
        'check-pop': 'check-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both',
        'tilt-wobble': 'tilt-wobble 8s ease-in-out infinite',
        // Character + flourish keyframes. Each one is applied via
        // `motion-safe:animate-[...]` arbitrary values in the JSX
        // rather than a utility class, so we don't need to register a
        // name-per-variant here. Registering the keyframes above is
        // enough for the `animate-[stress-shake_...]` lookup to work.
        'sweep-rays': 'sweep-rays 40s linear infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
