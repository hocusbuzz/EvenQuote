import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Vitest configuration.
//
// Kept deliberately small: pure Node tests, no DOM, no transforms beyond
// what Vite does out of the box. Mirrors the tsconfig path alias so
// `@/lib/...` resolves the same way as the app.
//
// Test files live next to source (lib/text/pii.test.ts) or under
// tests/. Both patterns are picked up by the default glob.

export default defineConfig({
  // tsconfig has `"jsx": "preserve"` (Next expects to do the transform
  // itself at build time). Vitest 4 uses oxc, not esbuild, so we need
  // to tell oxc to transform JSX here — otherwise .tsx components fail
  // at import-analysis with "invalid JS syntax". `runtime: 'automatic'`
  // matches what Next 14 + React 18 expect at runtime and is the oxc
  // default; it's stated explicitly so the intent is obvious at review.
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.{test,spec}.{ts,tsx}'],
    // .claude/** keeps vitest from descending into Claude Code's worktree
    // dir (`.claude/worktrees/<branch>/...`). Each worktree is a separate
    // checkout — usually on a different commit, often without node_modules
    // — so picking up its test files double-counts the suite and emits
    // spurious "import failed" failures. .gitignore already excludes the
    // dir from version control; this matches.
    exclude: ['node_modules/**', '.next/**', '.claude/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
      // Next.js ships `server-only` internally via a webpack alias.
      // Vitest (Vite) can't resolve it, so we stub it for tests.
      // See tests/stubs/server-only.ts for the full story.
      'server-only': path.resolve(__dirname, './tests/stubs/server-only.ts'),
    },
  },
});
