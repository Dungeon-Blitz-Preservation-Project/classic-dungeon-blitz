import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const XML_DIR = path.join(ROOT, "client", "content", "xml");
const LOGIN_SWZ = path.join(ROOT, "client", "content", "localhost", "p", "cbp", "Login.swz");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");

function blockByPattern(xml: string, pattern: RegExp, label: string): string {
  const match = xml.match(pattern);
  assert(match, `${label} block must exist`);
  return match[0];
}

function entBlock(xml: string, entName: string): string {
  return blockByPattern(xml, new RegExp(`<EntType EntName="${entName}"[^>]*>[\\s\\S]*?<\\/EntType>`), entName);
}

function powerBlock(xml: string, powerName: string): string {
  return blockByPattern(xml, new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`), powerName);
}

function tagValue(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim() ?? null;
}

function assertDemonReaperSingleShotEntTypes(entXml: string, label: string): void {
  for (const entName of ["DemonReaper", "DemonReaperHard"]) {
    assert.equal(tagValue(entBlock(entXml, entName), "RangedPower"), "BruteShot", `${label}: ${entName} ranged power`);
  }
}

function assertBruteShotPowerShape(powerXml: string, label: string): void {
  assert.equal(tagValue(powerBlock(powerXml, "BruteShot"), "ComboName"), null, `${label}: BruteShot should remain a single projectile`);
  assert.equal(tagValue(powerBlock(powerXml, "BruteShot2"), "ComboName"), "BruteShot3", `${label}: BruteShot2 should remain a two-shot combo for other enemies`);
}

function swzChunk(swzPath: string, marker: string): string | null {
  return parseSwz(swzPath).chunks.find((entry) => entry.xml.includes(marker))?.xml ?? null;
}

assertDemonReaperSingleShotEntTypes(fs.readFileSync(path.join(XML_DIR, "EntTypes.xml"), "utf8"), "loose EntTypes.xml");
assertBruteShotPowerShape(fs.readFileSync(path.join(XML_DIR, "MonsterPowerTypes.xml"), "utf8"), "loose MonsterPowerTypes.xml");

const loginEntXml = swzChunk(LOGIN_SWZ, "<EntTypes");
assert(loginEntXml, "Login.swz must contain EntTypes");
assertDemonReaperSingleShotEntTypes(loginEntXml!, "Login.swz");

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  const swzPath = path.join(CBQ_DIR, fileName);
  const powerXml = swzChunk(swzPath, "<MonsterPowerTypes");
  assert(powerXml, `${fileName} must contain MonsterPowerTypes`);
  assertBruteShotPowerShape(powerXml!, fileName);
}

console.log("valhaven_demon_reaper_shot_regression passed");
