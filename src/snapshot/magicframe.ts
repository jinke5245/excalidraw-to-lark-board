import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Page } from "playwright-core";

const rendererOrigin = "http://excalidraw-render.invalid";
const browserModule = `
  import { exportToCanvas } from "@excalidraw/excalidraw";

  window.renderFeishuMagicFrame = async ({ elements, element, files, viewBackgroundColor }) => {
    const canvas = await exportToCanvas({
      elements,
      exportingFrame: element,
      files,
      appState: { exportBackground: true, viewBackgroundColor },
    });
    return canvas.toDataURL("image/png");
  };
`;

/** Excalidraw data passed to the offline Magic Frame canvas. */
interface MagicFrameScene {
  elements: Record<string, unknown>[];
  files: unknown;
  viewBackgroundColor: string;
}

let rendererPromise: ReturnType<typeof loadRenderer> | undefined;

async function loadRenderer() {
  const require = createRequire(import.meta.url);
  const assetDir = dirname(require.resolve("@excalidraw/excalidraw"));
  const { outputFiles } = await build({
    stdin: {
      contents: browserModule,
      resolveDir: dirname(fileURLToPath(import.meta.url)),
      sourcefile: "magicframe-browser.js",
    },
    bundle: true,
    format: "iife",
    minify: true,
    write: false,
    define: { "process.env.NODE_ENV": '"production"' },
    banner: { js: 'window.EXCALIDRAW_ASSET_PATH = location.origin + "/";' },
  });
  const [output] = outputFiles;
  if (!output)
    throw new Error("Excalidraw Magic Frame renderer could not be bundled");
  // shortcut: v0.18.1 adds a CDN font fallback, use the upstream offline asset option when available.
  const bundle = output.text.replace(
    /`https:\/\/esm\.sh\/[^;\n]+?\/dist\/prod\/`/,
    "window.EXCALIDRAW_ASSET_PATH",
  );
  return { bundle, assetDir };
}

/** Render one Magic Frame using the offline Excalidraw canvas and locally installed fonts. */
export async function renderMagicFrame(
  page: Page,
  scene: MagicFrameScene,
  elementId: string,
): Promise<Buffer> {
  const { bundle, assetDir } = await (rendererPromise ??= loadRenderer());
  await page.route(rendererOrigin + "/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/") {
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        headers: {
          "content-security-policy":
            "default-src 'none'; script-src 'self'; font-src 'self' data:; img-src data: blob:; style-src 'unsafe-inline'",
        },
        body: '<!doctype html><meta charset="utf-8"><script src="/renderer.js"></script>',
      });
    }
    if (pathname === "/renderer.js") {
      return route.fulfill({ contentType: "text/javascript", body: bundle });
    }
    if (/^\/fonts\/[\w-]+\/[\w.-]+\.woff2$/.test(pathname)) {
      try {
        const body = await readFile(join(assetDir, pathname.slice(1)));
        return route.fulfill({ contentType: "font/woff2", body });
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(rendererOrigin + "/");

  // The static canvas renderer handles geometry only, so keep saved HTML out of its input.
  const elements = scene.elements.map(({ customData, ...item }) => item);
  const png = await page.evaluate(
    (data) => {
      const renderer = globalThis as typeof globalThis & {
        renderFeishuMagicFrame(input: typeof data): Promise<string>;
      };
      return renderer.renderFeishuMagicFrame(data);
    },
    {
      elements,
      element: elements.find((item) => item.id === elementId),
      files: scene.files,
      viewBackgroundColor: scene.viewBackgroundColor,
    },
  );
  const prefix = "data:image/png;base64,";
  if (!png.startsWith(prefix))
    throw new Error("Excalidraw did not render a PNG for this Magic Frame.");
  return Buffer.from(png.slice(prefix.length), "base64");
}
