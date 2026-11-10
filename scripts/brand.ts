/**
 * Generates app/brand assets from the source logos in assets/logos.
 * Run: pnpm brand   (re-run whenever the logo changes; outputs are committed)
 *
 * - packages/desktop/build/icon.icns    macOS app icon (electron-builder buildResources)
 * - packages/desktop/build/icon.png     1024px fallback (Linux / Windows later)
 * - packages/desktop/src/renderer/public/favicon.png   window/tab favicon (WebUI later)
 *
 * The in-app mark is not generated: it is the inline React component
 * packages/ui/src/brand/NexusMark.tsx, so it can follow the theme via currentColor.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'assets/logos/nexus-app-icon.svg');
const buildDir = join(root, 'packages/desktop/build');
const publicDir = join(root, 'packages/desktop/src/renderer/public');
mkdirSync(buildDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

const svg = readFileSync(source);
// Render from vector at each size (crisper than downscaling one bitmap).
const render = (size: number, file: string) =>
  sharp(svg, { density: Math.max(72, (72 * size) / 512) })
    .resize(size, size)
    .png()
    .toFile(file);

await render(1024, join(buildDir, 'icon.png'));
await render(64, join(publicDir, 'favicon.png'));

if (process.platform === 'darwin') {
  const work = mkdtempSync(join(tmpdir(), 'nexus-iconset-'));
  const iconset = join(work, 'icon.iconset');
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    await render(size, join(iconset, `icon_${size}x${size}.png`));
    await render(size * 2, join(iconset, `icon_${size}x${size}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')]);
  rmSync(work, { recursive: true, force: true });
  console.info('✓ build/icon.icns');
} else {
  console.warn('! icon.icns needs macOS iconutil; skipped');
}
console.info('✓ build/icon.png, renderer/public/favicon.png');
