import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

const siteDirectory = fileURLToPath(new URL('.', import.meta.url));
const dashboardDirectory = fileURLToPath(new URL('../public', import.meta.url));
const sharedDirectory = fileURLToPath(new URL('../shared', import.meta.url));

export default defineConfig({
  site: 'https://johncwaters.github.io',
  base: '/glimmervoid',
  vite: {
    server: {
      fs: {
        allow: [siteDirectory, dashboardDirectory, sharedDirectory],
      },
    },
  },
});
