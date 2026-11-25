import { assert, expect, test } from "vitest";

import { convert } from "./index.js";

function element(
  id: string,
  type: string,
  x = 0,
  y = 0,
  fields: Record<string, unknown> = {},
) {
  return { id, type, x, y, width: 100, height: 50, ...fields };
}

function scene(...elements: unknown[]) {
  return { type: "excalidraw", version: 2, elements };
}

test("converts lines to native connectors without arrowheads", async () => {
  const {
    payload: {
      nodes: [line],
    },
    warnings,
  } = await convert(
    scene(
      element("line", "line", 40, 20, {
        width: 60,
        height: 0,
        points: [
          [
            0,
            0,
          ],
          [
            60,
            0,
          ],
        ],
      }),
    ),
  );
  expect(warnings).toEqual([]);
  assert.isDefined(line);
  expect(line.type).toBe("connector");
  expect(line.connector).toMatchObject({
    shape: "straight",
    start: { arrow_style: "none", position: { x: 40, y: 20 } },
    end: { arrow_style: "none", position: { x: 100, y: 20 } },
  });
});

test("converts freehand strokes to native paint with uniform width", async () => {
  const {
    payload: {
      nodes: [stroke],
    },
    warnings,
  } = await convert(
    scene(
      element("stroke", "freedraw", 80, 110, {
        points: [
          [
            0,
            0,
          ],
          [
            -4,
            10,
          ],
          [
            25,
            8,
          ],
        ],
        pressures: [
          0.2,
          0.6,
          0.9,
        ],
        strokeWidth: 4,
        strokeColor: "#087f5b",
      }),
    ),
  );
  assert.isDefined(stroke);
  expect(stroke).toMatchObject({
    type: "paint",
    x: 76,
    y: 110,
    width: 29,
    height: 10,
  });
  expect(stroke.paint).toEqual({
    type: "marker",
    width: 4,
    color: "#087f5b",
    lines: [
      { x: 4, y: 0 },
      { x: 0, y: 10 },
      { x: 29, y: 8 },
    ],
  });
  expect(stroke).not.toHaveProperty("style");
  expect(warnings).toEqual([expect.stringContaining("pressure")]);
});

test("keeps sticky-note text in a single native note", async () => {
  const { payload, warnings } = await convert(
    scene(
      element("note", "stickynote", 80, 560, { baseHeight: 50 }),
      element("label", "text", 0, 0, { text: "继续跟进", containerId: "note" }),
    ),
  );
  expect(warnings).toEqual([]);
  expect(payload.nodes).toHaveLength(1);
  expect(payload.nodes[0]).toMatchObject({
    type: "sticky_note",
    text: { text: "继续跟进" },
    sticky_note: { show_author_info: false },
  });
});

test("skips embed elements and keeps supported Magic Frame children on the canvas", async () => {
  const { payload, warnings } = await convert(
    scene(
      element("plain", "text", 30, 40, { text: "普通文字" }),
      element("html", "iframe", 0, 0, {
        customData: { feishuSnapshot: "unused" },
      }),
      element("magic", "magicframe", 100, 200),
      element("child", "rectangle", 110, 220, { frameId: "magic" }),
      element("web", "embeddable", 0, 0, { link: "https://example.com/" }),
    ),
  );
  expect(payload.nodes).toMatchObject([
    {
      id: "a1:1",
      type: "text_shape",
      x: 30,
      y: 40,
      text: { text: "普通文字" },
    },
    { id: "o1:2", type: "composite_shape", x: 110, y: 220 },
  ]);
  expect(payload.nodes[1]).not.toHaveProperty("parent_id");
  expect(warnings).toEqual([
    "html: skipped unsupported element type 'iframe'",
    "magic: skipped unsupported element type 'magicframe'",
    "web: skipped unsupported element type 'embeddable'",
  ]);
});

test("rejects a scene with no convertible nodes", async () => {
  await expect(
    convert(
      scene(
        element("html", "iframe"),
        element("web", "embeddable"),
        element("magic", "magicframe"),
      ),
    ),
  ).rejects.toThrow(
    "expected 1–3000 convertible nodes for a single Feishu request",
  );
});

test("preserves Chinese labels and binds arrow endpoints to their shapes", async () => {
  const {
    payload: {
      nodes: [
        left,
        right,
        arrow,
      ],
    },
    warnings,
  } = await convert(
    scene(
      element("a", "rectangle"),
      element("b", "rectangle", 200),
      element("arrow", "arrow", 105, 25, {
        points: [
          [
            0,
            0,
          ],
          [
            90,
            0,
          ],
        ],
        startBinding: {
          elementId: "a",
          fixedPoint: [
            1,
            0.5,
          ],
        },
        endBinding: { elementId: "b", focus: 0, gap: 5 },
      }),
      element("label-a", "text", 0, 0, { text: "开始", containerId: "a" }),
      element("label-b", "text", 0, 0, { text: "完成", containerId: "b" }),
    ),
  );
  expect(warnings).toEqual([]);
  assert.isDefined(left);
  assert.isDefined(right);
  assert.isDefined(arrow);
  expect([
    left.text?.text,
    right.text?.text,
  ]).toEqual([
    "开始",
    "完成",
  ]);
  expect(arrow.connector?.start.attached_object).toEqual({
    id: left.id,
    snap_to: "right",
    position: { x: 1, y: 0.5 },
  });
  expect(arrow.connector?.end.attached_object).toEqual({
    id: right.id,
    snap_to: "left",
    position: { x: 0, y: 0.5 },
  });
  expect(arrow).toMatchObject({ x: 100, y: 25, width: 100, height: 0 });
  expect(arrow.connector?.start_object).toEqual(
    arrow.connector?.start.attached_object,
  );
});

test("converts standalone text and shapes and skips deleted elements", async () => {
  const {
    payload: { nodes },
    warnings,
  } = await convert(
    scene(
      element("c", "ellipse"),
      element("d", "diamond"),
      element("label", "text", 0, 0, { text: "独立文字" }),
      element("deleted", "rectangle", 0, 0, { isDeleted: true }),
    ),
  );
  expect(warnings).toEqual([]);
  expect(nodes).toMatchObject([
    { composite_shape: { type: "ellipse" } },
    { composite_shape: { type: "diamond" } },
    { type: "text_shape", text: { text: "独立文字" } },
  ]);
});

test("keeps an unavailable binding as a free endpoint and warns", async () => {
  const {
    payload: {
      nodes: [arrow],
    },
    warnings,
  } = await convert(
    scene(
      element("arrow", "arrow", 40, 20, {
        points: [
          [
            0,
            0,
          ],
          [
            90,
            50,
          ],
        ],
        startBinding: { elementId: "missing" },
      }),
    ),
  );
  assert.isDefined(arrow);
  expect(arrow.connector?.start.position).toEqual({ x: 40, y: 20 });
  expect(arrow.connector?.end.position).toEqual({ x: 130, y: 70 });
  expect(warnings[0]).toContain("missing");
});

test("makes a bent arrow's turning point-relative coordinates local to its path bounds", async () => {
  const {
    payload: {
      nodes: [arrow],
    },
  } = await convert(
    scene(
      element("arrow", "arrow", 40, 20, {
        points: [
          [
            0,
            0,
          ],
          [
            15,
            -10,
          ],
          [
            40,
            5,
          ],
        ],
      }),
    ),
  );
  expect(arrow).toMatchObject({
    x: 40,
    y: 10,
    width: 40,
    height: 15,
    connector: { turning_points: [{ x: 15, y: 0 }] },
  });
});

test("keeps frame children local and cross-section arrows at canvas level", async () => {
  const {
    payload: {
      nodes: [
        section,
        left,
        text,
        right,
        arrow,
      ],
    },
    warnings,
  } = await convert(
    scene(
      element("a", "rectangle", 75, 85, { frameId: "frame" }),
      element("note", "text", 85, 120, { frameId: "frame", text: "分区内" }),
      element("edge", "arrow", 180, 110, {
        points: [
          [
            0,
            0,
          ],
          [
            65,
            0,
          ],
        ],
        frameId: "frame",
        startBinding: {
          elementId: "a",
          fixedPoint: [
            1,
            0.5,
          ],
        },
        endBinding: {
          elementId: "b",
          fixedPoint: [
            0,
            0.5,
          ],
        },
      }),
      element("frame", "frame", 50, 60, {
        width: 150,
        height: 130,
        name: "处理分区",
      }),
      element("b", "rectangle", 250, 85),
    ),
  );
  expect(warnings).toEqual([]);
  assert.isDefined(section);
  assert.isDefined(left);
  assert.isDefined(right);
  assert.isDefined(arrow);
  expect(section).toMatchObject({
    type: "section",
    section: { title: "处理分区" },
    x: 50,
    y: 60,
    width: 150,
    height: 130,
  });
  expect(section).not.toHaveProperty("style.border_color");
  expect(left).toMatchObject({ parent_id: section.id, x: 25, y: 25 });
  expect(text).toMatchObject({ parent_id: section.id, x: 35, y: 60 });
  expect(right).not.toHaveProperty("parent_id");
  expect(arrow).not.toHaveProperty("parent_id");
  expect(arrow.z_index).toBeGreaterThan(section.z_index);
  expect(arrow).toMatchObject({ x: 175, y: 110, width: 75, height: 0 });
  expect(arrow.connector?.start.attached_object?.id).toBe(left.id);
  expect(arrow.connector?.end.attached_object?.id).toBe(right.id);
});

test("rejects duplicate IDs and non-numeric points", async () => {
  await expect(
    convert(scene(element("same", "diamond"), element("same", "text"))),
  ).rejects.toThrow(/duplicate/);
  await expect(
    convert(
      scene(
        element("arrow", "arrow", 0, 0, {
          points: [
            [
              0,
              0,
            ],
            [
              true,
              1,
            ],
          ],
        }),
      ),
    ),
  ).rejects.toThrow(/points/);
});

test("rejects finite source coordinates that overflow after conversion", async () => {
  await expect(
    convert(
      scene(
        element("edge", "arrow", 0, 0, {
          points: [
            [
              1e308,
              0,
            ],
            [
              1e308,
              1,
            ],
          ],
        }),
      ),
    ),
  ).rejects.toThrow(/coordinates must be finite/);
});
