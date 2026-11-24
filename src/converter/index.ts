import {
  bounds,
  canvasPath,
  clamp,
  color,
  connectorNode,
  geometry,
  nodeStyle,
  round,
} from "./drawing.js";
import {
  PREFIXES,
  SHAPES,
  describe,
  hasKey,
  isConnector,
  isRecord,
  number,
} from "./model.js";
import type {
  BaseNode,
  BoardNode,
  BoardText,
  SourceElement,
  SupportedElement,
} from "./model.js";
import { embeddedRaster, rasterAsset } from "./raster.js";
import type { RasterAsset } from "./raster.js";

export type { BoardNode } from "./model.js";
export { PNG_SIGNATURE } from "./raster.js";
export type { RasterAsset } from "./raster.js";

/** Inputs for image collection and snapshot overrides during conversion. */
export type ConversionOptions = {
  /** Receives image bytes keyed by the corresponding Feishu node ID. */
  assets?: Map<string, RasterAsset>;
  /** Caller-supplied snapshots keyed by the source element ID. */
  snapshots?: Map<string, RasterAsset>;
  /** Renders selected elements that lack a supplied or embedded snapshot. */
  autoRender?: (elementIds: string[]) => Promise<Map<string, RasterAsset>>;
};

function isSnapshotType(type: unknown): boolean {
  return type === "iframe" || type === "magicframe" || type === "embeddable";
}

function nodeText(element: SourceElement, bound = false): BoardText {
  const text = element.text === undefined ? element.originalText : element.text;
  if (typeof text !== "string") {
    throw new TypeError(`${element.id}: text must be a string`);
  }
  const align =
    element.textAlign === undefined
      ? bound
        ? "center"
        : "left"
      : element.textAlign;
  const fontSize = element.fontSize === undefined ? 20 : element.fontSize;
  const verticalAlign = {
    top: "top",
    middle: "mid",
    bottom: "bottom",
  } as const;
  return {
    text,
    font_size: Math.max(1, round(number(fontSize, "fontSize"))),
    horizontal_align: align === "center" || align === "right" ? align : "left",
    vertical_align: hasKey(verticalAlign, element.verticalAlign)
      ? verticalAlign[element.verticalAlign]
      : bound
        ? "mid"
        : "top",
    text_color: color(element.strokeColor) ?? "#1b1b1f",
    text_color_type: 1,
  };
}

function snapshotLink(node: BoardNode, index: number, url: unknown): BoardNode {
  const error = "embeddable requires a valid HTTP or HTTPS source link";
  if (
    typeof url !== "string" ||
    url.length > 1000 ||
    /[\s\\]/.test(url) ||
    [...url].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error(error);
  }
  const authority = /^https?:\/\/([^/?#]+)/i.exec(url)?.[1];
  if (!authority || authority.includes("@") || !URL.canParse(url)) {
    throw new Error(error);
  }
  const caption = "打开原网页 ↗";
  const link = {
    element_type: 1,
    link_element: {
      herf: url,
      text: caption,
      text_style: { font_size: 18, text_color: "#1456f0", underline: true },
    },
  };
  return {
    id: `a1:${index}`,
    type: "text_shape",
    x: node.x,
    y: node.y + node.height + 10,
    width: Math.max(node.width, 160),
    height: 28,
    z_index: node.z_index,
    text: {
      text: caption,
      font_size: 18,
      horizontal_align: "left",
      vertical_align: "mid",
      rich_text: { paragraphs: [{ paragraph_type: 0, elements: [link] }] },
    },
    ...(node.parent_id !== undefined && { parent_id: node.parent_id }),
  };
}

/**
 * Convert Excalidraw v2 scene JSON into a Feishu create-nodes payload.
 * Use the options to collect images or generate screenshots without contacting Feishu.
 */
export async function convert(
  scene: unknown,
  { assets, snapshots: suppliedSnapshots, autoRender }: ConversionOptions = {},
): Promise<{ payload: { nodes: BoardNode[] }; warnings: string[] }> {
  if (
    !isRecord(scene) ||
    scene.type !== "excalidraw" ||
    scene.version !== 2 ||
    !Array.isArray(scene.elements)
  ) {
    throw new Error("expected an Excalidraw v2 scene with an elements array");
  }
  const live = new Map<string, SourceElement>();
  const seen = new Set<string>();
  for (const element of scene.elements as unknown[]) {
    if (!isRecord(element) || typeof element.id !== "string" || !element.id) {
      throw new Error("every element must have a nonempty string id");
    }
    const { id } = element;
    if (seen.has(id)) throw new Error(`duplicate element id: ${id}`);
    seen.add(id);
    if (!element.isDeleted) live.set(id, { ...element, id });
  }

  const snapshots = new Map(suppliedSnapshots);
  const targets = new Map(
    [...live].filter(([, element]) => isSnapshotType(element.type)),
  );
  for (const [id, { customData }] of targets) {
    if (
      snapshots.has(id) ||
      !isRecord(customData) ||
      !Object.hasOwn(customData, "feishuSnapshot")
    )
      continue;
    const asset = rasterAsset(customData.feishuSnapshot);
    if (asset.suffix !== ".png")
      throw new Error(`${id}: embedded snapshot must be PNG`);
    snapshots.set(id, asset);
  }
  for (const id of snapshots.keys()) {
    if (!targets.has(id))
      throw new Error(
        `${id}: snapshot must target an existing iframe, magicframe, or embeddable`,
      );
  }
  const selected = [...(autoRender ? targets : snapshots).keys()];
  const flattened = new Set<unknown>(
    selected.filter((id) => targets.get(id)?.type === "magicframe"),
  );
  for (const id of selected) {
    if (flattened.has(targets.get(id)?.frameId)) {
      throw new Error(
        `${id}: nested embeds inside a snapshotted magicframe are unsupported`,
      );
    }
  }
  const missing = selected.filter((id) => !snapshots.has(id));
  if (autoRender && missing.length) {
    const generated = await autoRender(missing);
    for (const id of missing) {
      const snapshot = generated.get(id);
      if (!snapshot)
        throw new Error(`${id}: renderer did not return a snapshot`);
      snapshots.set(id, snapshot);
    }
  }

  const warnings: string[] = [];
  const elements = new Map<string, SupportedElement>();
  for (const [id, element] of live) {
    if (flattened.has(element.frameId)) continue;
    const type = snapshots.has(id) ? "image" : element.type;
    if (!hasKey(PREFIXES, type)) {
      warnings.push(
        `${id}: skipped unsupported element type ${describe(type)}`,
      );
      continue;
    }
    elements.set(id, { ...element, type });
  }

  const labels = new Map<string, BoardText>();
  const boundLabels = new Set<string>();
  for (const element of elements.values()) {
    if (element.type !== "text" || typeof element.containerId !== "string")
      continue;
    const container = elements.get(element.containerId);
    if (
      container &&
      !labels.has(container.id) &&
      (hasKey(SHAPES, container.type) ||
        isConnector(container.type) ||
        container.type === "stickynote")
    ) {
      labels.set(container.id, nodeText(element, true));
      boundLabels.add(element.id);
    }
  }

  const sections = new Map<string, BaseNode & BoardNode>();
  const ordered = [...elements.values()];
  for (const [offset, element] of ordered.entries()) {
    if (element.type !== "frame") continue;
    const index = offset + 1;
    const title = element.name || "分区";
    if (typeof title !== "string")
      throw new TypeError(`${element.id}: frame name must be a string or null`);
    sections.set(element.id, {
      id: `t1:${index}`,
      type: "section",
      z_index: index,
      ...geometry(element),
      section: { title },
    });
  }

  const nodes: BoardNode[] = [...sections.values()];
  const connectors: { element: SupportedElement; base: BaseNode }[] = [];
  const shapes = new Map<string, BaseNode>(sections);
  for (const [offset, element] of ordered.entries()) {
    const { id, type } = element;
    if (boundLabels.has(id) || type === "frame") continue;
    const index = offset + 1;
    const base = {
      id: `${PREFIXES[type]}1:${index}`,
      z_index: index,
      ...geometry(element),
    };
    const label = labels.get(id);
    let node: BaseNode & BoardNode;
    if (isConnector(type)) {
      connectors.push({ element, base });
      continue;
    }
    if (type === "text") {
      node = { ...base, type: "text_shape", text: nodeText(element) };
    } else if (type === "image") {
      if (!assets)
        throw new Error(
          `${id}: image nodes need a Feishu target URL or --whiteboard-token`,
        );
      assets.set(base.id, snapshots.get(id) ?? embeddedRaster(scene, element));
      node = {
        ...base,
        type: "image",
        image: {},
        style: { border_style: "none" },
      };
    } else if (type === "stickynote") {
      // shortcut: use Feishu's yellow preset, add a color mapping when more themes are needed.
      node = {
        ...base,
        type: "sticky_note",
        sticky_note: { show_author_info: false },
        style: {
          fill_color: "#fef1ce",
          fill_opacity: 100,
          fill_color_type: 0,
          theme_fill_color_code: 0,
        },
        ...(label && { text: label }),
      };
    } else if (type === "freedraw") {
      const points = canvasPath(element, base, 1);
      const { x, y, right, bottom } = bounds(points);
      const width = clamp(
        round(
          number(
            element.strokeWidth === undefined ? 2 : element.strokeWidth,
            "strokeWidth",
          ),
        ),
        1,
        23,
      );
      node = {
        ...base,
        x,
        y,
        width: Math.max(1, right - x),
        height: Math.max(1, bottom - y),
        angle: 0,
        type: "paint",
        paint: {
          type: "marker",
          width,
          color: color(element.strokeColor) ?? "#1b1b1f",
          lines: points.map(([px, py]) => ({ x: px - x, y: py - y })),
        },
      };
      if (
        (Array.isArray(element.pressures)
          ? element.pressures.length > 0
          : element.pressures) ||
        element.simulatePressure
      ) {
        warnings.push(`${id}: pressure converted to a uniform stroke width`);
      }
    } else {
      const shape =
        type === "rectangle" && element.roundness ? "round_rect" : SHAPES[type];
      node = {
        ...base,
        type: "composite_shape",
        composite_shape: { type: shape },
        style: nodeStyle(element),
        ...(label && { text: label }),
      };
    }
    shapes.set(id, node);
    const section =
      typeof element.frameId === "string"
        ? sections.get(element.frameId)
        : undefined;
    if (section) {
      node = {
        ...node,
        parent_id: section.id,
        x: node.x - section.x,
        y: node.y - section.y,
      };
    }
    nodes.push(node);
    if (snapshots.has(id) && live.get(id)?.type === "embeddable") {
      nodes.push(snapshotLink(node, index, element.link));
    }
  }

  for (const { element, base } of connectors) {
    const node = connectorNode(
      element,
      base,
      shapes,
      labels.get(element.id),
      warnings,
    );
    // shortcut: keep connectors at canvas level so they can span sections, revisit local arrows.
    if (sections.size) node.z_index += elements.size;
    nodes.push(node);
  }
  if (nodes.length < 1 || nodes.length > 3000) {
    throw new Error(
      "expected 1–3000 convertible nodes for a single Feishu request",
    );
  }
  for (const { id, x, y, width, height } of nodes) {
    if (![x, y, width, height].every(Number.isFinite)) {
      throw new Error(id + ": converted coordinates must be finite");
    }
  }
  return { payload: { nodes }, warnings };
}
