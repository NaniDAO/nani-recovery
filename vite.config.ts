import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * One self-contained file.
 *
 * A recovery page is reached on the worst day someone has had with this wallet,
 * and it must not have a bad day of its own. Inlining everything means no CDN
 * to be down, no second request to fail halfway, and a build whose SHA-256 can
 * be published — which matters because "nani-recovery.com" writes itself, and a
 * page that can be verified by hash is one a panicking person can be told to
 * check.
 *
 * Relative base so it serves correctly from a subdomain root, a subdirectory,
 * or an IPFS gateway path.
 */
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
});
