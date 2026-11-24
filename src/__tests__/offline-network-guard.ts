/**
 * Offline-suite safety boundary: the native fetch implementation may only
 * reach loopback. Test files can still replace fetch with deterministic mocks.
 */
const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const rawUrl = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (!isLoopback) {
    throw new Error(`Offline test guard blocked real outbound fetch to ${host}.`);
  }
  return nativeFetch(input, init);
};
