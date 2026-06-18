import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");

const EXPECTED_PREREQS = new Map<string, string>([
  ["SlayMindlessQueen", "StopBroodvictor"],
  ["SlayMindlessQueenHard", "StopBroodvictorHard"],
]);

function missionBlock(xml: string, missionName: string, label: string): string {
  const match = xml.match(new RegExp(`<MissionType>\\s*<MissionName>${missionName}<\\/MissionName>[\\s\\S]*?<\\/MissionType>`));
  assert.ok(match, `${label}: ${missionName} should exist`);
  return match[0];
}

function tagValue(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim() ?? null;
}

function assertXmlPrereqs(xml: string, label: string): void {
  for (const [missionName, prereq] of EXPECTED_PREREQS) {
    assert.equal(tagValue(missionBlock(xml, missionName, label), "PreReqMissions"), prereq, `${label}: ${missionName} prerequisite`);
  }
}

function assertJsonPrereqs(): void {
  const missions = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "data", "MissionTypes.json"), "utf8")) as Array<Record<string, string>>;
  for (const [missionName, prereq] of EXPECTED_PREREQS) {
    const mission = missions.find((entry) => entry.MissionName === missionName);
    assert.ok(mission, `MissionTypes.json: ${missionName} should exist`);
    assert.equal(mission!.PreReqMissions, prereq, `MissionTypes.json: ${missionName} prerequisite`);
  }
}

function swzMissionTypes(swzPath: string): string {
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.match(/<MissionTypes[>\s]/));
  assert.ok(chunk, `${path.basename(swzPath)} should contain MissionTypes`);
  return chunk!.xml;
}

assertJsonPrereqs();
assertXmlPrereqs(fs.readFileSync(path.join(ROOT, "client", "content", "xml", "MissionTypes.xml"), "utf8"), "loose MissionTypes.xml");

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  assertXmlPrereqs(swzMissionTypes(path.join(CBQ_DIR, fileName)), fileName);
}

console.log("odem_mindless_prereq_regression passed");
