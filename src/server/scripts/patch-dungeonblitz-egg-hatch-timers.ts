import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  disassemble,
  ensureBackup,
  Instruction,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const DEFAULT_SWF_CANDIDATES = [
  path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf"),
  path.resolve(__dirname, "..", "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf"),
];
const DEFAULT_SWF = DEFAULT_SWF_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? DEFAULT_SWF_CANDIDATES[0];

const OLD_EGG_HATCH_SECONDS = [259200, 518400, 604800] as const;
const MODERN_EGG_HATCH_SECONDS = [259200, 432000, 604800] as const;

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
        "  ts-node src/server/scripts/patch-dungeonblitz-egg-hatch-timers.ts [--verify] [--swf <path>]",
        "",
        "Patches DungeonBlitz.swf egg hatch durations to 3d, 5d, 7d.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function instructionValue(abc: ReturnType<typeof parseAbc>, inst: Instruction): number | null {
  const operand = inst.operands[0];
  if (inst.opcode === 0x2d && operand?.[0] === "u30") {
    return abc.intValues[operand[1]] ?? null;
  }
  return null;
}

function findSequence(abc: ReturnType<typeof parseAbc>, instructions: Instruction[], sequence: readonly number[]): Instruction[] | null {
  for (let index = 0; index < instructions.length; index += 1) {
    const matched: Instruction[] = [];
    let cursor = index;

    while (cursor < instructions.length && matched.length < sequence.length) {
      const inst = instructions[cursor];
      const value = instructionValue(abc, inst);
      if (value === null) {
        cursor += 1;
        continue;
      }
      if (value !== sequence[matched.length]) {
        break;
      }
      matched.push(inst);
      cursor += 1;
    }

    if (matched.length === sequence.length) {
      return matched;
    }
  }
  return null;
}

function findIntIndex(abc: ReturnType<typeof parseAbc>, value: number): number {
  const index = abc.intValues.findIndex((entry) => entry === value);
  if (index < 0) {
    throw new PatchError(`Could not find int constant ${value}.`);
  }
  return index;
}

function findPatches(swfPath: string): { patches: BytePatch[]; oldSequenceCount: number; modernSequenceCount: number } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const fiveDayIntIndex = findIntIndex(abc, MODERN_EGG_HATCH_SECONDS[1]);
  const patches: BytePatch[] = [];
  let oldSequenceCount = 0;
  let modernSequenceCount = 0;

  for (const [methodIdx, methodBody] of abc.methodBodies.entries()) {
    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    let instructions: Instruction[];
    try {
      instructions = disassemble(code, `method_${methodIdx}`);
    } catch {
      continue;
    }

    const oldSequence = findSequence(abc, instructions, OLD_EGG_HATCH_SECONDS);
    const modernSequence = findSequence(abc, instructions, MODERN_EGG_HATCH_SECONDS);
    if (modernSequence) {
      modernSequenceCount += 1;
    }
    if (!oldSequence) {
      continue;
    }

    oldSequenceCount += 1;
    const rareInstruction = oldSequence[1];
    patches.push({
      key: `method_${methodIdx}.rareEggHatchDuration`,
      start: methodBody.codeStart + rareInstruction.offset + 1,
      end: methodBody.codeStart + rareInstruction.offset + rareInstruction.size,
      data: writeU30(fiveDayIntIndex),
      detail: "replace rare egg hatch duration from 6 days to 5 days",
    });
  }

  return { patches, oldSequenceCount, modernSequenceCount };
}

function patchSwf(swfPath: string, verify: boolean): void {
  const firstPass = findPatches(swfPath);
  if (verify) {
    if (firstPass.oldSequenceCount > 0 || firstPass.modernSequenceCount !== 1) {
      throw new PatchError(`Egg hatch timer patch missing: old=${firstPass.oldSequenceCount}, modern=${firstPass.modernSequenceCount}`);
    }
    console.log("Egg hatch timer patch verified.");
    return;
  }

  if (firstPass.patches.length === 0) {
    if (firstPass.modernSequenceCount === 1) {
      console.log("Egg hatch timer patch already applied.");
      return;
    }
    throw new PatchError(`Could not find old or modern egg hatch timer sequence in ${swfPath}`);
  }

  const ctx = parseSwf(swfPath);
  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, firstPass.patches);
  if (delta !== 0) {
    throw new PatchError(`Unexpected egg hatch timer patch size delta: ${delta}`);
  }
  writeSwf(ctx, body, delta);

  const secondPass = findPatches(swfPath);
  if (secondPass.oldSequenceCount > 0 || secondPass.modernSequenceCount !== 1) {
    throw new PatchError(`Egg hatch timer patch did not verify after write: old=${secondPass.oldSequenceCount}, modern=${secondPass.modernSequenceCount}`);
  }

  console.log("Egg hatch timer patch applied.");
}

const args = parseArgs(process.argv);
patchSwf(args.swfPath, args.verify);
