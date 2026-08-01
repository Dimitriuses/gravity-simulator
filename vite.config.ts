// `vitest/config` rather than `vite` so the `test` block below is typed.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths so one build works from the dev server, from
  // `vite preview`, and from a GitHub Pages project sub-path
  // (https://<user>.github.io/gravity-simulator/) without the repo name being
  // baked into the bundle. The app is a single canvas page with no client-side
  // routing, so no `404.html` fallback is needed.
  base: './',
  server: {
    port: 3000,
    open: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // p5 alone is ~1 MB minified and is split into its own chunk below, so the
    // default 500 kB limit can never be met. Raised so a clean build reports
    // zero warnings and real growth in the app bundle would stand out.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Keep the library separate from the simulation code: p5 never changes
        // between deploys, the ~15 kB of app code does.
        manualChunks: { p5: ['p5'] },
      },
    },
  },
  test: {
    // The simulation core (Vector2D / Particle / PhysicsEngine / VectorField)
    // has no p5 dependency, so the whole physics layer tests under plain Node
    // with no DOM and no canvas.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
