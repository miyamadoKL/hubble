import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Monaco + the ANTLR grammar + ECharts are large; isolate them into their own
  // chunks so the initial app payload stays small (design.md §8 "チャンク分離").
  // The editor and charts are loaded via dynamic import, so these only download
  // when a cell renders / a chart tab is opened.
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('monaco-editor')) return 'monaco';
          if (id.includes('/trino-lang/generated/')) return 'trino-grammar';
          if (id.includes('antlr4ng') || id.includes('antlr4-c3')) return 'antlr';
          if (id.includes('echarts') || id.includes('zrender')) return 'echarts';
          return undefined;
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8081',
        changeOrigin: true,
      },
    },
  },
});
