import * as fs from "fs";
import * as path from "path";
import { hasBuffBackVfxDepthGuard } from "../scripts/patch_dungeonblitz_buff_back_vfx_depth";
import { parseSwz } from "../scripts/swzPatchUtils";

const repoRoot = path.resolve(__dirname, "../../..");
const xmlDir = path.join(repoRoot, "src/client/content/xml");
const cbqDir = path.join(repoRoot, "src/client/content/localhost/p/cbq");
const dungeonBlitzSwfPath = path.join(repoRoot, "src/client/content/localhost/p/cbp/DungeonBlitz.swf");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function playerBuffTypesFromSwz(fileName: string): string {
  const swzPath = path.join(cbqDir, fileName);
  const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes("<PlayerBuffTypes"));
  assert(chunk, `${fileName} should contain PlayerBuffTypes`);
  return chunk.xml;
}

function extractBuff(xml: string, buffName: string, label: string): string {
  const match = xml.match(new RegExp(`<BuffType BuffName="${buffName}">[\\s\\S]*?<\\/BuffType>`));
  assert(match, `${label} should define ${buffName}`);
  return match[0];
}

function assertEmpyreanAuraBuffsStayBehind(xml: string, label: string): void {
  for (let rank = 1; rank <= 10; rank += 1) {
    const buffName = `LeoneanAura${rank}`;
    const buff = extractBuff(xml, buffName, label);

    assert(
      /<BuffLoc>FeetBack<\/BuffLoc>/.test(buff),
      `${label} ${buffName} should use FeetBack so Empyrean Aura renders behind the character`,
    );
    assert(
      /<AnimClass>a_LeoneanAura_Buff<\/AnimClass>/.test(buff),
      `${label} ${buffName} should keep the Empyrean Aura buff visual`,
    );
  }
}

assert(
  hasBuffBackVfxDepthGuard(dungeonBlitzSwfPath),
  "DungeonBlitz.swf Buff.UpdatePos must keep back-layer Empyrean Aura VFX behind the owning entity after depth changes",
);

assertEmpyreanAuraBuffsStayBehind(
  fs.readFileSync(path.join(xmlDir, "PlayerBuffTypes.xml"), "utf8"),
  "loose PlayerBuffTypes.xml",
);

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  assertEmpyreanAuraBuffsStayBehind(playerBuffTypesFromSwz(fileName), fileName);
}

console.log("empyrean_aura_depth_regression passed");
