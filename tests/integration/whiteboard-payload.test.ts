import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test, vi } from "vitest";

import { runCli } from "../../src/cli/command.js";
import type { ElementType } from "../../src/converter/model.js";
import type { RunLark } from "../../src/lark/client.js";

const fixtures = new URL("../fixtures/whiteboard-payload/", import.meta.url);
const board = "wbcnFixtureBoard";
const author = "ou_FixtureAuthor";
const pressureWarning = (id: string) =>
  `Warning: ${id}: pressure converted to a uniform stroke width\n`;
type FixtureOptions = {
  nativeImage?: true;
  warnings?: string[];
};

const elementCases = {
  rectangle: {},
  ellipse: {},
  diamond: {},
  text: {},
  arrow: {},
  frame: {},
  line: {},
  freedraw: { warnings: [pressureWarning("poc-freedraw")] },
  stickynote: {},
  image: { nativeImage: true },
} satisfies Record<ElementType, FixtureOptions>;

const cases: (FixtureOptions & { name: string; elementType?: string })[] = [
  { name: "basic" },
  { name: "frame" },
  { name: "mixed-drawing", warnings: [pressureWarning("mixed-stroke")] },
  {
    name: "all-features",
    nativeImage: true,
    warnings: [pressureWarning("poc-freedraw")],
  },
  {
    name: "unsupported-embeds",
    warnings: [
      "Warning: unsupported-embeddable: skipped unsupported element type 'embeddable'\n",
      "Warning: unsupported-iframe: skipped unsupported element type 'iframe'\n",
      "Warning: unsupported-magicframe: skipped unsupported element type 'magicframe'\n",
    ],
  },
  ...Object.entries(elementCases).map(
    ([
      elementType,
      options,
    ]) => ({
      name: `elements/${elementType}`,
      elementType,
      ...options,
    }),
  ),
  ...(
    [
      "rectangle",
      "ellipse",
      "diamond",
    ] as const
  ).map((elementType) => ({
    name: `elements/${elementType}_with_text`,
    elementType,
  })),
];

function success(data: unknown) {
  return { status: 0, stdout: JSON.stringify({ ok: true, data }), stderr: "" };
}

test.each(cases)(
  "matches the final whiteboard payload for $name",
  async ({ name, elementType, nativeImage, warnings = [] }) => {
    const source = new URL(`${name}.excalidraw`, fixtures);
    const scene = JSON.parse(await readFile(source, "utf8")) as {
      elements: { type: string }[];
      files: Record<string, { dataURL: string }>;
    };
    if (elementType) {
      expect(scene.elements.map((element) => element.type)).toContain(
        elementType,
      );
    }
    const expected: unknown = JSON.parse(
      await readFile(new URL(`${name}.nodes.json`, fixtures), "utf8"),
    );
    let imageToUpload: Buffer | undefined;
    if (nativeImage) {
      const embedded = Object.values(scene.files);
      expect(embedded).toHaveLength(1);
      const encoded = embedded[0]?.dataURL.split(",")[1];
      assert(encoded, "Expected base64 data for the fixture's native image");
      imageToUpload = Buffer.from(encoded, "base64");
    }

    const requests: string[] = [];
    const diagnostics: string[] = [];
    const runLark: RunLark = async (args, input) => {
      const [
        service,
        action,
      ] = args;
      if (service === "auth" && action === "status") {
        return {
          status: 0,
          stdout: JSON.stringify({ identities: { user: { openId: author } } }),
          stderr: "",
        };
      }
      if (service === "docs" && action === "+media-upload") {
        assert(imageToUpload, "Unexpected image upload");
        const fileOption = args.indexOf("--file");
        const filename = args[fileOption + 1];
        assert(fileOption >= 0 && filename, "Expected a file to upload");
        expect(await readFile(filename)).toEqual(imageToUpload);
        imageToUpload = undefined;
        return success({ file_token: "fixture-native-image" });
      }
      if (service === "whiteboard" && action === "+update" && input) {
        expect(args[args.indexOf("--source") + 1]).toBe("-");
        expect(args[args.indexOf("--input_format") + 1]).toBe("raw");
        expect(args[args.indexOf("--whiteboard-token") + 1]).toBe(board);
        requests.push(input);
        return success({});
      }
      throw new Error(`Unexpected Lark CLI command: ${args.join(" ")}`);
    };

    const exitCode = await runCli(
      [
        fileURLToPath(source),
        "--whiteboard-token",
        board,
      ],
      {
        runLark,
        stdout: vi.fn(),
        stderr: (message) => {
          diagnostics.push(message);
        },
      },
    );

    expect(exitCode, diagnostics.join("")).toBe(0);
    expect(
      diagnostics.filter((message) => message.startsWith("Warning:")),
    ).toEqual(warnings);
    expect(imageToUpload).toBeUndefined();
    expect(requests.map((request) => JSON.parse(request))).toEqual([expected]);
  },
);
