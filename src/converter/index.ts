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
import { embeddedRaster } from "./raster.js";
import type { RasterAsset } from "./raster.js";

export type { BoardNode } from "./model.js";
export type { RasterAsset } from "./raster.js";

/** Inputs for image collection during conversion. */
export type ConversionOptions = {
  /** Receives image bytes keyed by the corresponding Feishu node ID. */
  assets?: Map<string, RasterAsset>;
};

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

/**
 * Convert Excalidraw v2 scene JSON into a Feishu create-nodes payload.
 * Use the options to collect native image bytes without contacting Feishu.
 */
export async function convert(
  scene: unknown,
  { assets }: ConversionOptions = {},
): Promise<{ payload: { nodes: BoardNode[] }; warnings: string[] }> {
  if (
    !isRecord(scene) ||
    scene.type !== "excalidraw" ||
    scene.version !== 2 ||
    !Array.isArray(scene.elements)
  ) {
    throw new Error("expected an Excalidraw v2 scene with an elements array");
  }
  const warnings: string[] = [];
  const elements = new Map<string, SupportedElement>();
  const seen = new Set<string>();
  for (const element of scene.elements as unknown[]) {
    if (!isRecord(element) || typeof element.id !== "string" || !element.id) {
      throw new Error("every element must have a nonempty string id");
    }
    const { id, type } = element;
    if (seen.has(id)) throw new Error(`duplicate element id: ${id}`);
    seen.add(id);
    if (element.isDeleted) continue;
    if (!hasKey(PREFIXES, type)) {
      warnings.push(
        `${id}: skipped unsupported element type ${describe(type)}`,
      );
      continue;
    }
    elements.set(id, { ...element, id, type });
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
  for (const [
    offset,
    element,
  ] of ordered.entries()) {
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
  for (const [
    offset,
    element,
  ] of ordered.entries()) {
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
      assets.set(base.id, embeddedRaster(scene, element));
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
          lines: points.map(
            ([
              px,
              py,
            ]) => ({ x: px - x, y: py - y }),
          ),
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
    if (
      ![
        x,
        y,
        width,
        height,
      ].every(Number.isFinite)
    ) {
      throw new Error(id + ": converted coordinates must be finite");
    }
  }
  return { payload: { nodes }, warnings };
}
