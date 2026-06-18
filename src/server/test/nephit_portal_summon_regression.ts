import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const XML_DIR = path.join(ROOT, "client", "content", "xml");
const ENT_JSON = path.join(ROOT, "server", "data", "EntTypes.json");
const LOGIN_SWZ = path.join(ROOT, "client", "content", "localhost", "p", "cbp", "Login.swz");

const TARGET_PORTALS = ["NephitPortal", "NephitPortalHard"];
const EXPECTED_WIDTH = "200";
const EXPECTED_HEIGHT = "250";

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

function assertPortalBounds(entXml: string, label: string): void {
  for (const entName of TARGET_PORTALS) {
    const block = entBlock(entXml, entName);
    assert.equal(tagValue(block, "Width"), EXPECTED_WIDTH, `${label}: ${entName} Width`);
    assert.equal(tagValue(block, "Height"), EXPECTED_HEIGHT, `${label}: ${entName} Height`);
    assert.equal(tagValue(block, "Behavior"), "SpawnerNephit", `${label}: ${entName} behavior`);
    assert.equal(tagValue(block, "Powers"), "PortalSpirit", `${label}: ${entName} summon power`);
  }

  assert.equal(tagValue(entBlock(entXml, "DoorPortal"), "Width"), EXPECTED_WIDTH, `${label}: DoorPortal reference Width`);
  assert.equal(tagValue(entBlock(entXml, "DoorPortal"), "Height"), EXPECTED_HEIGHT, `${label}: DoorPortal reference Height`);
  assert.equal(tagValue(entBlock(entXml, "DoorPortalHard"), "Width"), EXPECTED_WIDTH, `${label}: DoorPortalHard reference Width`);
  assert.equal(tagValue(entBlock(entXml, "DoorPortalHard"), "Height"), EXPECTED_HEIGHT, `${label}: DoorPortalHard reference Height`);
}

function assertServerPortalBounds(): void {
  const data = JSON.parse(fs.readFileSync(ENT_JSON, "utf8").replace(/^\ufeff/, ""));
  const entTypes = Array.isArray(data?.EntTypes?.EntType) ? data.EntTypes.EntType : [];
  for (const entName of TARGET_PORTALS) {
    const entry = entTypes.find((candidate: { EntName?: string }) => candidate.EntName === entName);
    assert(entry, `server EntTypes.json must contain ${entName}`);
    assert.equal(entry.Width, EXPECTED_WIDTH, `server EntTypes.json: ${entName} Width`);
    assert.equal(entry.Height, EXPECTED_HEIGHT, `server EntTypes.json: ${entName} Height`);
    assert.equal(entry.Behavior, "SpawnerNephit", `server EntTypes.json: ${entName} Behavior`);
    assert.equal(entry.Powers, "PortalSpirit", `server EntTypes.json: ${entName} Powers`);
  }
}

function loginEntTypesXml(): string {
  const chunk = parseSwz(LOGIN_SWZ).chunks.find((entry) => entry.xml.includes("<EntTypes"));
  assert(chunk, "Login.swz must contain EntTypes");
  return chunk.xml;
}

function assertPortalSpiritPower(): void {
  const powerXml = fs.readFileSync(path.join(XML_DIR, "MonsterPowerTypes.xml"), "utf8");
  const block = powerBlock(powerXml, "PortalSpirit");
  assert.equal(tagValue(block, "TargetMethod"), "Self", "PortalSpirit TargetMethod");
  assert.equal(tagValue(block, "SpawnLimit"), "2", "PortalSpirit SpawnLimit");
  assert(tagValue(block, "SpawnedMonsters")?.includes("SpiritBlackGoblinMace"), "PortalSpirit keeps spirit summon pool");
}

assertPortalBounds(fs.readFileSync(path.join(XML_DIR, "EntTypes.xml"), "utf8"), "loose EntTypes.xml");
assertPortalBounds(loginEntTypesXml(), "Login.swz");
assertServerPortalBounds();
assertPortalSpiritPower();

console.log("nephit_portal_summon_regression passed");
