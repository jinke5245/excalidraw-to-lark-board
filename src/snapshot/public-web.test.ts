import { describe, expect, it } from "vitest";
import { createPublicFetcher } from "./public-web.js";

describe("public embed requests", () => {
  it.each([
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://10.0.0.1/",
    "http://169.254.169.254/",
  ])("rejects non-public address %s", async (url) => {
    await expect(createPublicFetcher(1000)(url)).rejects.toThrow(
      "blocked a non-public network address",
    );
  });

  it.each([
    "http://localhost/",
    "http://example.com:8080/",
    "file:///tmp/image.png",
  ])("rejects unsupported embed target %s", async (url) => {
    await expect(createPublicFetcher(1000)(url)).rejects.toThrow(
      "a public HTTP(S) URL on its default port",
    );
  });
});
