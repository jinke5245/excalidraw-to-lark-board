import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { PNG_SIGNATURE } from "../converter/index.js";
import type { RasterAsset } from "../converter/index.js";
import { createPublicFetcher } from "./public-web.js";

const TIMEOUT = 25_000;
const RESOURCE_TYPES = new Set(["document", "stylesheet", "font", "image"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function viewportFor(element: Record<string, unknown>) {
  const { width, height } = element;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![width, height].every(
      (dimension) =>
        Number.isFinite(dimension) && dimension > 0 && dimension <= 4096,
    ) ||
    width * height > 12_000_000
  ) {
    throw new Error(
      "Snapshot needs positive dimensions within 4096 px and 12 megapixels",
    );
  }
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

async function renderIframe(
  page: Page,
  element: Record<string, unknown>,
): Promise<Buffer> {
  const customData = isRecord(element.customData)
    ? element.customData
    : undefined;
  const generation = customData?.generationData;
  const html = isRecord(generation) ? generation.html : undefined;
  if (typeof html !== "string" || !html.trim())
    throw new Error("Iframe has no generated HTML");
  const origin = "http://iframe-render.invalid/";
  const csp =
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
  // A fulfilled origin avoids Chrome's about:blank/srcdoc site-isolation crash.
  await page.route(origin, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: html,
      headers: { "content-security-policy": csp },
    }),
  );
  await page.goto(origin, { waitUntil: "load", timeout: TIMEOUT });
  return page.screenshot({ type: "png", timeout: TIMEOUT });
}

async function renderEmbeddable(page: Page, link: unknown): Promise<Buffer> {
  if (typeof link !== "string")
    throw new Error("Embed screenshot requires a public HTTP(S) URL");
  const fetchPublic = createPublicFetcher(TIMEOUT);
  const main = await fetchPublic(link);
  if (main.status < 200 || main.status >= 300 || !main.body.length) {
    throw new Error(`Embed page returned HTTP ${main.status}`);
  }
  await page.route("**/*", async (route) => {
    const captured = route.request();
    if (
      captured.method() !== "GET" ||
      !RESOURCE_TYPES.has(captured.resourceType())
    ) {
      await route.abort();
      return;
    }
    try {
      const address = new URL(captured.url());
      address.hash = "";
      const initial = new URL(main.url);
      initial.hash = "";
      // A remote HTML refresh must not navigate away from the embeddable being captured.
      if (
        captured.resourceType() === "document" &&
        address.href !== initial.href
      ) {
        await route.abort();
        return;
      }
      const response =
        address.href === initial.href ? main : await fetchPublic(address);
      await route.fulfill(response);
    } catch {
      await route.abort().catch(() => {});
    }
  });
  const response = await page.goto(main.url, {
    waitUntil: "load",
    timeout: TIMEOUT,
  });
  if (!response?.ok())
    throw new Error("Embed navigation did not return a rendered page");
  return page.screenshot({ type: "png", timeout: TIMEOUT });
}

/** Render saved HTML, Magic Frames and public embeds into PNG assets keyed by element ID. */
export async function renderSnapshots(
  scene: unknown,
  elementIds: string[],
): Promise<Map<string, RasterAsset>> {
  if (!isRecord(scene) || !Array.isArray(scene.elements)) {
    throw new Error("Expected an Excalidraw scene with an elements array");
  }
  const elements = scene.elements.filter(isRecord);
  const byId = new Map(
    elements
      .filter((element) => !element.isDeleted)
      .map((element) => [element.id, element]),
  );
  const jobs = elementIds.map((id) => {
    const element = byId.get(id);
    const type = element?.type;
    if (
      !element ||
      (type !== "iframe" && type !== "magicframe" && type !== "embeddable")
    ) {
      throw new Error(
        `${id}: expected an existing iframe, magicframe or embeddable`,
      );
    }
    return { id, type, element, viewport: viewportFor(element) };
  });
  const snapshots = new Map<string, RasterAsset>();
  if (!jobs.length) return snapshots;
  const configuredChrome = process.env.FEISHU_CHROME_PATH;
  const deadline = AbortSignal.timeout(45_000 + 35_000 * jobs.length);
  const browser = await chromium.launch({
    ...(configuredChrome
      ? { executablePath: configuredChrome }
      : { channel: "chrome" }),
    headless: true,
    chromiumSandbox: true,
    timeout: TIMEOUT,
    // A request outside the Playwright interception path must fail closed as well.
    args: [
      "--proxy-server=http://proxy.invalid:9",
      "--proxy-bypass-list=<-loopback>",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  });
  const closeTimedOutBrowser = () => {
    void browser
      .close({ reason: "automatic screenshot rendering timed out" })
      .catch(() => {});
  };
  deadline.addEventListener("abort", closeTimedOutBrowser, { once: true });
  try {
    deadline.throwIfAborted();
    for (const { id, type, element, viewport } of jobs) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        offline: true,
        javaScriptEnabled: type === "magicframe",
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      try {
        await context.route("**/*", (route) => route.abort());
        const page = await context.newPage();
        let data: Buffer;
        if (type === "iframe") {
          data = await renderIframe(page, element);
        } else if (type === "embeddable") {
          data = await renderEmbeddable(page, element.link);
        } else {
          const { renderMagicFrame } = await import("./magicframe.js");
          const background = isRecord(scene.appState)
            ? scene.appState.viewBackgroundColor
            : undefined;
          data = await renderMagicFrame(
            page,
            {
              elements,
              files: scene.files ?? {},
              viewBackgroundColor:
                typeof background === "string" ? background : "#ffffff",
            },
            id,
          );
        }
        if (!data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
          throw new Error("renderer did not return PNG data");
        }
        snapshots.set(id, { suffix: ".png", data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${id}: ${message}`, { cause: error });
      } finally {
        await context.close();
      }
    }
  } catch (error) {
    if (deadline.aborted)
      throw new Error("automatic screenshot rendering timed out", {
        cause: error,
      });
    throw error;
  } finally {
    deadline.removeEventListener("abort", closeTimedOutBrowser);
    await browser.close();
  }
  return snapshots;
}
