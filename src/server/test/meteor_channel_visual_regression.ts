import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { hasRangedOverrideVisualReset } from "../scripts/patch-dungeonblitz-ranged-override-reset";
import { parseSwz } from "../scripts/swzPatchUtils";

const repoRoot = path.resolve(__dirname, "../../..");
const xmlDir = path.join(repoRoot, "src/client/content/xml");
const cbqDir = path.join(repoRoot, "src/client/content/localhost/p/cbq");
const dungeonBlitzSwfPath = path.join(repoRoot, "src/client/content/localhost/p/cbp/DungeonBlitz.swf");

function blockByPattern(xml: string, pattern: RegExp, label: string): string {
  const match = xml.match(pattern);
  assert(match, `${label} block must exist`);
  return match[0];
}

function powerBlock(xml: string, powerName: string, label: string): string {
  return blockByPattern(xml, new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`), `${label} ${powerName}`);
}

function buffBlock(xml: string, buffName: string, label: string): string {
  return blockByPattern(xml, new RegExp(`<BuffType BuffName="${buffName}">[\\s\\S]*?<\\/BuffType>`), `${label} ${buffName}`);
}

function tagValue(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? null;
}

function swzChunk(swzPath: string, marker: string): string {
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes(marker));
  assert(chunk, `${path.basename(swzPath)} should contain ${marker}`);
  return chunk.xml;
}

function meteorRankSuffix(rank: number): string {
  return rank === 0 ? "" : String(rank);
}

function assertMeteorChannelData(powerXml: string, buffXml: string, label: string): void {
  for (let rank = 0; rank <= 10; rank += 1) {
    const suffix = meteorRankSuffix(rank);
    const meteor = powerBlock(powerXml, `Meteor${suffix}`, label);
    const meteorRor = `MeteorROR${suffix}`;
    const buff = buffBlock(buffXml, meteorRor, label);

    assert.equal(tagValue(meteor, "CastAnim"), "GroupBuff", `${label}: Meteor${suffix} should use the staff buff cast animation`);
    assert.equal(tagValue(meteor, "AddTargetBuff"), meteorRor, `${label}: Meteor${suffix} should apply its RangedOverride buff`);
    assert.equal(tagValue(buff, "RangedOverride"), meteorRor, `${label}: ${meteorRor} should install the meteor ranged override`);
    assert.equal(tagValue(buff, "AnimClass"), "a_SignOfFire", `${label}: ${meteorRor} should keep the visible staff fire buff`);
  }
}

assert(
  hasRangedOverrideVisualReset(dungeonBlitzSwfPath),
  "DungeonBlitz.swf Entity.method_993 must refresh entity visuals after Meteor Channel RangedOverride expires",
);

assertMeteorChannelData(
  fs.readFileSync(path.join(xmlDir, "PlayerPowerTypes.xml"), "utf8"),
  fs.readFileSync(path.join(xmlDir, "PlayerBuffTypes.xml"), "utf8"),
  "loose XML",
);

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  const swzPath = path.join(cbqDir, fileName);
  assertMeteorChannelData(
    swzChunk(swzPath, "<PlayerPowerTypes"),
    swzChunk(swzPath, "<PlayerBuffTypes"),
    fileName,
  );
}

console.log("meteor_channel_visual_regression passed");
