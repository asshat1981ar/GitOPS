import { copyFile, mkdir } from 'node:fs/promises';

const notices = new URL('../dist/licenses/', import.meta.url);
await mkdir(notices, { recursive: true });
await Promise.all([
  copyFile(new URL('../node_modules/@fontsource-variable/inter/LICENSE', import.meta.url),
    new URL('inter.txt', notices)),
  copyFile(new URL('../node_modules/bootstrap-icons/LICENSE', import.meta.url),
    new URL('bootstrap-icons.txt', notices)),
]);
