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
  readU30,
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

const BRANCH_OPCODES = new Set([
  0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a,
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
        "  npx ts-node src/server/scripts/patch-dungeonblitz-ranged-override-reset.ts [--verify] [--swf <path>]",
        "",
        "Patches Entity.method_993 so removing a RangedOverride buff",
        "refreshes the entity animation state after restoring the base ranged power.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function s24(value: number): Buffer {
  if (value < -0x800000 || value > 0x7fffff) {
    throw new PatchError(`s24 branch offset out of range: ${value}`);
  }
  const out = Buffer.alloc(3);
  out.writeIntLE(value, 0, 3);
  return out;
}

function multinameIndex(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((entry) => entry === name);
  if (index < 0) {
    throw new PatchError(`Could not find multiname ${name}.`);
  }
  return index;
}

function multiname(abc: ReturnType<typeof parseAbc>, inst: Instruction | undefined): string | null {
  const operand = inst?.operands[0];
  if (!operand || operand[0] !== "u30") {
    return null;
  }
  return abc.multinameNames[operand[1]] ?? null;
}

function buildResetEntTypeCall(abc: ReturnType<typeof parseAbc>): Buffer {
  return Buffer.concat([
    Buffer.from([0xd0, 0xd0, 0x66]),
    writeU30(multinameIndex(abc, "entType")),
    Buffer.from([0x26, 0x4f]),
    writeU30(multinameIndex(abc, "ResetEntType")),
    writeU30(2),
  ]);
}

function getEntityMethod993(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "Entity");
  if (classIndex === null) {
    throw new PatchError("Could not find Entity class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_993");
  if (methodIdx === null) {
    throw new PatchError("Could not find Entity.method_993.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for Entity.method_993 (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  return { ctx, abc, methodBody, code };
}

function findMethod904Call(abc: ReturnType<typeof parseAbc>, instructions: Instruction[]): Instruction | null {
  return instructions.find((inst) => inst.opcode === 0x4f && multiname(abc, inst) === "method_904") ?? null;
}

function hasResetAfterMethod904(abc: ReturnType<typeof parseAbc>, instructions: Instruction[]): boolean {
  const method904 = findMethod904Call(abc, instructions);
  if (!method904) {
    return false;
  }

  const startIndex = instructions.indexOf(method904) + 1;
  const resetCall = instructions.slice(startIndex, startIndex + 6);
  return (
    resetCall[0]?.opcode === 0xd0 &&
    resetCall[1]?.opcode === 0xd0 &&
    resetCall[2]?.opcode === 0x66 &&
    multiname(abc, resetCall[2]) === "entType" &&
    resetCall[3]?.opcode === 0x26 &&
    resetCall[4]?.opcode === 0x4f &&
    multiname(abc, resetCall[4]) === "ResetEntType" &&
    resetCall[4].operands[1]?.[1] === 2
  );
}

export function hasRangedOverrideVisualReset(swfPath: string): boolean {
  const { abc, code } = getEntityMethod993(swfPath);
  return hasResetAfterMethod904(abc, disassemble(code, "Entity.method_993"));
}

function patchBranchesForInsertion(code: Buffer, instructions: Instruction[], insertAt: number, delta: number): Buffer {
  const patched = Buffer.from(code);
  for (const inst of instructions) {
    if (!BRANCH_OPCODES.has(inst.opcode)) {
      continue;
    }
    const operand = inst.operands[0];
    if (!operand || operand[0] !== "s24") {
      continue;
    }

    const oldSourceEnd = inst.offset + inst.size;
    const oldTarget = oldSourceEnd + operand[1];
    let nextOperand = operand[1];
    if (inst.offset < insertAt && oldTarget > insertAt) {
      nextOperand += delta;
    } else if (inst.offset >= insertAt && oldTarget <= insertAt) {
      nextOperand -= delta;
    }

    if (nextOperand !== operand[1]) {
      s24(nextOperand).copy(patched, inst.offset + 1);
    }
  }
  return patched;
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code } = getEntityMethod993(swfPath);
  const instructions = disassemble(code, "Entity.method_993");
  if (hasResetAfterMethod904(abc, instructions)) {
    console.log(`${swfPath}: already patched (RangedOverride visual reset present).`);
    return;
  }

  const method904Call = findMethod904Call(abc, instructions);
  if (!method904Call) {
    throw new PatchError(`${swfPath}: Entity.method_993 method_904 call not found.`);
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; RangedOverride visual reset is missing.`);
  }

  const insertAt = method904Call.offset + method904Call.size;
  const resetCall = buildResetEntTypeCall(abc);
  const branchPatchedCode = patchBranchesForInsertion(code, instructions, insertAt, resetCall.length);
  const patchedCode = Buffer.concat([
    branchPatchedCode.subarray(0, insertAt),
    resetCall,
    branchPatchedCode.subarray(insertAt),
  ]);

  const [maxStack] = readU30(ctx.body, methodBody.maxStackPos, "Entity.method_993.max_stack");
  const patches: BytePatch[] = [
    {
      key: "Entity.method_993.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "refresh entity visuals after RangedOverride removal",
    },
    {
      key: "Entity.method_993.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update Entity.method_993 code length",
    },
  ];
  if (maxStack < 3) {
    patches.push({
      key: "Entity.method_993.maxStack",
      start: methodBody.maxStackPos,
      end: methodBody.localCountPos,
      data: writeU30(3),
      detail: "allow ResetEntType(entType, true) stack",
    });
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);

  const verifyPass = getEntityMethod993(swfPath);
  if (!hasResetAfterMethod904(verifyPass.abc, disassemble(verifyPass.code, "Entity.method_993"))) {
    throw new PatchError(`${swfPath}: post-patch verification failed.`);
  }

  console.log(`${swfPath}: patched Entity.method_993 RangedOverride visual reset.`);
}

if (require.main === module) {
  const { swfPath, verify } = parseArgs(process.argv);
  patchSwf(swfPath, verify);
}
