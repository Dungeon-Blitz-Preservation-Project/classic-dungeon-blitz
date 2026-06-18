import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
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

const CRIT_CHANCE_LOCALS = new Set([7, 65]);
const EXPECTED_PATCHED_SEQUENCES = 3;

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
        "  ts-node src/server/scripts/patch-dungeonblitz-critical-chance-stat-display.ts [--verify] [--swf <path>]",
        "",
        "Patches DungeonBlitz.swf ScreenArmory so the Critical Chance stat page",
        "formats gear/charm proc chance as +16.5% instead of rounded +17%.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function multiname(abc: ReturnType<typeof parseAbc>, inst: Instruction): string | null {
  const operand = inst.operands[0];
  if (!operand || operand[0] !== "u30") {
    return null;
  }
  return abc.multinameNames[operand[1]] ?? null;
}

function localOperand(inst: Instruction): number | null {
  if (inst.opcode >= 0xd0 && inst.opcode <= 0xd3) {
    return inst.opcode - 0xd0;
  }
  const operand = inst.operands[0];
  if (inst.opcode !== 0x62 || !operand || operand[0] !== "u30") {
    return null;
  }
  return operand[1];
}

function pushByteValue(inst: Instruction): number | null {
  const operand = inst.operands[0];
  if (inst.opcode !== 0x24 || !operand || operand[0] !== "s8") {
    return null;
  }
  return operand[1];
}

function isRoundCall(abc: ReturnType<typeof parseAbc>, inst: Instruction): boolean {
  return inst.opcode === 0x46 && multiname(abc, inst) === "round";
}

function isGetLexMath(abc: ReturnType<typeof parseAbc>, inst: Instruction | undefined): boolean {
  return Boolean(inst && inst.opcode === 0x60 && multiname(abc, inst) === "Math");
}

function nops(count: number): Buffer {
  return Buffer.alloc(count, 0x02);
}

function buildInventoryScalePatch(localBytes: Buffer, oldLen: number): Buffer {
  const replacement = Buffer.concat([
    localBytes,
    Buffer.from([0x24, 0x0f, 0xa2]),
  ]);
  if (replacement.length > oldLen) {
    throw new PatchError(`Unexpected Critical Chance replacement length: ${oldLen} -> ${replacement.length}`);
  }
  return Buffer.concat([replacement, nops(oldLen - replacement.length)]);
}

function isScaledInventoryDisplay(instructions: Instruction[], index: number): boolean {
  return (
    pushByteValue(instructions[index + 1]) === 15 &&
    instructions[index + 2]?.opcode === 0xa2 &&
    instructions[index + 3]?.opcode === 0x02
  );
}

function getScreenArmoryMethodBodies(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "ScreenArmory");
  if (classIndex === null) {
    throw new PatchError("Could not find ScreenArmory class.");
  }

  const methodBodies: Array<{
    methodBody: NonNullable<ReturnType<typeof parseAbc>["methodBodies"] extends Map<number, infer T> ? T : never>;
    instructions: Instruction[];
  }> = [];

  const traits = [
    ...abc.instances[classIndex].traits,
    ...(abc.classTraits[classIndex] ?? []),
  ];
  for (const trait of traits) {
    const methodIdx = trait.methodIdx;
    if (methodIdx === null) {
      continue;
    }
    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
      continue;
    }
    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    try {
      methodBodies.push({
        methodBody,
        instructions: disassemble(code, `ScreenArmory.${abc.multinameNames[trait.nameIdx] ?? methodIdx}`),
      });
    } catch {
      continue;
    }
  }

  return { ctx, abc, methodBodies };
}

function findCriticalChanceStatPatches(swfPath: string): { patches: BytePatch[]; oldCount: number; patchedCount: number } {
  const { ctx, abc, methodBodies } = getScreenArmoryMethodBodies(swfPath);
  const patches: BytePatch[] = [];
  let oldCount = 0;
  let patchedCount = 0;

  for (const { methodBody, instructions } of methodBodies) {
    for (let index = 0; index < instructions.length - 3; index += 1) {
      const previousInst = instructions[index - 1];
      const localInst = instructions[index];
      const scaleInst = instructions[index + 1];
      const multiplyInst = instructions[index + 2];
      const roundInst = instructions[index + 3];
      const local = localOperand(localInst);
      if (local === null || !CRIT_CHANCE_LOCALS.has(local)) {
        continue;
      }

      if (isScaledInventoryDisplay(instructions, index)) {
        patchedCount += 1;
        continue;
      }

      const localBytes = ctx.body.subarray(
        methodBody.codeStart + localInst.offset,
        methodBody.codeStart + localInst.offset + localInst.size,
      );

      if (
        pushByteValue(scaleInst) === 15 &&
        multiplyInst.opcode === 0xa2 &&
        roundInst.opcode === 0x02 &&
        instructions[index + 4]?.opcode === 0x02 &&
        instructions[index + 5]?.opcode === 0x02
      ) {
        const firstNop = instructions[index - 2];
        if (!firstNop || firstNop.opcode !== 0x02 || previousInst?.opcode !== 0x02) {
          throw new PatchError(`Unexpected patched Critical Chance stale-stack shape for local ${local}.`);
        }
        const oldLen =
          firstNop.size +
          previousInst.size +
          localInst.size +
          scaleInst.size +
          multiplyInst.size +
          roundInst.size +
          instructions[index + 4].size +
          instructions[index + 5].size;
        const scaledReplacement = buildInventoryScalePatch(localBytes, oldLen);
        oldCount += 1;
        patches.push({
          key: `ScreenArmory.criticalChance.rawStaleScale.local${local}.${methodBody.codeStart + firstNop.offset}`,
          start: methodBody.codeStart + firstNop.offset,
          end: methodBody.codeStart + instructions[index + 5].offset + instructions[index + 5].size,
          data: scaledReplacement,
          detail: `display Critical Chance local ${local} after scaling by 15`,
        });
        continue;
      }

      if (
        !isGetLexMath(abc, previousInst) ||
        (pushByteValue(scaleInst) !== 100 && pushByteValue(scaleInst) !== 15) ||
        multiplyInst.opcode !== 0xa2 ||
        !isRoundCall(abc, roundInst)
      ) {
        continue;
      }

      const oldLen = previousInst.size + localInst.size + scaleInst.size + multiplyInst.size + roundInst.size;
      const scaledReplacement = buildInventoryScalePatch(localBytes, oldLen);

      oldCount += 1;
      patches.push({
        key: `ScreenArmory.criticalChance.statScale.local${local}.${methodBody.codeStart + scaleInst.offset}`,
        start: methodBody.codeStart + previousInst.offset,
        end: methodBody.codeStart + roundInst.offset + roundInst.size,
        data: scaledReplacement,
        detail: `scale Critical Chance local ${local} by 15 and keep the displayed decimal`,
      });
    }
  }

  return { patches, oldCount, patchedCount };
}

export function patchCriticalChanceStatDisplay(swfPath: string, verifyOnly = false): void {
  const firstPass = findCriticalChanceStatPatches(swfPath);
  if (!verifyOnly && firstPass.patches.length > 0) {
    const ctx = parseSwf(swfPath);
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, firstPass.patches);
    writeSwf(ctx, body, delta);
  }

  const verifyPass = findCriticalChanceStatPatches(swfPath);
  if (verifyPass.oldCount !== 0 || verifyPass.patchedCount !== EXPECTED_PATCHED_SEQUENCES) {
    throw new PatchError(
      `Critical Chance stat display verification failed: old=${verifyPass.oldCount}, patched=${verifyPass.patchedCount}`,
    );
  }

  console.log(
    `${verifyOnly ? "Verified" : firstPass.patches.length > 0 ? "Patched" : "Already patched"} Critical Chance stat display in ${swfPath}`,
  );
}

if (require.main === module) {
  const { swfPath, verify } = parseArgs(process.argv);
  patchCriticalChanceStatDisplay(swfPath, verify);
}
