import { describe, expect, it } from "vitest";
import { parseDuration } from "./CopyButton";

describe("copy feedback duration", () => {
  it("reads the design-system token in either unit the build may leave it in", () => {
    expect(parseDuration("1800ms")).toBe(1800);
    expect(parseDuration(" 1.8s")).toBe(1800);
    expect(parseDuration("")).toBe(0);
  });
});
