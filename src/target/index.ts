const HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*(?:feishu\.cn|larksuite\.com|larkoffice\.com)(?::443)?$/i;
const ROUTE = /^\/(docx|wiki|board|whiteboard)\/([A-Za-z0-9_-]+)\/?$/;
const SHARE_ANCHOR = /^share(?:-[A-Za-z0-9_-]+)?$/;
const BOARD_BLOCK_TYPE = 43;

/** A verified whiteboard token or a Docx document ID. */
export type Target =
  | { boardToken: string; documentId?: never }
  | { documentId: string; boardToken?: never };

function isToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[^A-Za-z0-9_-]/.test(value)
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function responseData(envelope: unknown): Record<string, unknown> {
  const result = record(envelope);
  const data = record(result?.data);
  if (result?.ok !== true || !data) {
    throw new Error("lark-cli did not return a valid data object");
  }
  return data;
}

/**
 * Resolves a Feishu or Lark URL without modifying the resource.
 * @param value The supplied document, Wiki, or whiteboard URL.
 * @param runLark Executes the read-only CLI commands needed to verify the target.
 * @returns The existing whiteboard token or the Docx document ID.
 * @throws If the URL is invalid or its anchored resource cannot be verified.
 */
export async function resolveTarget(
  value: string,
  runLark: (args: string[]) => Promise<unknown>,
): Promise<Target> {
  if (/[\p{White_Space}\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error(
      "invalid whitespace or control character in Feishu target URL",
    );
  }

  // Check the supplied path and authority before URL normalization can change them.
  const url = /^https:\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/i.exec(
    value,
  );
  if (!url?.[1] || !HOST.test(url[1])) {
    throw new Error(
      "target must be an HTTPS Feishu or Lark URL without credentials",
    );
  }

  const route = ROUTE.exec(url[2] ?? "");
  const resource = route?.[1];
  const token = route?.[2];
  if (!resource || !token) {
    throw new Error("expected a Feishu Docx, Wiki, or whiteboard link");
  }

  const anchor = url[3] ?? "";
  const blockId = SHARE_ANCHOR.test(anchor) ? "" : anchor;
  if (blockId && !isToken(blockId)) {
    throw new Error("invalid Feishu block anchor");
  }

  if (resource === "board" || resource === "whiteboard") {
    const data = responseData(
      await runLark([
        "api",
        "GET",
        `/open-apis/board/v1/whiteboards/${token}/theme`,
        "--as",
        "user",
      ]),
    );
    if (data.theme === undefined || data.theme === null) {
      throw new Error("lark-cli could not verify the whiteboard token");
    }
    return { boardToken: token };
  }

  let documentId = token;
  if (resource === "wiki") {
    const data = responseData(
      await runLark([
        "wiki",
        "spaces",
        "get_node",
        "--params",
        JSON.stringify({ token }),
        "--as",
        "user",
        "--format",
        "json",
      ]),
    );
    const node = record(data.node);
    if (!node || ("node_token" in node && node.node_token !== token)) {
      throw new Error("lark-cli did not resolve the requested Wiki node");
    }
    if (node.obj_type !== "docx") {
      throw new Error("Wiki target must point to a Docx document");
    }
    if (!isToken(node.obj_token)) {
      throw new Error("lark-cli did not return a valid Wiki Docx ID");
    }
    documentId = node.obj_token;
  }

  if (blockId) {
    const data = responseData(
      await runLark([
        "api",
        "GET",
        `/open-apis/docx/v1/documents/${documentId}/blocks/${blockId}`,
        "--as",
        "user",
      ]),
    );
    const block = record(data.block);
    if (block?.block_id !== blockId || !Number.isInteger(block.block_type)) {
      throw new Error(
        "lark-cli did not resolve the requested Docx block anchor",
      );
    }
    if (block.block_type === BOARD_BLOCK_TYPE) {
      const boardToken = record(block.board)?.token;
      if (!isToken(boardToken)) {
        throw new Error(
          "the anchored Docx board block has no valid whiteboard token",
        );
      }
      return { boardToken };
    }
  }

  return { documentId };
}
