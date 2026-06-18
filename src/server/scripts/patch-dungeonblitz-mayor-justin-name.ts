import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  ensureBackup,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const DEFAULT_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "DungeonBlitz.swf",
);

const REPLACEMENTS = new Map<string, string>([
  ["Mayor Ristas", "Mayor Justin"],
  ["Wait, I need to talk to Mayor Ristas first:He's right behind me", "Wait, I need to talk to Mayor Justin first:He's right behind me"],
]);

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch-dungeonblitz-mayor-justin-name.ts [--verify] [--swf <path>]",
        "",
        "Patches DungeonBlitz.swf client-side Mayor Ristas name and tutorial skit text to Mayor Justin.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function buildStringPatch(
  index: number,
  oldValue: string,
  newValue: string,
  abc: ReturnType<typeof parseAbc>,
): BytePatch {
  const oldBytes = Buffer.from(oldValue, "utf8");
  const newBytes = Buffer.from(newValue, "utf8");
  const lenStart = abc.stringLenPositions[index];
  const dataStart = abc.stringDataPositions[index];

  return {
    key: `abc.string.${index}.${oldValue}`,
    start: lenStart,
    end: dataStart + oldBytes.length,
    data: Buffer.concat([writeU30(newBytes.length), newBytes]),
    detail: `replace "${oldValue}" with "${newValue}"`,
  };
}

function findPatches(swfPath: string): { ctx: ReturnType<typeof parseSwf>; patches: BytePatch[]; oldCount: number; newCount: number } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const patches: BytePatch[] = [];
  let oldCount = 0;
  let newCount = 0;

  for (let index = 1; index < abc.stringValues.length; index += 1) {
    const value = abc.stringValues[index];
    const replacement = REPLACEMENTS.get(value);
    if (replacement) {
      oldCount += 1;
      patches.push(buildStringPatch(index, value, replacement, abc));
      continue;
    }

    if ([...REPLACEMENTS.values()].includes(value)) {
      newCount += 1;
    }
  }

  return { ctx, patches, oldCount, newCount };
}

function patchSwf(swfPath: string, verify: boolean): void {
  const firstPass = findPatches(swfPath);
  if (verify) {
    if (firstPass.oldCount > 0 || firstPass.newCount < REPLACEMENTS.size) {
      throw new PatchError(`Mayor Justin SWF patch missing: old=${firstPass.oldCount}, new=${firstPass.newCount}`);
    }
    console.log("Mayor Justin SWF strings verified.");
    return;
  }

  if (firstPass.patches.length === 0) {
    if (firstPass.newCount >= REPLACEMENTS.size) {
      console.log("Mayor Justin SWF strings already patched.");
      return;
    }
    throw new PatchError(`Expected Mayor Ristas SWF strings, found old=${firstPass.oldCount}, new=${firstPass.newCount}`);
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(firstPass.ctx.body, firstPass.patches);
  writeSwf(firstPass.ctx, body, delta);

  const secondPass = findPatches(swfPath);
  if (secondPass.oldCount > 0 || secondPass.newCount < REPLACEMENTS.size) {
    throw new PatchError(`Mayor Justin SWF patch did not verify after write: old=${secondPass.oldCount}, new=${secondPass.newCount}`);
  }

  console.log(`Mayor Justin SWF strings patched (${firstPass.patches.length} replacements).`);
}

const args = parseArgs(process.argv);
patchSwf(args.swfPath, args.verify);
