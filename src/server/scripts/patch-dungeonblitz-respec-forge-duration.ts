import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  methodIdxForTrait,
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

const OLD_FORCED_RESPEC_SECONDS = 259200;
const NORMAL_RESPEC_SECONDS = 180;
const EXTENDED_RESPEC_SECONDS = 86400;

type RespecSlot = {
  label: "normal-first" | "extended" | "active-fallback";
  expectedSeconds: number;
  instruction: Instruction;
};

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
        "  ts-node src/server/scripts/patch-dungeonblitz-respec-forge-duration.ts [--verify] [--swf <path>]",
        "",
        "Patches DungeonBlitz.swf so the first local Respec Stone forge uses 3 minutes,",
        "while active/extended Respec Stone duration paths use 24 hours.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function pushIntValue(abc: ReturnType<typeof parseAbc>, inst: Instruction | undefined): number | null {
  const operand = inst?.operands?.[0];
  if (!inst || inst.opcode !== 0x2d || !operand || operand[0] !== "u30") {
    return null;
  }
  return abc.intValues[operand[1]] ?? null;
}

function nopPaddedPushInt(valueIndex: number, oldLength: number): Buffer {
  const pushInt = Buffer.concat([Buffer.from([0x2d]), writeU30(valueIndex)]);
  if (pushInt.length > oldLength) {
    throw new PatchError(`Respec forge duration replacement is too long: ${pushInt.length} > ${oldLength}`);
  }
  return Buffer.concat([pushInt, Buffer.alloc(oldLength - pushInt.length, 0x02)]);
}

function getIntIndex(abc: ReturnType<typeof parseAbc>, value: number): number {
  const index = abc.intValues.findIndex((entry) => entry === value);
  if (index < 0) {
    throw new PatchError(`Could not find int constant ${value}.`);
  }
  return index;
}

function findRespecSlots(instructions: Instruction[]): Instruction[] {
  return instructions.filter((inst, index) =>
    inst.opcode === 0x2d &&
    instructions[index + 1]?.opcode === 0x02 &&
    instructions[index + 2]?.opcode === 0x02
  );
}

function findPatches(swfPath: string): {
  patches: BytePatch[];
  patchedCount: number;
  oldForcedCount: number;
  slotValues: number[];
} {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "class_86");
  if (classIndex === null) {
    throw new PatchError("Could not find class_86.");
  }

  const methodIdx = methodIdxForTrait(
    [...abc.instances[classIndex].traits, ...(abc.classTraits[classIndex] ?? [])],
    abc,
    "GetTimeAfterBonuses",
  );
  if (methodIdx === null) {
    throw new PatchError("Could not find class_86.GetTimeAfterBonuses.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError("Could not find class_86.GetTimeAfterBonuses body.");
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, "class_86.GetTimeAfterBonuses");
  const directSlots = findRespecSlots(instructions).filter((inst) => {
    const value = pushIntValue(abc, inst);
    return value === OLD_FORCED_RESPEC_SECONDS || value === NORMAL_RESPEC_SECONDS || value === EXTENDED_RESPEC_SECONDS;
  });

  if (directSlots.length !== 3) {
    throw new PatchError(`Expected three direct Respec forge duration slots, found ${directSlots.length}.`);
  }

  const desiredSlots: RespecSlot[] = [
    { label: "normal-first", expectedSeconds: NORMAL_RESPEC_SECONDS, instruction: directSlots[0] },
    { label: "extended", expectedSeconds: EXTENDED_RESPEC_SECONDS, instruction: directSlots[1] },
    { label: "active-fallback", expectedSeconds: EXTENDED_RESPEC_SECONDS, instruction: directSlots[2] },
  ];
  const indexes = {
    [NORMAL_RESPEC_SECONDS]: getIntIndex(abc, NORMAL_RESPEC_SECONDS),
    [EXTENDED_RESPEC_SECONDS]: getIntIndex(abc, EXTENDED_RESPEC_SECONDS),
  } as Record<number, number>;

  const patches: BytePatch[] = [];
  let patchedCount = 0;
  let oldForcedCount = 0;
  const slotValues: number[] = [];

  for (const slot of desiredSlots) {
    const currentValue = pushIntValue(abc, slot.instruction);
    slotValues.push(Number(currentValue ?? 0));

    if (currentValue === slot.expectedSeconds) {
      patchedCount += 1;
      continue;
    }

    if (
      currentValue === OLD_FORCED_RESPEC_SECONDS ||
      (slot.expectedSeconds === EXTENDED_RESPEC_SECONDS && currentValue === NORMAL_RESPEC_SECONDS)
    ) {
      oldForcedCount += 1;
      patches.push({
        key: `class_86.GetTimeAfterBonuses.respec.${slot.label}.${methodBody.codeStart + slot.instruction.offset}`,
        start: methodBody.codeStart + slot.instruction.offset,
        end: methodBody.codeStart + slot.instruction.offset + slot.instruction.size,
        data: nopPaddedPushInt(indexes[slot.expectedSeconds], slot.instruction.size),
        detail: `set ${slot.label} Respec Stone forge duration to ${slot.expectedSeconds} seconds`,
      });
      continue;
    }

    throw new PatchError(
      `Unexpected ${slot.label} Respec forge duration ${currentValue}; expected ${slot.expectedSeconds}, ${NORMAL_RESPEC_SECONDS}, or ${OLD_FORCED_RESPEC_SECONDS}.`,
    );
  }

  return { patches, patchedCount, oldForcedCount, slotValues };
}

function patchSwf(swfPath: string, verify: boolean): void {
  const firstPass = findPatches(swfPath);
  if (verify) {
    if (firstPass.oldForcedCount > 0 || firstPass.patchedCount !== 3) {
      throw new PatchError(
        `Respec forge duration patch missing: oldForced=${firstPass.oldForcedCount}, patched=${firstPass.patchedCount}, values=${firstPass.slotValues.join(",")}`,
      );
    }
    console.log("Respec forge duration patch verified.");
    return;
  }

  if (firstPass.patches.length === 0) {
    if (firstPass.patchedCount === 3) {
      console.log("Respec forge duration patch already applied.");
      return;
    }
    throw new PatchError(
      `Expected Respec forge duration patch points, found oldForced=${firstPass.oldForcedCount}, patched=${firstPass.patchedCount}, values=${firstPass.slotValues.join(",")}`,
    );
  }

  const ctx = parseSwf(swfPath);
  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, firstPass.patches);
  if (delta !== 0) {
    throw new PatchError(`Unexpected Respec forge duration patch size delta: ${delta}`);
  }
  writeSwf(ctx, body, delta);

  const secondPass = findPatches(swfPath);
  if (secondPass.oldForcedCount > 0 || secondPass.patchedCount !== 3) {
    throw new PatchError(
      `Respec forge duration patch did not verify after write: oldForced=${secondPass.oldForcedCount}, patched=${secondPass.patchedCount}, values=${secondPass.slotValues.join(",")}`,
    );
  }

  console.log("Respec forge duration patch applied.");
}

const args = parseArgs(process.argv);
patchSwf(args.swfPath, args.verify);
