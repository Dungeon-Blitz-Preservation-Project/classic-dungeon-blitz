import * as path from "path";
import {
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
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

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/patch-dungeonblitz-gear-tooltip-stat-values.ts [--verify] [--swf <path>]",
        "",
        "Patches GearType.method_121 so gear tooltips show the same Attack, Expertise,",
        "and Defense values that are applied to character statistics.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function localIndex(inst: Instruction | undefined): number | null {
  if (!inst) {
    return null;
  }
  if (inst.opcode >= 0xd0 && inst.opcode <= 0xd3) {
    return inst.opcode - 0xd0;
  }
  const operand = inst.operands[0];
  if (inst.opcode === 0x62 && operand?.[0] === "u30") {
    return operand[1];
  }
  return null;
}

function getGearTypeMethod121(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "GearType");
  if (classIndex === null) {
    throw new Error("Could not find GearType class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_121");
  if (methodIdx === null) {
    throw new Error("Could not find GearType.method_121.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new Error(`Could not find method body for GearType.method_121 (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `GearType.method_121:${methodIdx}`);
  return { ctx, methodBody, instructions };
}

function findTooltipSubtract(instructions: Instruction[]): number | null {
  for (let index = 0; index < instructions.length - 3; index += 1) {
    if (
      localIndex(instructions[index]) === 7 &&
      localIndex(instructions[index + 1]) === 8 &&
      instructions[index + 2].opcode === 0xa1 &&
      instructions[index + 3].opcode === 0x48
    ) {
      return index + 1;
    }
  }
  return null;
}

function hasDirectTooltipReturn(instructions: Instruction[]): boolean {
  for (let index = 0; index < instructions.length - 3; index += 1) {
    if (
      localIndex(instructions[index]) === 7 &&
      instructions[index + 1].opcode === 0x2a &&
      instructions[index + 2].opcode === 0x29 &&
      instructions[index + 3].opcode === 0x02 &&
      instructions[index + 4]?.opcode === 0x48
    ) {
      return true;
    }
  }
  return false;
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, methodBody, instructions } = getGearTypeMethod121(swfPath);
  const subtractIndex = findTooltipSubtract(instructions);
  const alreadyPatched = hasDirectTooltipReturn(instructions);

  if (subtractIndex === null) {
    if (alreadyPatched) {
      console.log(`${swfPath}: already patched (gear tooltips show applied stat values).`);
      return;
    }
    throw new Error("Could not find GearType.method_121 tooltip subtraction bytecode.");
  }

  if (verify) {
    throw new Error(`${swfPath}: verify failed; gear tooltips still subtract hidden baseline stat values.`);
  }

  const getLocal8 = instructions[subtractIndex];
  const subtract = instructions[subtractIndex + 1];
  if (getLocal8.size + subtract.size !== 3) {
    throw new Error("Unexpected GearType.method_121 subtraction byte width.");
  }

  ensureBackup(swfPath);
  const patchOffset = methodBody.codeStart + getLocal8.offset;
  ctx.body[patchOffset] = 0x2a; // dup
  ctx.body[patchOffset + 1] = 0x29; // pop
  ctx.body[patchOffset + 2] = 0x02; // nop
  writeSwf(ctx, ctx.body, 0);
  console.log(`${swfPath}: patched gear tooltip stat values.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
