import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/**/*.d.ts'],
      // No hard thresholds yet — Stage 6 sets baseline; thresholds added once
      // current coverage is measured and we know what reasonable numbers look like.
    },
  },
});
