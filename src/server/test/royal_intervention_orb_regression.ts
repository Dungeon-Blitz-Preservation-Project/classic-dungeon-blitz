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

function powerBlock(xml: string, powerName: string): string {
  return blockByPattern(xml, new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`), powerName);
}

function entBlock(xml: string, entName: string): string {
  return blockByPattern(xml, new RegExp(`<EntType EntName="${entName}"[^>]*>[\\s\\S]*?<\\/EntType>`), entName);
}

function tagValue(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim() ?? null;
}

function swzChunk(swzPath: string, marker: string): string {
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes(marker));
  assert(chunk, `${path.basename(swzPath)} must contain ${marker}`);
  return chunk!.xml;
}

function assertSummonFireSpiritUsesFastBomb(powerXml: string, label: string): void {
  const summonPower = powerBlock(powerXml, "SummonFireSpirit");
  assert.equal(tagValue(summonPower, "SpawnedMonsters"), "FireBomb", `${label}: Royal Intervention orbs should use the fast homing bomb`);
}

function assertFireBombChasesAndDetonates(entXml: string, label: string): void {
  const fireBomb = entBlock(entXml, "FireBomb");
  assert.equal(tagValue(fireBomb, "Behavior"), "Homing", `${label}: FireBomb should chase`);
  assert.equal(tagValue(fireBomb, "MeleePower"), "Detonate", `${label}: FireBomb should detonate on contact`);
  assert.ok(Number(tagValue(fireBomb, "Speed") ?? 0) >= 8, `${label}: FireBomb should keep fast chase speed`);
}

assertSummonFireSpiritUsesFastBomb(
  fs.readFileSync(path.join(XML_DIR, "MonsterPowerTypes.xml"), "utf8"),
  "loose MonsterPowerTypes.xml"
);
assertFireBombChasesAndDetonates(
  fs.readFileSync(path.join(XML_DIR, "EntTypes.xml"), "utf8"),
  "loose EntTypes.xml"
);

assertFireBombChasesAndDetonates(swzChunk(LOGIN_SWZ, "<EntTypes"), "Login.swz");

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  assertSummonFireSpiritUsesFastBomb(
    swzChunk(path.join(CBQ_DIR, fileName), "<MonsterPowerTypes"),
    fileName
  );
}

console.log("royal_intervention_orb_regression: ok");
