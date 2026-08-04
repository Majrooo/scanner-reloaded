import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const utilsSource = readFileSync(join(__dirname, "utils.js"), "utf-8");

/**
 * Loads utils.js (a classic, non-module script) into a sandboxed context
 * that provides a `window` global, then returns `window.Utils`.
 */
function loadUtils({ tauriInvoke } = {}) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    navigator: { platform: "Win32", userAgent: "test-agent" },
    window: {},
    document: {
      getElementById: () => null,
      createElement: () => ({}),
    },
  };
  sandbox.window = sandbox;
  if (tauriInvoke) {
    sandbox.window.__TAURI__ = { core: { invoke: tauriInvoke } };
  }
  vm.createContext(sandbox);
  vm.runInContext(utilsSource, sandbox, { filename: "utils.js" });
  return sandbox.window.Utils;
}

describe("formatBytes", () => {
  it("returns '0 B' for zero", () => {
    const Utils = loadUtils();
    expect(Utils.formatBytes(0)).toBe("0 B");
  });

  it("returns em dash for negative or non-finite values", () => {
    const Utils = loadUtils();
    expect(Utils.formatBytes(-5)).toBe("\u2014");
    expect(Utils.formatBytes(Infinity)).toBe("\u2014");
    expect(Utils.formatBytes(NaN)).toBe("\u2014");
  });

  it("formats bytes without decimals", () => {
    const Utils = loadUtils();
    expect(Utils.formatBytes(523)).toBe("523 B");
  });

  it("formats KB/MB/GB with stripped trailing zeros", () => {
    const Utils = loadUtils();
    expect(Utils.formatBytes(856 * 1024)).toBe("856 KB");
    expect(Utils.formatBytes(12.3 * 1024 * 1024)).toBe("12.3 MB");
    expect(Utils.formatBytes(1.53 * 1024 * 1024 * 1024)).toBe("1.53 GB");
  });

  it("supports up to petabytes", () => {
    const Utils = loadUtils();
    expect(Utils.formatBytes(2 * 1024 ** 5)).toBe("2 PB");
  });
});

describe("escapeHtml", () => {
  it("returns non-string input unchanged", () => {
    const Utils = loadUtils();
    expect(Utils.escapeHtml(42)).toBe(42);
    expect(Utils.escapeHtml(null)).toBe(null);
  });

  it("escapes &, <, > and double quotes", () => {
    const Utils = loadUtils();
    const input = "<a href=\"x&y\">";
    // Build expected via String.fromCharCode(38) so the formatter cannot
    // re-decode the HTML entities inside string literals.
    const amp = String.fromCharCode(38);
    const expected = amp + "lt;a href=" + amp + "quot;x" + amp + "amp;y" + amp + "quot;" + amp + "gt;";
    expect(Utils.escapeHtml(input)).toBe(expected);
  });

  it("leaves plain text unchanged", () => {
    const Utils = loadUtils();
    expect(Utils.escapeHtml("hello world")).toBe("hello world");
  });
});

describe("middleTruncatePath", () => {
  it("returns short paths unchanged", () => {
    const Utils = loadUtils();
    const path = "C:/Users/me/file.txt";
    expect(Utils.middleTruncatePath(path)).toBe(path);
  });

  it("truncates long paths keeping start and end", () => {
    const Utils = loadUtils();
    const path = "C:/Users/me/very/long/nested/folder/structure/file-name.txt";
    const result = Utils.middleTruncatePath(path, 40);
    expect(result).toContain("...");
    expect(result.startsWith("C:")).toBe(true);
    expect(result.endsWith("file-name.txt")).toBe(true);
  });

  it("handles backslash separators", () => {
    const Utils = loadUtils();
    const path = "C:\\Users\\me\\very\\long\\nested\\folder\\file.txt";
    const result = Utils.middleTruncatePath(path, 30);
    expect(result).toContain("...");
    expect(result.startsWith("C:")).toBe(true);
  });
});

describe("extractErrorMessage", () => {
  it("returns string errors directly", () => {
    const Utils = loadUtils();
    expect(Utils.extractErrorMessage("boom")).toBe("boom");
  });

  it("prefers userMessage over message", () => {
    const Utils = loadUtils();
    const err = { userMessage: "user msg", message: "raw msg" };
    expect(Utils.extractErrorMessage(err)).toBe("user msg");
  });

  it("falls back to message", () => {
    const Utils = loadUtils();
    expect(Utils.extractErrorMessage(new Error("raw msg"))).toBe("raw msg");
  });

  it("uses fallback key when no message is available", () => {
    const Utils = loadUtils();
    expect(Utils.extractErrorMessage({}, "fallback.key")).toBe("fallback.key");
  });
});

describe("invokeWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the invoke result", async () => {
    const invoke = vi.fn().mockResolvedValue("ok");
    const Utils = loadUtils({ tauriInvoke: invoke });
    const promise = Utils.invokeWithTimeout("some_command", {}, 1000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBe("ok");
  });

  it("rejects with IPC_TIMEOUT when invoke exceeds the timeout", async () => {
    const invoke = vi.fn().mockImplementation(() => new Promise(() => {}));
    const Utils = loadUtils({ tauriInvoke: invoke });
    const promise = Utils.invokeWithTimeout("slow_command", {}, 100);
    // Attach a no-op catch so the timeout rejection is not reported as
    // an unhandled rejection after the test completes.
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toThrow("IPC_TIMEOUT:slow_command");
  });

  it("passes command and args to invoke", async () => {
    const invoke = vi.fn().mockResolvedValue("ok");
    const Utils = loadUtils({ tauriInvoke: invoke });
    const promise = Utils.invokeWithTimeout("cmd", { a: 1 }, 1000);
    await vi.advanceTimersByTimeAsync(0);
    await promise;
    expect(invoke).toHaveBeenCalledWith("cmd", { a: 1 });
  });
});