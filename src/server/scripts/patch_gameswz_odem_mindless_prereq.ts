import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");

const REQUIRED_PREREQS = new Map<string, string>([
  ["SlayMindlessQueen", "StopBroodvictor"],
  ["SlayMindlessQueenHard", "StopBroodvictorHard"],
]);

function defaultGameSwzPaths(): string[] {
  return ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter((swzPath) => fs.existsSync(swzPath));
}

function parseArgs(argv: string[]): { swzPaths: string[]; verify: boolean } {
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
        throw new Error("--swz-path requires a value");
      }
      swzPaths.push(path.resolve(process.cwd(), value));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch_gameswz_odem_mindless_prereq.ts [--verify] [--swz-path <path>...]",
        "",
        "Ensures Odem's Mindless Queen missions require the Vizier dungeon first.",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    swzPaths: swzPaths.length ? swzPaths : defaultGameSwzPaths(),
    verify,
  };
}

function missionBlock(xml: string, missionName: string): { start: number; end: number; block: string } {
  const pattern = new RegExp(`<MissionType>\\s*<MissionName>${missionName}<\\/MissionName>[\\s\\S]*?<\\/MissionType>`);
  const match = pattern.exec(xml);
  if (!match || match.index === undefined) {
    throw new SwzPatchError(`MissionTypes is missing ${missionName}`);
  }

  return {
    start: match.index,
    end: match.index + match[0].length,
    block: match[0],
  };
}

function patchMissionBlock(block: string, prereq: string): { block: string; changed: boolean } {
  const current = block.match(/<PreReqMissions>([\s\S]*?)<\/PreReqMissions>/)?.[1]?.trim();
  if (current === prereq) {
    return { block, changed: false };
  }

  if (current !== undefined) {
    return {
      block: block.replace(/<PreReqMissions>[\s\S]*?<\/PreReqMissions>/, `<PreReqMissions>${prereq}</PreReqMissions>`),
      changed: true,
    };
  }

  const missionIdMatch = block.match(/\n(\s*)<MissionID>[\s\S]*?<\/MissionID>/);
  if (!missionIdMatch) {
    throw new SwzPatchError("Mission block is missing MissionID");
  }
  const indent = missionIdMatch[1] ?? "\t\t";
  const insertion = `${missionIdMatch[0]}\n${indent}<PreReqMissions>${prereq}</PreReqMissions>`;
  return {
    block: block.replace(missionIdMatch[0], insertion),
    changed: true,
  };
}

export function patchMissionTypes(xml: string): { xml: string; changed: boolean } {
  let nextXml = xml;
  let changed = false;

  for (const [missionName, prereq] of REQUIRED_PREREQS) {
    const found = missionBlock(nextXml, missionName);
    const patched = patchMissionBlock(found.block, prereq);
    nextXml = `${nextXml.slice(0, found.start)}${patched.block}${nextXml.slice(found.end)}`;
    changed = changed || patched.changed;
  }

  return { xml: nextXml, changed };
}

function patchSwz(swzPath: string, verifyOnly: boolean): boolean {
  const ctx = parseSwz(swzPath);
  const missionTypes = ctx.chunks.find((chunk) => chunk.xml.match(/<MissionTypes[>\s]/));
  if (!missionTypes) {
    throw new SwzPatchError(`${path.basename(swzPath)} is missing MissionTypes`);
  }

  const patched = patchMissionTypes(missionTypes.xml);
  if (verifyOnly) {
    if (patched.changed) {
      throw new SwzPatchError(`${path.basename(swzPath)} is missing Odem Mindless Queen prerequisites`);
    }
    console.log(`${path.basename(swzPath)}: ok`);
    return false;
  }

  if (!patched.changed) {
    console.log(`${path.basename(swzPath)}: already patched`);
    return false;
  }

  missionTypes.xml = patched.xml;
  ensureBackup(swzPath);
  writeSwz(ctx);
  console.log(`${path.basename(swzPath)}: patched Odem Mindless Queen prerequisites`);
  return true;
}

function main(): void {
  const { swzPaths, verify } = parseArgs(process.argv);
  if (!swzPaths.length) {
    throw new SwzPatchError("No Game SWZ files found");
  }

  let changed = 0;
  for (const swzPath of swzPaths) {
    changed += patchSwz(swzPath, verify) ? 1 : 0;
  }
  if (!verify) {
    console.log(`Updated ${changed} Game SWZ file(s).`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_odem_mindless_prereq] ${message}`);
    process.exitCode = 1;
  }
}
