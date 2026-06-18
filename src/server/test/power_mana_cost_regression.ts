import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSwz } from "../scripts/swzPatchUtils";

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");

const EXPECTED_MANA_COSTS = new Map<string, string>([
  ["IceSpike10", "25"],
  ["PainBender10", "25"],
]);

function powerBlock(xml: string, powerName: string): string {
  const match = xml.match(new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`));
  assert(match, `${powerName} should exist`);
  return match[0];
}

function tagValue(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  assert(match, `${tag} should exist`);
  return match[1].trim();
}

function assertPowerManaCosts(xml: string, label: string): void {
  for (const [powerName, expectedManaCost] of EXPECTED_MANA_COSTS) {
    assert.equal(
      tagValue(powerBlock(xml, powerName), "ManaCost"),
      expectedManaCost,
      `${label}: ${powerName} mana cost`
    );
  }
}

function swzPlayerPowerTypes(swzPath: string): string {
  const ctx = parseSwz(swzPath);
  const chunk = ctx.chunks.find((entry) => entry.xml.includes("<PlayerPowerTypes"));
  assert(chunk, `${path.basename(swzPath)} should contain PlayerPowerTypes`);
  return chunk.xml;
}

assertPowerManaCosts(
  fs.readFileSync(path.join(XML_DIR, "PlayerPowerTypes.xml"), "utf8"),
  "source XML"
);

for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
  assertPowerManaCosts(swzPlayerPowerTypes(path.join(CBQ_DIR, fileName)), fileName);
}

console.log("power_mana_cost_regression: ok");
