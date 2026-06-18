import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import {
  classIndexByName,
  disassemble,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  u30OperandName,
  type AbcParseResult,
  type Instruction,
} from "../scripts/swfPatchUtils";

const CLASS_NAME = "a_Room_JCMission11_09";

function resolveLevelsJcPath(): string {
  const candidates = [
    path.resolve(__dirname, "../../client/content/localhost/p/cbp/LevelsJC.swf"),
    path.resolve(process.cwd(), "src", "client", "content", "localhost", "p", "cbp", "LevelsJC.swf"),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(resolved, "LevelsJC.swf not found");
  return resolved!;
}

function methodInstructions(methodName: string): { abc: AbcParseResult; instructions: Instruction[] } {
  const ctx = parseSwf(resolveLevelsJcPath());
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, CLASS_NAME);
  assert.notEqual(classIndex, null, `${CLASS_NAME} class not found`);

  const methodIndex = methodIdxForTrait(abc.instances[classIndex!].traits, abc, methodName);
  assert.notEqual(methodIndex, null, `${CLASS_NAME}.${methodName} not found`);

  const methodBody = abc.methodBodies.get(methodIndex!);
  assert.ok(methodBody, `${CLASS_NAME}.${methodName} body not found`);

  const code = ctx.body.subarray(methodBody!.codeStart, methodBody!.codeStart + methodBody!.codeLen);
  return {
    abc,
    instructions: disassemble(code, `${CLASS_NAME}.${methodName}`),
  };
}

function multiname(instruction: Instruction, abc: AbcParseResult): string {
  return u30OperandName(instruction, abc.multinameNames) || "";
}

function pushStrings(abc: AbcParseResult, instructions: Instruction[]): string[] {
  return instructions
    .filter((instruction) => instruction.opcode === 0x2c)
    .map((instruction) => abc.stringValues[instruction.operands[0]?.[1]] || "");
}

function callArgCount(instruction: Instruction): number | null {
  return instruction.operands[1]?.[1] ?? null;
}

function testBossIntroGateStartsCombatPhase(): void {
  const gate = methodInstructions("UpdateBossIntroGate");
  let startsCombatPhase = false;
  let clearsCombatPhase = false;

  for (let index = 0; index <= gate.instructions.length - 4; index += 1) {
    const [getHook, getThis, getCombatPhase, callSetPhase] = gate.instructions.slice(index, index + 4);
    if (
      getHook.opcode === 0xd1 &&
      getThis.opcode === 0xd0 &&
      getCombatPhase.opcode === 0x66 &&
      multiname(getCombatPhase, gate.abc) === "UpdateBossFight" &&
      callSetPhase.opcode === 0x4f &&
      multiname(callSetPhase, gate.abc) === "SetPhase" &&
      callArgCount(callSetPhase) === 1
    ) {
      startsCombatPhase = true;
    }
  }

  for (let index = 0; index <= gate.instructions.length - 3; index += 1) {
    const [getHook, pushNull, callSetPhase] = gate.instructions.slice(index, index + 3);
    if (
      getHook.opcode === 0xd1 &&
      pushNull.opcode === 0x20 &&
      callSetPhase.opcode === 0x4f &&
      multiname(callSetPhase, gate.abc) === "SetPhase" &&
      callArgCount(callSetPhase) === 1
    ) {
      clearsCombatPhase = true;
    }
  }

  assert.equal(startsCombatPhase, true, "Davan intro gate should start UpdateBossFight after releasing the boss");
  assert.equal(clearsCombatPhase, false, "Davan intro gate should not clear the active phase after release");
}

function testBossFightStillSummonsAndRages(): void {
  const combat = methodInstructions("UpdateBossFight");
  const combatStrings = pushStrings(combat.abc, combat.instructions);
  assert.equal(
    combatStrings.filter((value) => value === "BrigandRatSummon").length,
    2,
    "Davan combat phase should keep both rat summon casts",
  );
  assert.equal(
    combatStrings.filter((value) => value === "OasisTeleportEffect").length,
    2,
    "Davan combat phase should keep the summon teleport effects",
  );
  assert.equal(
    combat.instructions.some((instruction) => instruction.opcode === 0x66 && multiname(instruction, combat.abc) === "UpdateGetBuffed"),
    true,
    "Davan combat phase should transition into the rage buff phase",
  );

  const rage = methodInstructions("UpdateGetBuffed");
  const rageStrings = pushStrings(rage.abc, rage.instructions);
  assert.equal(rageStrings.includes("BoostEffect"), true, "Davan rage phase should keep the boost effect");
  assert.equal(rageStrings.includes("DammeBuff"), true, "Davan rage phase should keep the damage/speed buff");
  assert.equal(
    rage.instructions.some((instruction) => instruction.opcode === 0x4f && multiname(instruction, rage.abc) === "Aggro"),
    true,
    "Davan rage phase should re-aggro after applying the buff",
  );
}

testBossIntroGateStartsCombatPhase();
testBossFightStillSummonsAndRages();
console.log("ring_of_fire_davan_phase_regression passed");
