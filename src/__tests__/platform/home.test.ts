import { describe, expect, it } from "vitest";
import { getUserHomeDirectory } from "../../platform/home.js";

describe("getUserHomeDirectory", () => {
  it("prefers USERPROFILE on Windows when HOME is also present", () => {
    expect(
      getUserHomeDirectory(
        { HOME: "/compat/home", USERPROFILE: "C:\\Users\\Alex" },
        "win32",
        "fallback",
      ),
    ).toBe("C:\\Users\\Alex");
  });

  it("uses HOME on Unix-like systems", () => {
    expect(
      getUserHomeDirectory({ HOME: "/home/alex", USERPROFILE: "C:\\Users\\Alex" }, "linux", "fallback"),
    ).toBe("/home/alex");
  });

  it("falls back to the platform home when environment variables are absent", () => {
    expect(getUserHomeDirectory({}, "win32", "C:\\Users\\Alex")).toBe("C:\\Users\\Alex");
  });
});
