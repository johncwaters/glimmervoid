import { fileURLToPath } from 'node:url';
import { defineConfig, envField } from 'astro/config';

const siteDirectory = fileURLToPath(new URL('.', import.meta.url));
const dashboardDirectory = fileURLToPath(new URL('../public', import.meta.url));
const sharedDirectory = fileURLToPath(new URL('../shared', import.meta.url));

export default defineConfig({
  site: 'https://glimmervoid.dev',
  env: {
    schema: {
      CLOUD_SIGNUP_OPEN: envField.boolean({ context: 'server', access: 'public', default: false }),
    },
  },
  vite: {
    server: {
      fs: {
        allow: [siteDirectory, dashboardDirectory, sharedDirectory],
      },
    },
  },
});
