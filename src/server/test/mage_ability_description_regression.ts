import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const XML_DIR = path.join(ROOT, "client", "content", "xml");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");

const DRAGON_SOUL_EXPECTATIONS = new Map<string, { duration: string; boost: string }>([
  ["SummonDragonSoul", { duration: "15", boost: "30%" }],
  ["SummonDragonSoul1", { duration: "11", boost: "15%" }],
  ["SummonDragonSoul2", { duration: "12", boost: "15%" }],
  ["SummonDragonSoul3", { duration: "13", boost: "20%" }],
  ["SummonDragonSoul4", { duration: "13", boost: "20%" }],
  ["SummonDragonSoul5", { duration: "13", boost: "20%" }],
  ["SummonDragonSoul6", { duration: "13.5", boost: "20%" }],
  ["SummonDragonSoul7", { duration: "13.5", boost: "20%" }],
  ["SummonDragonSoul8", { duration: "14.5", boost: "30%" }],
  ["SummonDragonSoul9", { duration: "15", boost: "30%" }],
  ["SummonDragonSoul10", { duration: "15", boost: "30%" }],
]);

const FIREBRAND_POWERS = ["FireBrand", ...Array.from({ length: 10 }, (_, index) => `FireBrand${index + 1}`)];

function blockByPattern(xml: string, pattern: RegExp, label: string): string {
  const match = xml.match(pattern);
  assert(match, `${label} block must exist`);
  return match[0];
}

function powerBlock(xml: string, powerName: string): string {
  return blockByPattern(xml, new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`), powerName);
}

function powerModBlock(xml: string, modName: string): string {
  return blockByPattern(
    xml,
    new RegExp(`<PowerModType>\\s*<ModName>${modName}<\\/ModName>[\\s\\S]*?<\\/PowerModType>`),
    modName,
  );
}

function tagValue(block: string, tag: string): string {
  const value = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1];
  assert.notEqual(value, undefined, `${tag} must exist`);
  return value as string;
}

function fireBrandRank(powerName: string): number {
  if (powerName === "FireBrand") {
    return 10;
  }
  return Number(powerName.slice("FireBrand".length));
}

function expectedFireBrandDescription(rank: number): string {
  if (rank >= 8) {
    return "For 7.8 seconds, your Fireball uses an 800-range Fire Brand shot that applies Scorched.";
  }
  if (rank >= 6) {
    return "For 7.8 seconds, party ranged attacks become Fire Brand shots that deal 50% fire damage in a 120 AoE and apply Scorched and Burned.";
  }
  if (rank >= 3) {
    return "For 7.8 seconds, party ranged attacks become Fire Brand shots that deal 100% fire damage in a 105 AoE and apply Scorched.";
  }
  return "For 7.8 seconds, party ranged attacks become Fire Brand shots that deal 100% fire damage in a 90 AoE and apply Scorched.";
}

function assertMageAbilityDescriptions(powerXml: string, powerModXml: string, label: string): void {
  for (const [powerName, expectation] of DRAGON_SOUL_EXPECTATIONS) {
    const block = powerBlock(powerXml, powerName);
    const description = tagValue(block, "Description");
    assert(description.includes(`for ${expectation.duration} seconds`), `${label}: ${powerName} duration text`);
    assert(description.includes(`+${expectation.boost} attack`), `${label}: ${powerName} attack boost text`);
    assert(!/increased damage/i.test(description), `${label}: ${powerName} description must not use vague damage text`);
    assert(!/reduced Defense/i.test(description), `${label}: ${powerName} description must not mention removed defense penalty`);
  }

  assert.equal(
    tagValue(powerBlock(powerXml, "SummonDragonSoul7"), "UpgradeDescription"),
    "-3 Mana Cost. Dragon Soul shots deal 92% fire damage.",
    `${label}: Dragon Soul rank 7 upgrade text`,
  );
  assert.equal(
    tagValue(powerBlock(powerXml, "SummonDragonSoul10"), "UpgradeDescription"),
    "Dragon Soul lasts 15 seconds, grants +30% attack, and shots deal 98% fire damage.",
    `${label}: Dragon Soul rank 10 upgrade text`,
  );

  for (const powerName of FIREBRAND_POWERS) {
    const block = powerBlock(powerXml, powerName);
    const rank = fireBrandRank(powerName);
    assert.equal(tagValue(block, "Description"), expectedFireBrandDescription(rank), `${label}: ${powerName} description`);
    assert(!/bonus damage against Scorched targets/i.test(block), `${label}: ${powerName} must not describe removed Firebrand bonus damage`);
    assert(!/Party Bonus Damage per stack of Scorch/i.test(block), `${label}: ${powerName} must not keep old party bonus upgrade text`);
    assert(!/Increased? duration/i.test(block), `${label}: ${powerName} must not claim duration scaling`);
  }

  assert.equal(
    tagValue(powerModBlock(powerModXml, "RuneIceSpike"), "Description"),
    "Gain +50% Defense for 1 second during Ice Lance",
    `${label}: RuneIceSpike numeric description`,
  );
}

function swzChunk(swzPath: string, marker: string): string {
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes(marker));
  assert(chunk, `${path.basename(swzPath)} must contain ${marker}`);
  return chunk.xml;
}

assertMageAbilityDescriptions(
  fs.readFileSync(path.join(XML_DIR, "PlayerPowerTypes.xml"), "utf8"),
  fs.readFileSync(path.join(XML_DIR, "PowerModTypes.xml"), "utf8"),
  "loose XML",
);

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  const swzPath = path.join(CBQ_DIR, fileName);
  assertMageAbilityDescriptions(
    swzChunk(swzPath, "<PlayerPowerTypes"),
    swzChunk(swzPath, "<PowerModTypes"),
    fileName,
  );
}

console.log("mage_ability_description_regression passed");
