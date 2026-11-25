import { describe, expect, it } from "vitest";
import {
  capReleases,
  isBrandRelease,
  isInstallableRelease,
  isPrerelease,
  pickLatest,
  sortReleases,
  type Release,
} from "./releases";

const asset = (name: string) => ({ name, size: 1, browser_download_url: `https://example.test/${name}` });

function release(tag: string, names: string[], prerelease = false): Release {
  return { tag_name: tag, draft: false, prerelease, assets: names.map(asset) };
}

/** 本产品的已签名发布：quetzalcoatl-* 资产 + 签名清单。 */
function signed(tag: string, prerelease = false): Release {
  const version = tag.replace(/^v/, "");
  return release(
    tag,
    [`quetzalcoatl-${version}-linux-x64.tar.gz`, "SHA256SUMS", "SHA256SUMS.sig"],
    prerelease,
  );
}

/** V1 的旧发布：没有 quetzalcoatl-* 资产，只有签名清单。 */
function legacyV1(tag = "v1.11.0"): Release {
  return release(tag, ["quetzal-1.11.0-linux-x64.tar.gz", "SHA256SUMS", "SHA256SUMS.sig"]);
}

describe("release selection", () => {
  it("never resolves the legacy V1 release even when it is the only signed release", () => {
    const qualified = [legacyV1()].filter(isInstallableRelease);
    expect(qualified).toHaveLength(0);
    expect(pickLatest(qualified)).toBeUndefined();
  });

  it("excludes a release with quetzalcoatl-* assets but no signature", () => {
    const unsigned = release("v2.0.0", ["quetzalcoatl-2.0.0-linux-x64.tar.gz"]);
    expect(isBrandRelease(unsigned)).toBe(true);
    expect(isInstallableRelease(unsigned)).toBe(false);

    const mixed = [unsigned, legacyV1()].filter(isInstallableRelease);
    expect(mixed).toHaveLength(0);
  });

  it("falls back to the newest qualifying prerelease when no stable release exists", () => {
    const latest = pickLatest([legacyV1(), signed("v2.0.0-alpha.1", true)].filter(isInstallableRelease));

    expect(latest?.tag_name).toBe("v2.0.0-alpha.1");
    expect(isPrerelease(latest as Release)).toBe(true);
  });

  it("prefers the newest stable release over a newer prerelease", () => {
    const stable = signed("v2.0.0");
    const beta = signed("v3.0.0-beta.1", true);
    expect(pickLatest([beta, stable])?.tag_name).toBe("v2.0.0");
  });

  it("picks the newest stable when several qualify", () => {
    expect(pickLatest([signed("v2.0.0"), signed("v2.0.1")])?.tag_name).toBe("v2.0.1");
  });

  it("treats the GitHub prerelease flag as authoritative", () => {
    const flagged = signed("v2.0.0", true);
    expect(isPrerelease(flagged)).toBe(true);
    expect(pickLatest([flagged])?.tag_name).toBe("v2.0.0");
  });

  it("also detects a prerelease from the tag suffix", () => {
    expect(isPrerelease(signed("v2.0.0-rc.1"))).toBe(true);
    expect(isPrerelease(signed("v2.0.0"))).toBe(false);
  });

  it("orders mixed releases newest first, stable before its own prerelease", () => {
    const order = sortReleases([
      signed("v2.0.0"),
      signed("v2.0.0-alpha.2", true),
      signed("v2.0.1"),
    ]).map((r) => String(r.tag_name));
    expect(order).toEqual(["v2.0.1", "v2.0.0", "v2.0.0-alpha.2"]);
  });

  it("does not cap when the npm package is missing", () => {
    expect(capReleases([signed("v2.0.0")], undefined)).toHaveLength(1);
  });
});
