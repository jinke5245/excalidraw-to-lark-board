import { describe, expect, it, vi } from "vitest";

import { resolveTarget } from "./index.js";

function envelope(data: Record<string, unknown>) {
  return { ok: true, data };
}

describe("resolveTarget", () => {
  it("uses the document ID in a plain Docx link", async () => {
    const run = vi.fn();

    for (const host of [
      "li.feishu.cn",
      "org.sg.larksuite.com",
      "org.larkoffice.com",
    ]) {
      await expect(
        resolveTarget(`https://${host}/docx/Doc1?from=copy`, run),
      ).resolves.toEqual({
        documentId: "Doc1",
      });
    }

    await expect(
      resolveTarget("HTTPS://LI.FEISHU.CN:443/docx/Doc1/", run),
    ).resolves.toEqual({
      documentId: "Doc1",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    "board",
    "whiteboard",
  ])("verifies the token in a %s route", async (resource) => {
    const run = vi.fn().mockResolvedValue(envelope({ theme: "default" }));

    await expect(
      resolveTarget(`https://li.feishu.cn/${resource}/Board1/`, run),
    ).resolves.toEqual({
      boardToken: "Board1",
    });
    expect(run).toHaveBeenCalledExactlyOnceWith([
      "api",
      "GET",
      "/open-apis/board/v1/whiteboards/Board1/theme",
      "--as",
      "user",
    ]);
  });

  it("requires successful verification of direct board links", async () => {
    const url = "https://li.feishu.cn/board/Board1";
    const denied = vi.fn().mockRejectedValue(new Error("permission denied"));
    const missingTheme = vi.fn().mockResolvedValue(envelope({}));

    await expect(resolveTarget(url, denied)).rejects.toThrow(
      "permission denied",
    );
    await expect(resolveTarget(url, missingTheme)).rejects.toThrow(
      "verify the whiteboard token",
    );
  });

  it("uses the board token returned for a Docx board anchor", async () => {
    const run = vi.fn().mockResolvedValue(
      envelope({
        block: {
          block_id: "Block1",
          block_type: 43,
          board: { token: "Board1" },
        },
      }),
    );

    await expect(
      resolveTarget("https://li.feishu.cn/docx/Doc1#Block1", run),
    ).resolves.toEqual({
      boardToken: "Board1",
    });
    expect(run).toHaveBeenCalledExactlyOnceWith([
      "api",
      "GET",
      "/open-apis/docx/v1/documents/Doc1/blocks/Block1",
      "--as",
      "user",
    ]);
  });

  it("resolves the original Docx ID before looking up a Wiki board anchor", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(
        envelope({
          node: { node_token: "Wiki1", obj_type: "docx", obj_token: "Doc1" },
        }),
      )
      .mockResolvedValueOnce(
        envelope({
          block: {
            block_id: "Block1",
            block_type: 43,
            board: { token: "Board1" },
          },
        }),
      );

    await expect(
      resolveTarget("https://li.feishu.cn/wiki/Wiki1?from=copy#Block1", run),
    ).resolves.toEqual({ boardToken: "Board1" });
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      [
        "wiki",
        "spaces",
        "get_node",
        "--params",
        JSON.stringify({ token: "Wiki1" }),
        "--as",
        "user",
        "--format",
        "json",
      ],
      [
        "api",
        "GET",
        "/open-apis/docx/v1/documents/Doc1/blocks/Block1",
        "--as",
        "user",
      ],
    ]);
  });

  it("uses the document for confirmed text blocks and text share anchors", async () => {
    const run = vi
      .fn()
      .mockResolvedValue(
        envelope({ block: { block_id: "Text1", block_type: 2 } }),
      );

    await expect(
      resolveTarget("https://li.feishu.cn/docx/Doc1#Text1", run),
    ).resolves.toEqual({
      documentId: "Doc1",
    });
    expect(run).toHaveBeenCalledOnce();
    run.mockClear();

    await expect(
      resolveTarget("https://li.feishu.cn/docx/Doc1#share-Selection1", run),
    ).resolves.toEqual({ documentId: "Doc1" });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects Wiki links to other resource types", async () => {
    const run = vi.fn().mockResolvedValue(
      envelope({
        node: { node_token: "Wiki1", obj_type: "sheet", obj_token: "Sheet1" },
      }),
    );

    await expect(
      resolveTarget("https://li.feishu.cn/wiki/Wiki1", run),
    ).rejects.toThrow("Docx");
  });

  it("rejects unknown or incomplete block anchors", async () => {
    const url = "https://li.feishu.cn/docx/Doc1#Block1";
    const missing = vi
      .fn()
      .mockRejectedValue(new Error("block does not exist"));
    await expect(resolveTarget(url, missing)).rejects.toThrow(
      "block does not exist",
    );

    for (const block of [
      { block_id: "Other", block_type: 2 },
      { block_id: "Block1", block_type: "43" },
      { block_id: "Block1", block_type: 43 },
      { block_id: "Block1", block_type: 43, board: { token: "Board1\n" } },
    ]) {
      const run = vi.fn().mockResolvedValue(envelope({ block }));
      await expect(resolveTarget(url, run)).rejects.toThrow();
    }
  });

  it("rejects ASCII controls and Unicode whitespace before calling the CLI", async () => {
    const run = vi.fn();
    for (const character of [
      "\u0000",
      "\u001f",
      "\u007f",
      "\u0085",
      "\u202f",
    ]) {
      const url = "https://li.feishu.cn/wiki/Wiki1?value=" + character;
      await expect(resolveTarget(url, run)).rejects.toThrow(
        "invalid whitespace or control character",
      );
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects invalid links before calling the CLI", async () => {
    const run = vi.fn();

    for (const url of [
      "http://li.feishu.cn/docx/Doc1",
      "https://li.feishu.cn.evil.example/docx/Doc1",
      "https://notfeishu.cn/docx/Doc1",
      "https://reader@li.feishu.cn/docx/Doc1",
      "https://li.feishu.cn:8443/docx/Doc1",
      "https://li.feishu.cn:0443/docx/Doc1",
      "https://li.feishu.cn/base/Base1",
      "https://li.feishu.cn/board/share/Share1",
      "https://li.feishu.cn/docx/Doc1/extra",
      "https://li.feishu.cn/docx/%2FDoc1",
      "https://li.feishu.cn/docx/Doc1#invalid%2Fanchor",
      "https://li.feishu.cn/board/Board1#invalid%2Fanchor",
      "https://li.feishu.cn/extra/../docx/Doc1",
      "https://li.feishu.cn\\docx\\Doc1",
      "https://li.feishu.cn/docx/Doc1?query=\t",
    ]) {
      await expect(resolveTarget(url, run), url).rejects.toThrow();
    }

    expect(run).not.toHaveBeenCalled();
  });
});
