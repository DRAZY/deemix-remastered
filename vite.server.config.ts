import { defineConfig } from 'vite'
import { resolve } from 'path'
import { builtinModules } from 'module'

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`)
])

export default defineConfig({
  resolve: {
    alias: {
      electron: resolve(__dirname, 'electron/electron-shim.ts')
    }
  },
  build: {
    ssr: resolve(__dirname, 'electron/web-server.ts'),
    outDir: 'dist-web',
    target: 'node20',
    emptyOutDir: true,
    rollupOptions: {
      external: (id) => {
        if (id === 'electron') return false
        if (builtins.has(id)) return true
        if (!id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0')) return true
        return false
      },
      output: {
        format: 'cjs',
        entryFileNames: 'web-server.cjs'
      }
    }
  }
})
