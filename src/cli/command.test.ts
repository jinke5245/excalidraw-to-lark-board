import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type RasterAsset } from "../converter/index.js";
import { type RunLark } from "../lark/client.js";
import { runCli } from "./command.js";
import { type ImportDependencies } from "./import.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
const pixels = Buffer.from(PNG, "base64");
const target = "https://example.feishu.cn/docx/docxTest";
const boardArgs = ["--whiteboard-token", "wbcnTest"];
const success = (data: unknown) => ({
  status: 0,
  stdout: JSON.stringify({ ok: true, data }),
  stderr: "",
});
const empty = { status: 0, stdout: "", stderr: "" };
const runLark = vi.fn<RunLark>();
const renderSnapshots = vi.fn<ImportDependencies["renderSnapshots"]>();
const stdout = vi.fn<(text: string) => void>();
const stderr = vi.fn<(text: string) => void>();
const dependencies = { runLark, renderSnapshots, stdout, stderr };
let directory: string;
let input: string;

const element = (id: string, type: string, fields = {}) => ({
  id,
  type,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  ...fields,
});

async function writeScene(elements: unknown[], files = {}) {
  await writeFile(
    input,
    JSON.stringify({ type: "excalidraw", version: 2, elements, files }),
  );
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  expect(index).toBeGreaterThanOrEqual(0);
  return args[index + 1];
}

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), "excalidraw-cli-test-"));
  input = join(directory, "scene.excalidraw");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("shows help and rejects conflicting import destinations", async () => {
  expect(await runCli(["--help"], dependencies)).toBe(0);
  expect(stdout).toHaveBeenCalledWith(
    expect.stringContaining("<input> [target]"),
  );
  expect(await runCli([input, target, ...boardArgs], dependencies)).toBe(2);
  expect(stderr).toHaveBeenCalledWith(
    expect.stringContaining("either a target URL or --whiteboard-token"),
  );
  expect(runLark).not.toHaveBeenCalled();
});

test("uses the signed-in author for native sticky notes", async () => {
  await writeScene([element("note", "stickynote")]);
  runLark.mockImplementation(async (args, data) => {
    if (args[0] === "auth") {
      return {
        ...empty,
        stdout: JSON.stringify({
          identities: { user: { openId: "ou_TestAuthor" } },
        }),
      };
    }
    expect(args.slice(0, 2)).toEqual(["whiteboard", "+update"]);
    expect(JSON.parse(data!)).toMatchObject({
      nodes: [
        { type: "sticky_note", sticky_note: { user_id: "ou_TestAuthor" } },
      ],
    });
    return empty;
  });
  expect(await runCli([input, ...boardArgs], dependencies)).toBe(0);
  expect(runLark.mock.calls[0][0]).toEqual(["auth", "status", "--json"]);
});

test("renders before board creation and keeps both request tokens stable across retries", async () => {
  await writeScene([
    element("web", "embeddable", { link: "https://example.com/" }),
    element("html", "iframe"),
    element("magic", "magicframe"),
  ]);
  const calls: string[] = [];
  const creationTokens: string[] = [];
  const updateTokens: string[] = [];
  for (const capture of [
    pixels,
    Buffer.concat([pixels, Buffer.from("new capture")]),
  ]) {
    renderSnapshots.mockImplementation(async (_scene, ids) => {
      calls.push("render");
      expect(ids).toEqual(["web", "html", "magic"]);
      return new Map<string, RasterAsset>(
        ids.map((id) => [id, { suffix: ".png", data: capture }]),
      );
    });
    runLark.mockImplementation(async (args, data) => {
      if (args[0] === "api") {
        calls.push("create");
        expect(args.slice(0, 3)).toEqual([
          "api",
          "POST",
          "/open-apis/docx/v1/documents/docxTest/blocks/docxTest/children",
        ]);
        expect(JSON.parse(option(args, "--data"))).toEqual({
          index: -1,
          children: [{ block_type: 43, board: {} }],
        });
        creationTokens.push(JSON.parse(option(args, "--params")).client_token);
        return success({
          children: [
            {
              block_type: 43,
              block_id: "doxcnTest",
              board: { token: "wbcnTest" },
            },
          ],
        });
      }
      if (args[0] === "docs") {
        calls.push("upload");
        expect(option(args, "--parent-node")).toBe("wbcnTest");
        const file = option(args, "--file");
        expect(isAbsolute(file)).toBe(false);
        expect(await readFile(file)).toEqual(capture);
        return success({ file_token: "mediaToken" });
      }
      calls.push("write");
      expect(option(args, "--whiteboard-token")).toBe("wbcnTest");
      updateTokens.push(option(args, "--idempotent-token"));
      const { nodes } = JSON.parse(data!);
      expect(nodes.map((node: { type: string }) => node.type)).toEqual([
        "image",
        "text_shape",
        "image",
        "image",
      ]);
      expect(
        nodes[1].text.rich_text.paragraphs[0].elements[0].link_element.herf,
      ).toBe("https://example.com/");
      return empty;
    });
    expect(await runCli([input, target], dependencies)).toBe(0);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(`${target}#doxcnTest`),
    );
  }
  const cycle = ["render", "create", "upload", "upload", "upload", "write"];
  expect(calls).toEqual([...cycle, ...cycle]);
  expect(creationTokens).toHaveLength(2);
  expect(creationTokens[0]).toMatch(
    /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
  );
  expect(creationTokens[1]).toBe(creationTokens[0]);
  expect(updateTokens[1]).toBe(updateTokens[0]);
});

test("leaves a document untouched when automatic capture fails", async () => {
  await writeScene([element("html", "iframe")]);
  renderSnapshots.mockRejectedValue(new Error("renderer failed"));
  expect(await runCli([input, target], dependencies)).toBe(1);
  expect(stderr).toHaveBeenCalledWith(
    expect.stringContaining("renderer failed"),
  );
  expect(runLark).not.toHaveBeenCalled();
});

test("writes to an anchored whiteboard without creating another block", async () => {
  await writeScene([element("a", "rectangle")]);
  runLark.mockImplementation(async (args) => {
    if (args[0] === "api") {
      expect(args.slice(0, 3)).toEqual([
        "api",
        "GET",
        "/open-apis/docx/v1/documents/docxTest/blocks/doxcnTest",
      ]);
      return success({
        block: {
          block_id: "doxcnTest",
          block_type: 43,
          board: { token: "wbcnTest" },
        },
      });
    }
    expect(option(args, "--whiteboard-token")).toBe("wbcnTest");
    return empty;
  });
  expect(await runCli([input, `${target}#doxcnTest`], dependencies)).toBe(0);
  expect(runLark.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
    ["api", "GET"],
    ["whiteboard", "+update"],
  ]);
});

test("uploads a scene's native image and removes the staged file", async () => {
  await writeScene(
    [element("asset", "image", { x: 80, y: 100, fileId: "source" })],
    {
      source: { dataURL: `data:image/png;base64,${PNG}` },
    },
  );
  let stagedFile = "";
  runLark.mockImplementation(async (args, data) => {
    if (args[0] === "docs") {
      stagedFile = option(args, "--file");
      expect(await readFile(stagedFile)).toEqual(pixels);
      return success({ file_token: "assetToken" });
    }
    expect(JSON.parse(data!)).toMatchObject({
      nodes: [{ type: "image", x: 80, y: 100, image: { token: "assetToken" } }],
    });
    return empty;
  });
  expect(await runCli([input, ...boardArgs], dependencies)).toBe(0);
  expect(runLark.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
    ["docs", "+media-upload"],
    ["whiteboard", "+update"],
  ]);
  expect(renderSnapshots).not.toHaveBeenCalled();
  await expect(readFile(stagedFile)).rejects.toMatchObject({ code: "ENOENT" });
});

test("passes stdout JSON to Lark without mixing its response and propagates the status", async () => {
  await writeScene([element("a", "rectangle")]);
  runLark.mockResolvedValue({
    status: 7,
    stdout: "lark response\n",
    stderr: "lark error\n",
  });
  expect(await runCli([input, ...boardArgs], dependencies)).toBe(7);
  const [[args, data]] = runLark.mock.calls;
  expect(option(args, "--source")).toBe("-");
  expect(args).not.toContain("--overwrite");
  expect(stdout).toHaveBeenCalledExactlyOnceWith(data);
  expect(stderr.mock.calls.flat()).toEqual(["lark response\n", "lark error\n"]);
});

test("writes an exclusive output file using the same CLI without a destination", async () => {
  await writeScene([element("a", "rectangle")]);
  const output = join(directory, "nodes.json");
  expect(await runCli([input, "-o", output], dependencies)).toBe(0);
  expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
    nodes: [{ type: "composite_shape" }],
  });
  expect(await runCli([input, "-o", output], dependencies)).toBe(1);
  expect(stderr).toHaveBeenCalledWith(
    expect.stringContaining("output already exists"),
  );
  expect(stdout).not.toHaveBeenCalled();
  expect(runLark).not.toHaveBeenCalled();
});
