import { Buffer } from "node:buffer";
import { hasKey, isRecord } from "./model.js";
import type { InputRecord, SourceElement } from "./model.js";

/** Identifying bytes at the start of a PNG. */
const PNG_SIGNATURE = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

/** Validated raster bytes with the extension used for upload. */
export type RasterAsset = { suffix: ".png" | ".jpg"; data: Buffer };

/** Decode and validate an embedded PNG or JPEG data URL. */
function rasterAsset(value: unknown): RasterAsset {
  if (typeof value !== "string") {
    throw new TypeError("expected a PNG or JPEG data URL");
  }
  const separator = value.indexOf(",");
  const header = value.slice(0, separator);
  if (
    separator < 0 ||
    (header !== "data:image/png;base64" && header !== "data:image/jpeg;base64")
  ) {
    throw new Error("expected an embedded PNG or JPEG");
  }
  const encoded = value.slice(separator + 1);
  const data = Buffer.from(encoded, "base64");
  if (data.toString("base64") !== encoded) {
    throw new Error("invalid base64 image data");
  }
  const suffix = header === "data:image/png;base64" ? ".png" : ".jpg";
  const signature =
    suffix === ".png"
      ? PNG_SIGNATURE
      : Buffer.from([
          0xff,
          0xd8,
          0xff,
        ]);
  if (!data.subarray(0, signature.length).equals(signature)) {
    throw new Error(`invalid ${suffix} image signature`);
  }
  return { suffix, data };
}

/** Find the original image bytes for an Excalidraw image element. */
export function embeddedRaster(
  scene: InputRecord,
  element: SourceElement,
): RasterAsset {
  const scale =
    element.scale === undefined
      ? [
          1,
          1,
        ]
      : element.scale;
  // shortcut: preserve original pixels, add transforms when crop or flip support is needed.
  if (
    element.crop ||
    !Array.isArray(scale) ||
    scale.length !== 2 ||
    scale[0] !== 1 ||
    scale[1] !== 1
  ) {
    throw new Error(
      `${element.id}: cropped or flipped images are not supported`,
    );
  }
  const { files } = scene;
  const asset =
    isRecord(files) && hasKey(files, element.fileId)
      ? files[element.fileId]
      : undefined;
  if (!isRecord(asset)) {
    throw new TypeError(`${element.id}: missing embedded image file`);
  }
  return rasterAsset(asset.dataURL);
}
