import { fileURLToPath } from 'node:url'
import { defineProject } from 'vitest/config'
import { readManifest } from './scripts/bundle-metadata.mjs'
import { manualIntegrations } from './test/e2e/support/integrations'

const remoteDshEngine = (readManifest(fileURLToPath(new URL('.', import.meta.url))).engines as { dsh: { recommend: string, minimum: string } }).dsh

export default defineProject({
  define: {
    __REMOTE_DSH_RECOMMEND__: JSON.stringify(remoteDshEngine.recommend),
    __REMOTE_DSH_MINIMUM__: JSON.stringify(remoteDshEngine.minimum),
  },
  test: {
    name: 'plugin',
    include: ['test/e2e/plugins/**/*.e2e.ts', ...manualIntegrations().map(kind => `test/e2e/integrations/${kind}.e2e.ts`)],
    exclude: ['**/archive/**', '**/dist/**', '**/node_modules/**', '**/target/**'],
    globalSetup: ['./test/e2e/setup-plugin.ts'],
    environment: 'node',
    fileParallelism: false,
    allowOnly: false,
    retry: 0,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
