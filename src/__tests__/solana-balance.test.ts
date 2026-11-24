import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUsdcBalance } from "../conway/x402.js";

const owner = "11111111111111111111111111111111";
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const originalRpcUrl = process.env.SOLANA_RPC_URL;

function rpcResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function tokenAccount(amount: string) {
  return {
    account: {
      data: {
        parsed: {
          info: {
            mint,
            owner,
            tokenAmount: { amount, decimals: 6 },
          },
        },
      },
    },
  };
}

describe("Solana USDC balance JSON-RPC", () => {
  beforeEach(() => {
    delete process.env.SOLANA_RPC_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalRpcUrl === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = originalRpcUrl;
  });

  it("uses the local JSON-RPC contract and sums exact USDC atomic amounts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(rpcResponse({
      jsonrpc: "2.0",
      id: "survive-or-die-usdc-balance",
      result: { value: [tokenAccount("1234567"), tokenAccount("200000")] },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getUsdcBalance(owner, "solana:mainnet", "solana")).resolves.toBe(1.434567);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.mainnet-beta.solana.com/");
    expect(request.method).toBe("POST");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(request.body))).toEqual({
      jsonrpc: "2.0",
      id: "survive-or-die-usdc-balance",
      method: "getTokenAccountsByOwner",
      params: [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
    });
  });

  it("rejects invalid wallet addresses before making a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getUsdcBalance("not-a-solana-address", "solana:mainnet", "solana"))
      .rejects.toThrow("Invalid Solana owner address");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects untrusted account data and oversized or failed RPC responses", async () => {
    const account = tokenAccount("1000000");
    const wrongOwner = {
      account: {
        data: {
          parsed: {
            info: { ...account.account.data.parsed.info, owner: "different-owner" },
          },
        },
      },
    };
    const wrongAccountFetch = vi.fn().mockResolvedValue(rpcResponse({
      jsonrpc: "2.0",
      id: "survive-or-die-usdc-balance",
      result: { value: [wrongOwner] },
    }));
    vi.stubGlobal("fetch", wrongAccountFetch);
    await expect(getUsdcBalance(owner, "solana:mainnet", "solana"))
      .rejects.toThrow("outside the requested owner and mint");

    const oversizedFetch = vi.fn().mockResolvedValue(rpcResponse({}, 200, { "content-length": "300000" }));
    vi.stubGlobal("fetch", oversizedFetch);
    await expect(getUsdcBalance(owner, "solana:mainnet", "solana"))
      .rejects.toThrow("exceeded the 256KB limit");

    const failedFetch = vi.fn().mockResolvedValue(rpcResponse({}, 503));
    vi.stubGlobal("fetch", failedFetch);
    await expect(getUsdcBalance(owner, "solana:mainnet", "solana"))
      .rejects.toThrow("HTTP 503");
  });

  it("rejects non-HTTP RPC URLs without attempting a request", async () => {
    process.env.SOLANA_RPC_URL = "file:///etc/passwd";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getUsdcBalance(owner, "solana:mainnet", "solana"))
      .rejects.toThrow("HTTP(S) URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
