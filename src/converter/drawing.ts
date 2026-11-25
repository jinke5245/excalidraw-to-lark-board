import {
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
  Connector,
  Geometry,
  Point,
  Port,
  SnapSide,
  SourceElement,
  SupportedElement,
} from "./model.js";

const ARROW_HEADS = new Map<unknown, string>([
  [
    null,
    "none",
  ],
  [
    "arrow",
    "line_arrow",
  ],
  [
    "triangle",
    "triangle_arrow",
  ],
  [
    "triangle_outline",
    "empty_triangle_arrow",
  ],
  [
    "circle",
    "circle_arrow",
  ],
  [
    "dot",
    "circle_arrow",
  ],
  [
    "circle_outline",
    "empty_circle_arrow",
  ],
  [
    "diamond",
    "diamond_arrow",
  ],
  [
    "diamond_outline",
    "empty_diamond_arrow",
  ],
]);

function pair(value: unknown, field: string): Point {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(`${field}: expected an [x, y] pair`);
  }
  return [
    number(value[0], field),
    number(value[1], field),
  ];
}

/** Round a numeric style value, rounding ties to the closest even integer. */
export function round(value: number): number {
  const lower = Math.floor(value);
  return value - lower === 0.5 && lower % 2 === 0 ? lower : Math.round(value);
}

/** Keep a numeric value within the given limits. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Accept a six-digit scene color, leaving other formats unset. */
export function color(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length === 7 &&
    /^#[a-f0-9]{6}$/i.test(value)
    ? value
    : undefined;
}

/** Read an element bounding box and convert radians to degrees. */
export function geometry(element: SupportedElement): Geometry {
  const { id } = element;
  const x = number(element.x, `${id}.x`);
  const y = number(element.y, `${id}.y`);
  const width = number(element.width, `${id}.width`);
  const height = number(element.height, `${id}.height`);
  const minimum =
    isConnector(element.type) || element.type === "freedraw" ? 0 : 1;
  if (width < minimum || height < minimum) {
    throw new Error(`${id}: invalid width or height`);
  }
  const degrees =
    number(element.angle === undefined ? 0 : element.angle, "angle") *
    (180 / Math.PI);
  const angle = number(degrees, "angle") % 360;
  return { x, y, width, height, angle: angle < 0 ? angle + 360 : angle };
}

/** Translate stroke and fill properties into native node styling. */
export function nodeStyle(
  element: SupportedElement,
): Record<string, string | number> {
  const opacity = clamp(
    number(element.opacity === undefined ? 100 : element.opacity, "opacity"),
    0,
    100,
  );
  const width = number(
    element.strokeWidth === undefined ? 2 : element.strokeWidth,
    "strokeWidth",
  );
  const stroke = element.strokeColor;
  const { strokeStyle } = element;
  const style = {
    border_color: color(stroke) ?? "#1b1b1f",
    border_color_type: 1,
    border_opacity: stroke === "transparent" ? 0 : opacity,
    border_width:
      width <= 1
        ? "extra_narrow"
        : width <= 2
          ? "narrow"
          : width <= 4
            ? "medium"
            : "bold",
    border_style:
      strokeStyle === "dashed"
        ? "dash"
        : strokeStyle === "dotted"
          ? "dot"
          : "solid",
  };
  if (hasKey(SHAPES, element.type)) {
    const fill = color(element.backgroundColor);
    return {
      ...style,
      fill_color: fill ?? "#ffffff",
      fill_color_type: 1,
      fill_opacity: fill ? opacity : 0,
    };
  }
  return style;
}

function rotate(
  [
    px,
    py,
  ]: Point,
  [
    cx,
    cy,
  ]: Point,
  angle: number,
): Point {
  const x = px - cx;
  const y = py - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    cx + x * cos - y * sin,
    cy + x * sin + y * cos,
  ];
}

/** Find the extrema of a nonempty array of path coordinates. */
export function bounds(points: Point[]) {
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const [
    px,
    py,
  ] of points) {
    x = Math.min(x, px);
    y = Math.min(y, py);
    right = Math.max(right, px);
    bottom = Math.max(bottom, py);
  }
  return { x, y, right, bottom };
}

/** Transform an element path to canvas coordinates using its rotation. */
export function canvasPath(
  element: SourceElement,
  node: BaseNode,
  minimum: number,
): Point[] {
  if (!Array.isArray(element.points) || element.points.length < minimum) {
    throw new Error(
      `${element.id}: points must contain at least ${minimum} [x, y] pairs`,
    );
  }
  const points = element.points.map((point) => pair(point, "points"));
  const { x, y, right, bottom } = bounds(points);
  const center: Point = [
    (x + right) / 2,
    (y + bottom) / 2,
  ];
  return points.map((point) => {
    const [
      px,
      py,
    ] = rotate(point, center, node.angle * (Math.PI / 180));
    return [
      node.x + px,
      node.y + py,
    ];
  });
}

function endpoint(
  element: SupportedElement,
  side: "start" | "end",
  point: Point,
  shapes: Map<string, BaseNode>,
  warnings: string[],
): [
  Port,
  Point,
] {
  const arrowhead = element[`${side}Arrowhead`];
  const head =
    arrowhead === undefined
      ? side === "end" && element.type === "arrow"
        ? "arrow"
        : null
      : arrowhead;
  const arrowStyle = ARROW_HEADS.get(head);
  if (arrowStyle === undefined) {
    warnings.push(
      `${element.id}: ${describe(head)} arrowhead approximated as line_arrow`,
    );
  }
  const arrow_style = arrowStyle ?? "line_arrow";
  const binding = element[`${side}Binding`];
  if (binding != null && !isRecord(binding)) {
    throw new Error(`${element.id}: ${side}Binding must be an object or null`);
  }
  if (binding && Object.keys(binding).length > 0) {
    const target = binding.elementId;
    const shape = typeof target === "string" ? shapes.get(target) : undefined;
    if (shape) {
      const { x, y, width, height, angle } = shape;
      const center: Point = [
        x + width / 2,
        y + height / 2,
      ];
      const radians = angle * (Math.PI / 180);
      const local = rotate(point, center, -radians);
      const [
        u,
        v,
      ] =
        binding.fixedPoint == null
          ? [
              (local[0] - x) / width,
              (local[1] - y) / height,
            ]
          : pair(binding.fixedPoint, "fixedPoint");
      const position = { x: clamp(u, 0, 1), y: clamp(v, 0, 1) };
      // shortcut: use the nearest side as the snap direction, revisit for interior bindings.
      const distances = {
        left: position.x,
        right: 1 - position.x,
        top: position.y,
        bottom: 1 - position.y,
      };
      let snap: SnapSide = "left";
      for (const candidate of [
        "right",
        "top",
        "bottom",
      ] as const) {
        if (distances[candidate] < distances[snap]) snap = candidate;
      }
      const attachment = { id: shape.id, snap_to: snap, position };
      const anchor = rotate(
        [
          x + position.x * width,
          y + position.y * height,
        ],
        center,
        radians,
      );
      return [
        { arrow_style, attached_object: attachment },
        anchor,
      ];
    }
    warnings.push(
      `${element.id}: ${side} binding target ${describe(target)} unavailable; kept a free endpoint`,
    );
  }
  return [
    { arrow_style, position: { x: point[0], y: point[1] } },
    point,
  ];
}

/** Create a line or arrow node with coordinates and optional bindings. */
export function connectorNode(
  element: SupportedElement,
  node: BaseNode,
  shapes: Map<string, BaseNode>,
  label: BoardText | undefined,
  warnings: string[],
): BoardNode {
  const path = canvasPath(element, node, 2);
  const [first] = path;
  let last = path.at(-1);
  if (!first || !last) {
    throw new Error(
      `${element.id}: points must contain at least 2 [x, y] pairs`,
    );
  }
  if (element.type === "line" && element.polygon) {
    if (first[0] !== last[0] || first[1] !== last[1]) {
      path.push(first);
      last = first;
    }
    if (
      element.backgroundColor !== undefined &&
      element.backgroundColor !== "transparent"
    ) {
      warnings.push(`${element.id}: closed polygon fill is not preserved`);
    }
  }
  const [
    start,
    startAnchor,
  ] = endpoint(element, "start", first, shapes, warnings);
  const [
    end,
    endAnchor,
  ] = endpoint(element, "end", last, shapes, warnings);
  path[0] = startAnchor;
  path[path.length - 1] = endAnchor;
  const { x, y, right, bottom } = bounds(path);
  const connector: Connector = {
    shape: path.length > 2 ? "polyline" : "straight",
    start,
    end,
    specified_coordinate: true,
  };
  if (start.attached_object) connector.start_object = start.attached_object;
  if (end.attached_object) connector.end_object = end.attached_object;
  if (path.length > 2) {
    connector.turning_points = path.slice(1, -1).map(
      ([
        px,
        py,
      ]) => ({ x: px - x, y: py - y }),
    );
  }
  if (label) {
    connector.captions = { data: [label] };
    connector.caption_position = clamp(
      number(
        element.labelPosition === undefined ? 0.5 : element.labelPosition,
        "labelPosition",
      ),
      0,
      1,
    );
  }
  return {
    ...node,
    x,
    y,
    width: right - x,
    height: bottom - y,
    angle: 0,
    type: "connector",
    connector,
    style: nodeStyle(element),
  };
}
