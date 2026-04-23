// Empty stub for the `server-only` package.
//
// Next.js ships `server-only` internally at node_modules/next/dist/
// compiled/server-only and resolves it via a webpack alias. Vitest uses
// Vite's resolver instead, which can't find the package — every import
// of `server-only` blows up with "Cannot find package 'server-only'".
//
// We keep `import 'server-only';` in our source files so a misplaced
// client import fails at Next's compile step. Tests run under Node,
// so this stub makes them importable without affecting runtime.
//
// Aliased in vitest.config.ts:
//   alias: { 'server-only': '/path/to/tests/stubs/server-only.ts' }
export {};
