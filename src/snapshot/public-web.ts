import { Resolver } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP } from "node:net";

const MAX_RESPONSE = 8 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const RESPONSE_HEADERS = [
  "content-type",
  "content-encoding",
  "content-security-policy",
  "x-content-type-options",
  "access-control-allow-origin",
  "access-control-expose-headers",
];
const PRIVATE_V4 = new BlockList();
for (const [base, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  PRIVATE_V4.addSubnet(base, prefix, "ipv4");
}
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");
const PRIVATE_V6 = new BlockList();
for (const [base, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  PRIVATE_V6.addSubnet(base, prefix, "ipv6");
}

type FetchResponse =
  | { location: string }
  | {
      status: number;
      headers: Record<string, string>;
      body: Buffer;
    };

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !PRIVATE_V4.check(address, "ipv4");
  return (
    family === 6 &&
    GLOBAL_V6.check(address, "ipv6") &&
    !PRIVATE_V6.check(address, "ipv6")
  );
}

function publicUrl(value: string | URL): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    (!isIP(host) &&
      (!host.includes(".") ||
        /(?:^|\.)(local|localhost|internal|test|invalid)\.?$/i.test(host)))
  ) {
    throw new Error(
      "Embed screenshot requires a public HTTP(S) URL on its default port",
    );
  }
  if (isIP(host) && !isPublicAddress(host)) {
    throw new Error("Embed screenshot blocked a non-public network address");
  }
  return url;
}

async function resolvePublic(
  host: string,
  resolver: Resolver,
): Promise<string> {
  const name = host.replace(/^\[|\]$/g, "");
  if (isIP(name)) return name;
  const records = await Promise.allSettled([
    resolver.resolve4(name),
    resolver.resolve6(name),
  ]);
  const addresses = records.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  const [address] = addresses;
  if (!address)
    throw new Error("Could not resolve a public address for the embed");
  if (addresses.some((candidate) => !isPublicAddress(candidate))) {
    throw new Error("Embed screenshot blocked a non-public DNS address");
  }
  return address;
}

function fetchOne(
  url: URL,
  address: string,
  signal: AbortSignal,
  consumeBytes: (size: number) => boolean,
): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? requestHttps : requestHttp;
    const family = isIP(address);
    // Resolve once, then pin the connection while preserving the original TLS hostname.
    const outgoing = request(
      url,
      {
        agent: false,
        family,
        signal,
        lookup: (_host, _options, callback) => callback(null, address, family),
        headers: {
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/133.0 Safari/537.36",
          accept: "*/*",
          "accept-encoding": "identity",
        },
      },
      (incoming) => {
        const status = incoming.statusCode;
        if (status === undefined) {
          reject(new Error("Embed server did not return an HTTP status"));
          incoming.destroy();
          return;
        }
        const { location } = incoming.headers;
        if (status >= 300 && status < 400 && location) {
          resolve({ location });
          incoming.destroy();
          return;
        }
        const headers = Object.fromEntries(
          RESPONSE_HEADERS.filter(
            (name) => incoming.headers[name] !== undefined,
          ).map((name) => [name, String(incoming.headers[name])]),
        );
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE || !consumeBytes(chunk.length)) {
            incoming.destroy(
              new Error("Embed screenshot exceeds the resource byte limit"),
            );
          } else chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () =>
          resolve({ status, headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    outgoing.setTimeout(8_000, () =>
      outgoing.destroy(new Error("Embed request timed out")),
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/** Create a request- and byte-limited fetcher that pins verified public DNS results. */
export function createPublicFetcher(timeout: number) {
  const resolver = new Resolver({ timeout: 3_000, tries: 1 });
  const hosts = new Map<string, Promise<string>>();
  const signal = AbortSignal.timeout(timeout);
  let remainingRequests = 100;
  let remainingBytes = MAX_TOTAL;
  const consumeBytes = (size: number) => {
    remainingBytes -= size;
    return remainingBytes >= 0;
  };
  return async function fetchPublic(input: string | URL) {
    let url = publicUrl(input);
    for (let redirect = 0; redirect <= 5; redirect++) {
      signal.throwIfAborted();
      if (--remainingRequests < 0)
        throw new Error("Embed screenshot reached the request limit");
      let resolution = hosts.get(url.hostname);
      if (!resolution) {
        resolution = resolvePublic(url.hostname, resolver);
        hosts.set(url.hostname, resolution);
      }
      const response = await fetchOne(
        url,
        await resolution,
        signal,
        consumeBytes,
      );
      if (!("location" in response)) return { ...response, url: url.href };
      url = publicUrl(new URL(response.location, url));
    }
    throw new Error("Embed screenshot encountered too many redirects");
  };
}
