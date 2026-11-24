import { describe, expect, it } from "vitest";
import { clampLimit, constantTimeTokenEquals, isSafeLocalModelId } from "../dashboard/server.js";

describe("private dashboard input guards", () => {
  it("compares tokens and rejects empty or mismatched credentials", () => {
    expect(constantTimeTokenEquals("owner-token", "owner-token")).toBe(true);
    expect(constantTimeTokenEquals("owner-token", "wrong-token")).toBe(false);
    expect(constantTimeTokenEquals("", "")).toBe(false);
  });

  it("accepts local Ollama model identifiers while rejecting cloud and malformed names", () => {
    expect(isSafeLocalModelId("llama3.1:8b")).toBe(true);
    expect(isSafeLocalModelId("org/model-v2")).toBe(true);
    expect(isSafeLocalModelId("deepseek-v3:cloud")).toBe(false);
    expect(isSafeLocalModelId("model name")).toBe(false);
    expect(isSafeLocalModelId("")).toBe(false);
  });

  it("clamps client-provided list limits to bounded positive integers", () => {
    expect(clampLimit("12")).toBe(12);
    expect(clampLimit("0")).toBe(1);
    expect(clampLimit("999")).toBe(100);
    expect(clampLimit("nope")).toBe(50);
    expect(clampLimit("7", 3, 5)).toBe(5);
  });
});
