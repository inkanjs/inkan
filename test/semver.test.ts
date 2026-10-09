import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inkan, plugin } from "../src/index.ts";
import { compareVersions, parseVersion, satisfies } from "../src/core/semver.ts";
import { checkInkan, inkanVersion } from "../src/core/version.ts";

const quiet = { log: false as const };

// [range, version]: each version is in its range
const IN: [string, string][] = [
  // exact and =
  ["1.2.3", "1.2.3"],
  ["=1.2.3", "1.2.3"],
  ["v1.2.3", "1.2.3"],
  ["1.2.3", "1.2.3+build.5"],
  ["1.2.3-rc.1", "1.2.3-rc.1"],
  // comparators
  [">1.2.3", "1.2.4"],
  [">=1.2.3", "1.2.3"],
  ["<1.2.3", "1.2.2"],
  ["<=1.2.3", "1.2.3"],
  [">= 1.2.3", "1.3.0"],
  ["> 1.0.0  <  2.0.0", "1.5.0"],
  // AND
  [">=0.7.0 <0.8.0", "0.7.0"],
  [">=0.7.0 <0.8.0", "0.7.9"],
  [">1.0.0 <=1.0.5", "1.0.5"],
  // OR
  ["0.7.x || 0.8.x", "0.8.3"],
  ["<1.0.0 || >=2.0.0", "2.1.0"],
  ["1.2.3 || 2.0.0", "2.0.0"],
  // caret
  ["^1.2.3", "1.9.9"],
  ["^1.2.3", "1.2.3"],
  ["^0.7.0", "0.7.5"],
  ["^0.0.3", "0.0.3"],
  ["^1.2", "1.4.0"],
  ["^1", "1.0.0"],
  ["^0.x", "0.9.0"],
  ["^0.0.x", "0.0.7"],
  ["^0.0", "0.0.2"],
  ["^1.2.3-beta.2", "1.2.3-beta.4"],
  ["^1.2.3-beta.2", "1.2.3"],
  ["^*", "3.0.0"],
  // tilde
  ["~1.2.3", "1.2.9"],
  ["~1.2", "1.2.0"],
  ["~1", "1.9.0"],
  ["~0.7.0", "0.7.4"],
  ["~>1.2.3", "1.2.5"],
  ["~1.2.3-beta.2", "1.2.3-beta.10"],
  // x-ranges
  ["0.7.x", "0.7.12"],
  ["0.7.X", "0.7.0"],
  ["0.7.*", "0.7.1"],
  ["0.7", "0.7.3"],
  ["1", "1.4.0"],
  ["1.x.x", "1.0.0"],
  ["*", "9.9.9"],
  ["x", "0.0.1"],
  ["", "1.0.0"],
  [">1", "2.0.0"],
  [">1.2", "1.3.0"],
  [">=1.2", "1.2.0"],
  ["<1.2", "1.1.9"],
  ["<=1.2", "1.2.9"],
  ["<=*", "4.0.0"],
  [">=*", "0.0.0"],
  // hyphen
  ["1.2.3 - 2.3.4", "2.3.4"],
  ["1.2 - 2.3", "2.3.9"],
  ["1.2.3 - 2", "2.9.9"],
  // prereleases, where the range names one of the same release
  [">=0.8.0-rc.1 <0.9.0", "0.8.0-rc.2"],
  [">1.2.3-alpha.3", "1.2.3-alpha.7"],
  [">1.2.3-alpha.3", "3.4.5"],
  ["1.2.3-alpha.1 || 2.x", "1.2.3-alpha.1"],
];

// [range, version]: each version is not in its range
const OUT: [string, string][] = [
  ["1.2.3", "1.2.4"],
  [">1.2.3", "1.2.3"],
  ["<1.2.3", "1.2.3"],
  [">=0.7.0 <0.8.0", "0.8.0"],
  [">=0.7.0 <0.8.0", "0.6.9"],
  [">=0.7.0 <0.8.0", "0.9.1"],
  ["0.7.x || 0.8.x", "0.9.0"],
  ["^1.2.3", "2.0.0"],
  ["^1.2.3", "1.2.2"],
  ["^0.7.0", "0.8.0"],
  ["^0.0.3", "0.0.4"],
  ["^0.0", "0.1.0"],
  ["^0.x", "1.0.0"],
  ["~1.2.3", "1.3.0"],
  ["~1", "2.0.0"],
  ["0.7.x", "0.8.0"],
  ["0.7", "0.6.0"],
  [">1", "1.9.9"],
  [">1.2", "1.2.9"],
  ["<1.2", "1.2.0"],
  ["<=1.2", "1.3.0"],
  [">*", "1.0.0"],
  ["<*", "1.0.0"],
  ["1.2.3 - 2.3.4", "2.3.5"],
  ["1.2 - 2.3", "2.4.0"],
  ["1.2.3 - 2.3.4", "1.2.2"],
  // a prerelease is in no range that does not name one of the same release
  ["^0.7.0", "0.8.0-rc.1"],
  [">=0.7.0", "0.8.0-rc.1"],
  [">=0.7.0 <0.8.0", "0.7.5-beta"],
  ["*", "1.0.0-rc.1"],
  ["0.7.x", "0.7.1-alpha"],
  [">1.2.3-alpha.3", "1.2.4-alpha.7"],
  ["^1.2.3-beta.2", "1.2.4-beta.3"],
  ["~1.2.3-beta.2", "1.2.3-beta.1"],
  ["^1.2.3", "2.0.0-0"],
  ["<1.3", "1.3.0-alpha"],
  // not versions at all
  ["*", "1.2"],
  ["*", "latest"],
  ["*", "1.2.3-01"],
];

test("satisfies: versions in their ranges", () => {
  for (const [range, version] of IN) assert.equal(satisfies(version, range), true, `${version} should be in "${range}"`);
});

test("satisfies: versions outside their ranges", () => {
  for (const [range, version] of OUT) assert.equal(satisfies(version, range), false, `${version} should not be in "${range}"`);
});

test("satisfies: throws for what is not a range", () => {
  for (const range of [">=0.7.0 <0.8.0 garbage", "1.2.3.4", ">>1.2.3", "~^1", "1.x.3", "x.2", "1.2-beta", "a.b.c", "01.2.3", "1.2.3 -", "- 1.2.3", ">=1 - 2", "=>1.0.0"]) {
    assert.throws(() => satisfies("1.2.3", range), TypeError, `"${range}" should be refused`);
  }
});

test("compareVersions: prereleases by their identifiers, numeric before alphanumeric, build ignored", () => {
  const order = ["1.0.0-0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];
  for (let i = 1; i < order.length; i++) {
    assert.equal(compareVersions(parseVersion(order[i - 1])!, parseVersion(order[i])!), -1, `${order[i - 1]} < ${order[i]}`);
    assert.equal(compareVersions(parseVersion(order[i])!, parseVersion(order[i - 1])!), 1);
  }
  assert.equal(compareVersions(parseVersion("1.0.0+a")!, parseVersion("1.0.0+b")!), 0);
});

test("inkanVersion: the version in inkan's own package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(inkanVersion(), pkg.version);
});

test("checkInkan: names the plugin, the range and the running version", () => {
  assert.doesNotThrow(() => checkInkan("inkan-quota", ">=0.7.0 <0.8.0", "0.7.3"));
  assert.throws(() => checkInkan("inkan-quota", ">=0.7.0 <0.8.0", "0.9.1"), { message: "inkan-quota needs inkan >=0.7.0 <0.8.0, this app runs 0.9.1" });
  assert.throws(() => checkInkan("inkan-quota", "^0.7.0", "0.8.0-rc.1"), /needs inkan \^0\.7\.0, this app runs 0\.8\.0-rc\.1/);
});

test("register: a plugin for this version runs, one for another is refused before it runs", async () => {
  const running = inkanVersion()!;
  const [major, minor] = running.split(".").map(Number);
  let ran = 0;
  const fits = plugin(() => void ran++, { name: "inkan-fits", inkan: `>=${major}.${minor}.0 <${major}.${minor + 1}.0` });
  const app = inkan(quiet).register(fits);
  await app.ready();
  assert.equal(ran, 1);
  assert.equal(fits.inkan, `>=${major}.${minor}.0 <${major}.${minor + 1}.0`);

  const later = plugin(() => void ran++, { name: "inkan-later", inkan: `>=${major + 1}.0.0` });
  assert.throws(() => inkan(quiet).register(later), { message: `inkan-later needs inkan >=${major + 1}.0.0, this app runs ${running}` });
  assert.equal(ran, 1, "the refused plugin never ran");

  const unnamed = plugin(() => {}, { inkan: "<0.1.0" });
  assert.throws(() => inkan(quiet).register(unnamed), /^Error: This plugin needs inkan <0\.1\.0/);
  assert.doesNotThrow(() => inkan(quiet).register(plugin(() => {}, { name: "any" })), "no range, no check");
});

test("plugin: a range that is not one throws where the plugin is made", () => {
  assert.throws(() => plugin(() => {}, { name: "inkan-quota", inkan: "0.7 or newer" }), {
    name: "TypeError",
    message: /^inkan-quota names the inkan versions it works with as "0\.7 or newer", which is not a version range/,
  });
});
