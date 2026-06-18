import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const ROOT = path.resolve(__dirname, "..", "..");
const MONSTER_POWER_XML = path.join(ROOT, "client", "content", "xml", "MonsterPowerTypes.xml");
const CBQ_DIR = path.join(ROOT, "client", "content", "localhost", "p", "cbq");
const GAME_SWZ_FILES = ["Game.swz", "Game.en.swz", "Game.tr.swz"].map((fileName) =>
  path.join(CBQ_DIR, fileName)
);

const TARGET_POWER = "SummonFireSpirit";
const EXPECTED_SPAWNED_MONSTER = "FireBomb";

type PatchStats = {
  verified: number;
  updated: number;
};

function parseArgs(argv: string[]): { verify: boolean; swzPaths: string[] } {
  const swzPaths: string[] = [];
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--swz-path") {
      const value = argv[++index];
      if (!value) {
        throw new SwzPatchError("--swz-path requires a value");
      }
      swzPaths.push(path.resolve(process.cwd(), value));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch_gameswz_royal_intervention_orbs.ts [--verify] [--swz-path <path>...]",
        "",
        "Makes the Royal Intervention boss summon fast homing FireBombs instead of slow bombs.",
      ].join("\n"));
      process.exit(0);
    }
    throw new SwzPatchError(`Unknown argument: ${arg}`);
  }

  return {
    verify,
    swzPaths: swzPaths.length ? swzPaths : GAME_SWZ_FILES.filter(fs.existsSync),
  };
}

function powerBlock(xml: string, powerName: string): { start: number; end: number; block: string } {
  const match = new RegExp(`<Power PowerName="${powerName}">[\\s\\S]*?<\\/Power>`).exec(xml);
  if (!match || match.index === undefined) {
    throw new SwzPatchError(`MonsterPowerTypes is missing ${powerName}`);
  }

  return {
    start: match.index,
    end: match.index + match[0].length,
    block: match[0],
  };
}

function tagValue(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim() ?? null;
}

function setTag(block: string, tag: string, expectedValue: string): { block: string; changed: boolean } {
  const current = tagValue(block, tag);
  if (current === null) {
    throw new SwzPatchError(`${TARGET_POWER} is missing ${tag}`);
  }
  if (current === expectedValue) {
    return { block, changed: false };
  }

  return {
    block: block.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`), `<${tag}>${expectedValue}</${tag}>`),
    changed: true,
  };
}

export function patchMonsterPowerTypesXml(xml: string): { xml: string; stats: PatchStats } {
  const found = powerBlock(xml, TARGET_POWER);
  const patched = setTag(found.block, "SpawnedMonsters", EXPECTED_SPAWNED_MONSTER);
  const nextXml = `${xml.slice(0, found.start)}${patched.block}${xml.slice(found.end)}`;

  return {
    xml: nextXml,
    stats: { verified: 1, updated: patched.changed ? 1 : 0 },
  };
}

function assertPatched(stats: PatchStats, label: string): void {
  if (stats.verified !== 1) {
    throw new SwzPatchError(`${label} is missing ${TARGET_POWER}`);
  }
  if (stats.updated !== 0) {
    throw new SwzPatchError(`${label} still summons FireBombSlow for Royal Intervention orbs`);
  }
}

function patchLooseXml(verifyOnly: boolean): PatchStats {
  const original = fs.readFileSync(MONSTER_POWER_XML, "utf8");
  const patched = patchMonsterPowerTypesXml(original);
  if (verifyOnly) {
    assertPatched(patched.stats, "MonsterPowerTypes.xml");
    console.log("MonsterPowerTypes.xml: ok");
    return { verified: patched.stats.verified, updated: 0 };
  }

  if (patched.xml !== original) {
    fs.writeFileSync(MONSTER_POWER_XML, patched.xml, "utf8");
    console.log("MonsterPowerTypes.xml: patched Royal Intervention orb summon");
  } else {
    console.log("MonsterPowerTypes.xml: already patched");
  }

  const verified = patchMonsterPowerTypesXml(patched.xml).stats;
  assertPatched(verified, "MonsterPowerTypes.xml");
  return patched.stats;
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const monsterPowerTypes = ctx.chunks.find((chunk) => chunk.xml.match(/<MonsterPowerTypes[>\s]/));
  if (!monsterPowerTypes) {
    throw new SwzPatchError(`${path.basename(swzPath)} is missing MonsterPowerTypes`);
  }

  const patched = patchMonsterPowerTypesXml(monsterPowerTypes.xml);
  if (verifyOnly) {
    assertPatched(patched.stats, path.basename(swzPath));
    console.log(`${path.basename(swzPath)}: ok`);
    return { verified: patched.stats.verified, updated: 0 };
  }

  if (patched.xml !== monsterPowerTypes.xml) {
    monsterPowerTypes.xml = patched.xml;
    ensureBackup(swzPath);
    writeSwz(ctx);
    console.log(`${path.basename(swzPath)}: patched Royal Intervention orb summon`);
  } else {
    console.log(`${path.basename(swzPath)}: already patched`);
  }

  const verified = patchMonsterPowerTypesXml(patched.xml).stats;
  assertPatched(verified, path.basename(swzPath));
  return patched.stats;
}

function main(): void {
  const { swzPaths, verify } = parseArgs(process.argv);
  if (!swzPaths.length) {
    throw new SwzPatchError("No Game SWZ files found");
  }

  const results = [
    patchLooseXml(verify),
    ...swzPaths.map((swzPath) => patchSwz(swzPath, verify)),
  ];
  const updated = results.reduce((sum, result) => sum + result.updated, 0);
  const mode = verify ? "Verified" : "Patched";
  console.log(`${mode} Royal Intervention orb summons (${updated} updates)`);
}

main();
