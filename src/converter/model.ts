/** Native Feishu composite-shape names by Excalidraw shape type. */
export const SHAPES = {
  rectangle: "rect",
  ellipse: "ellipse",
  diamond: "diamond",
} as const;
/** Stable Feishu node ID prefixes by converted element type. */
export const PREFIXES = {
  rectangle: "o",
  ellipse: "o",
  diamond: "o",
  arrow: "c",
  line: "c",
  text: "a",
  frame: "t",
  image: "i",
  freedraw: "y",
  stickynote: "w",
} as const;

/** Object whose fields still need validation at the input boundary. */
export type InputRecord = Record<string, unknown>;
/** Source element with a validated stable identifier. */
export type SourceElement = InputRecord & { id: string };
/** Element type accepted by the native node converter. */
export type ElementType = keyof typeof PREFIXES;
/** Source element selected for native node conversion. */
export type SupportedElement = SourceElement & { type: ElementType };
/** A pair of canvas coordinates. */
export type Point = [
  number,
  number,
];
type Coordinate = { x: number; y: number };
/** A canvas bounding box and clockwise rotation in degrees. */
export type Geometry = Coordinate & {
  width: number;
  height: number;
  angle: number;
};
/** Common geometry, ID, and layer for a converted node. */
export type BaseNode = Geometry & { id: string; z_index: number };
/** Feishu text content and formatting. */
export type BoardText = {
  text: string;
  font_size: number;
  horizontal_align: "left" | "center" | "right";
  vertical_align: "top" | "mid" | "bottom";
  text_color?: string;
  text_color_type?: number;
};
/** Side of a shape to which a connector is attached. */
export type SnapSide = "left" | "right" | "top" | "bottom";
/** Feishu binding to a normalized position inside a node. */
export type Attachment = {
  id: string;
  snap_to: SnapSide;
  position: Coordinate;
};
/** Feishu connector endpoint with arrowhead and position or binding. */
export type Port = {
  arrow_style: string;
  attached_object?: Attachment;
  position?: Coordinate;
};
/** Feishu drawing properties for a converted line or arrow. */
export type Connector = {
  shape: "polyline" | "straight";
  start: Port;
  end: Port;
  specified_coordinate: boolean;
  start_object?: Attachment;
  end_object?: Attachment;
  turning_points?: Coordinate[];
  captions?: { data: BoardText[] };
  caption_position?: number;
};

/** A native node in a Feishu whiteboard create-nodes request. */
export type BoardNode = Omit<BaseNode, "angle"> & {
  angle?: number;
  type:
    | "section"
    | "text_shape"
    | "image"
    | "sticky_note"
    | "paint"
    | "composite_shape"
    | "connector";
  parent_id?: string;
  section?: { title: string };
  text?: BoardText;
  image?: { token?: string };
  sticky_note?: { show_author_info: boolean; user_id?: string };
  paint?: { type: "marker"; width: number; color: string; lines: Coordinate[] };
  composite_shape?: {
    type: (typeof SHAPES)[keyof typeof SHAPES] | "round_rect";
  };
  connector?: Connector;
  style?: Record<string, string | number>;
};

/** Check for a non-array JSON object before reading fields. */
export function isRecord(value: unknown): value is InputRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check an own string key before indexing a lookup table. */
export function hasKey<T extends object>(
  record: T,
  key: unknown,
): key is keyof T {
  return typeof key === "string" && Object.hasOwn(record, key);
}

/** Identify the source element types that become connectors. */
export function isConnector(type: ElementType): type is "arrow" | "line" {
  return type === "arrow" || type === "line";
}

/** Require a finite number for a canvas or style field. */
export function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field}: expected a finite number`);
  }
  return value;
}

/** Write a source value as part of a conversion warning. */
export function describe(value: unknown): string {
  return typeof value === "string"
    ? `'${value}'`
    : value == null
      ? "None"
      : (JSON.stringify(value) ?? String(value));
}
