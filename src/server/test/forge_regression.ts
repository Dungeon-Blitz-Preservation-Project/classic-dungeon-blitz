import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { ForgeHandler } from '../handlers/ForgeHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { CharmID } from '../data/runtime/Charms';
import { ConsumableID } from '../data/runtime/Consumables';
import { MaterialID } from '../data/runtime/Materials';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    userId: number;
    character: Character;
    characters: Character[];
    sentPackets: SentPacket[];
    socket: { destroyed: boolean };
    authenticated: boolean;
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function createCharacter(): Character {
    return {
        name: 'Smith',
        class: 'Paladin',
        gender: 'male',
        level: 10,
        mammothIdols: 20,
        craftXP: 10,
        craftTalentPoints: [4, 2, 0, 0, 2],
        materials: [
            { materialID: MaterialID.TrogGoblinM, count: 5 },
            { materialID: MaterialID.InfernalAbominationR, count: 2 }
        ],
        consumables: [
            { consumableID: ConsumableID.MinorRareCatalyst, count: 2 },
            { consumableID: ConsumableID.ForgeXP, count: 1 }
        ],
        charms: [],
        magicForge: {
            stats_by_building: {
                '2': 5
            },
            primary: 0,
            secondary: 0,
            secondary_tier: 0,
            usedlist: 0,
            ReadyTime: 0,
            forge_roll_a: 0,
            forge_roll_b: 0,
            is_extended_forge: false
        }
    };
}

function createClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = createCharacter();

    return {
        userId: 6,
        character,
        characters: [character],
        sentPackets,
        socket: { destroyed: false },
        authenticated: true,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createStartForgePacket(
    primaryCharmId: number,
    materials: Array<{ materialId: number; count: number }>,
    catalystFlags: boolean[]
): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod20(7, primaryCharmId);

    for (const material of materials) {
        bb.writeMethod15(true);
        bb.writeMethod20(7, material.materialId);
        bb.writeMethod20(7, material.count);
    }

    bb.writeMethod15(false);
    for (let index = 0; index < 4; index += 1) {
        bb.writeMethod15(Boolean(catalystFlags[index]));
    }

    return bb.toBuffer();
}

function createForgeSpeedupPacket(idolCost: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(idolCost);
    return bb.toBuffer();
}

function createUseConsumablePacket(consumableId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod20(5, consumableId);
    return bb.toBuffer();
}

function createCraftTalentPointsPacket(points: number[]): Buffer {
    const bb = new BitBuffer(false);
    let packedPoints = 0;
    for (let index = 0; index < 5; index += 1) {
        packedPoints |= (Number(points[index] ?? 0) & 0xF) << (index * 4);
    }
    bb.writeMethod9(packedPoints);
    return bb.toBuffer();
}

function createForgeRerollPacket(usedlist: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod20(9, usedlist);
    return bb.toBuffer();
}

function readMethod91(br: BitReader): number {
    const prefix = br.readMethod20(3);
    return br.readMethod20((prefix + 1) * 2);
}

function decodeForgeResultPacket(payload: Buffer): {
    primary: number;
    rollA: number;
    rollB: number;
    tier: number;
    secondary: number;
    usedlist: number;
} {
    const br = new BitReader(payload);
    const primary = br.readMethod6(7);
    const rollA = readMethod91(br);
    const rollB = readMethod91(br);
    const tier = br.readMethod6(2);
    const secondary = tier > 0 ? br.readMethod6(5) : 0;
    const usedlist = tier > 0 ? br.readMethod6(9) : 0;

    return {
        primary,
        rollA,
        rollB,
        tier,
        secondary,
        usedlist
    };
}

function decodeConsumableUpdatePacket(payload: Buffer): { consumableId: number; count: number } {
    const br = new BitReader(payload);
    return {
        consumableId: br.readMethod6(5),
        count: br.readMethod4()
    };
}

async function withMockedCharacterSave<T>(fn: () => Promise<T>): Promise<T> {
    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(userId: number, character: Character): Promise<Character[]> {
        assert.equal(userId, 6);
        return [character];
    };

    try {
        return await fn();
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
    }
}

async function withPatchedRandom<T>(values: number[], fn: () => Promise<T>): Promise<T> {
    const originalRandom = Math.random;
    let index = 0;

    Math.random = () => {
        const value = values[index] ?? values[values.length - 1] ?? 0;
        index += 1;
        return value;
    };

    try {
        return await fn();
    } finally {
        Math.random = originalRandom;
    }
}

async function withMockedDateNow<T>(nowMs: number, fn: (setNowMs: (nextNowMs: number) => void) => Promise<T>): Promise<T> {
    const originalNow = Date.now;
    let currentNowMs = nowMs;

    Date.now = () => currentNowMs;

    try {
        return await fn((nextNowMs: number) => {
            currentNowMs = nextNowMs;
        });
    } finally {
        Date.now = originalNow;
    }
}

async function withCapturedTimers<T>(fn: (callbacks: Array<() => void>, delays: number[]) => Promise<T>): Promise<T> {
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];

    (global as any).setTimeout = (callback: () => void, delay?: number) => {
        callbacks.push(callback);
        delays.push(Number(delay ?? 0));
        return {
            unref(): void {
                return;
            }
        };
    };
    (global as any).clearTimeout = () => {
        return;
    };

    try {
        return await fn(callbacks, delays);
    } finally {
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
}

async function testStartForgeConsumesInputsAndQueuesState(): Promise<void> {
    const client = createClient();
    const now = Math.floor(Date.now() / 1000);
    const packet = createStartForgePacket(
        CharmID.Trog01,
        [
            { materialId: MaterialID.TrogGoblinM, count: 2 },
            { materialId: MaterialID.InfernalAbominationR, count: 1 }
        ],
        [true, false, false, false]
    );

    await withMockedCharacterSave(async () =>
        withPatchedRandom([0, 0.99, 0], async () => {
            await ForgeHandler.handleStartForge(client as never, packet);
        })
    );

    assert.equal(client.character.materials?.find((entry: any) => entry.materialID === MaterialID.TrogGoblinM)?.count, 3);
    assert.equal(client.character.materials?.find((entry: any) => entry.materialID === MaterialID.InfernalAbominationR)?.count, 1);
    assert.equal(client.character.consumables?.find((entry: any) => entry.consumableID === ConsumableID.MinorRareCatalyst)?.count, 1);
    assert.equal(client.character.magicForge?.primary, CharmID.Trog01);
    assert.equal(client.character.magicForge?.secondary, 2, 'Trog charms should exclude Trog secondary and pick the first eligible reroll with deterministic RNG');
    assert.equal(client.character.magicForge?.secondary_tier, 1);
    assert.equal(client.character.magicForge?.usedlist, 1 << 1);
    assert.equal(client.character.magicForge?.is_extended_forge, false);
    assert.ok(Number(client.character.magicForge?.ReadyTime ?? 0) > now);
    assert.equal(client.sentPackets.some((packetData) => packetData.id === 0x10C), true, 'starting a forge should refresh catalyst counts');
}

async function testStartForgePrunesZeroCountMaterials(): Promise<void> {
    const client = createClient();
    client.character.materials = [
        { materialID: MaterialID.TrogGoblinM, count: 2 },
        { materialID: MaterialID.InfernalAbominationR, count: 0 },
        { materialID: MaterialID.TrogGoblinM, count: 1 }
    ];

    const packet = createStartForgePacket(
        CharmID.Trog01,
        [
            { materialId: MaterialID.TrogGoblinM, count: 3 },
            { materialId: MaterialID.InfernalAbominationR, count: 1 }
        ],
        [false, false, false, false]
    );

    await withMockedCharacterSave(async () =>
        withPatchedRandom([1], async () => {
            await ForgeHandler.handleStartForge(client as never, packet);
        })
    );

    assert.deepEqual(client.character.materials, [], 'spent or already-empty material stacks should not remain in inventory');
}

async function testForgeSpeedupCompletesImmediatelyAndSendsResultPacket(): Promise<void> {
    const client = createClient();
    client.character.magicForge = {
        stats_by_building: { '2': 5 },
        primary: CharmID.Trog01,
        secondary: 2,
        secondary_tier: 2,
        usedlist: 1 << 1,
        ReadyTime: Math.floor(Date.now() / 1000) + 300,
        forge_roll_a: 0,
        forge_roll_b: 0,
        is_extended_forge: false
    };

    await withMockedCharacterSave(async () =>
        withPatchedRandom([0.25, 0.5], async () => {
            await ForgeHandler.handleForgeSpeedUpPacket(client as never, createForgeSpeedupPacket(3));
        })
    );

    assert.equal(client.character.mammothIdols, 17);
    assert.equal(client.character.magicForge?.ReadyTime, 0);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xB5), true);

    const resultPacket = client.sentPackets.find((packet) => packet.id === 0xCD);
    assert.ok(resultPacket, 'forge speedup should emit the completion packet');

    const decoded = decodeForgeResultPacket(resultPacket!.payload);
    assert.equal(decoded.primary, CharmID.Trog01);
    assert.equal(decoded.tier, 2);
    assert.equal(decoded.secondary, 2);
    assert.equal(decoded.usedlist, 1 << 1);
    assert.equal(decoded.rollA, Number(client.character.magicForge?.forge_roll_a ?? 0));
    assert.equal(decoded.rollB, Number(client.character.magicForge?.forge_roll_b ?? 0));
}

async function testForgeSpeedupRejectsZeroCostBeforeReady(): Promise<void> {
    const client = createClient();
    client.character.magicForge = {
        stats_by_building: { '2': 5 },
        primary: CharmID.Trog01,
        secondary: 2,
        secondary_tier: 2,
        usedlist: 1 << 1,
        ReadyTime: Math.floor(Date.now() / 1000) + 300,
        forge_roll_a: 0,
        forge_roll_b: 0,
        is_extended_forge: false
    };

    await withMockedCharacterSave(async () => {
        await ForgeHandler.handleForgeSpeedUpPacket(client as never, createForgeSpeedupPacket(0));
    });

    assert.equal(client.character.mammothIdols, 20);
    assert.notEqual(client.character.magicForge?.ReadyTime, 0);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xCD), false, 'free speedup should not complete a still-running forge');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xB5), false, 'free speedup should not emit an idol purchase');
}

async function testForgeSpeedupZeroCostAfterReadySendsCompletedResult(): Promise<void> {
    const client = createClient();
    client.character.magicForge = {
        stats_by_building: { '2': 5 },
        primary: CharmID.Trog01,
        secondary: 2,
        secondary_tier: 2,
        usedlist: 1 << 1,
        ReadyTime: Math.floor(Date.now() / 1000) - 1,
        forge_roll_a: 0,
        forge_roll_b: 0,
        is_extended_forge: false
    };

    await withMockedCharacterSave(async () =>
        withPatchedRandom([0.25, 0.5], async () => {
            await ForgeHandler.handleForgeSpeedUpPacket(client as never, createForgeSpeedupPacket(0));
        })
    );

    assert.equal(client.character.mammothIdols, 20);
    assert.equal(client.character.magicForge?.ReadyTime, 0);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xB5), false);
    assert.ok(client.sentPackets.find((packet) => packet.id === 0xCD), 'expired zero-cost speedup should only push the ready forge result');
}

async function testCollectForgeCharmAwardsCharmAndCraftXp(): Promise<void> {
    const client = createClient();
    client.character.magicForge = {
        stats_by_building: { '2': 5 },
        primary: CharmID.Trog01,
        secondary: 2,
        secondary_tier: 1,
        usedlist: 1 << 1,
        ReadyTime: 0,
        forge_roll_a: 10,
        forge_roll_b: 20,
        is_extended_forge: false
    };

    await withMockedCharacterSave(async () => {
        await ForgeHandler.handleCollectForgeCharm(client as never, Buffer.alloc(0));
    });

    const expectedCharmId = (CharmID.Trog01 & 0x1FF) | ((2 & 0x1F) << 9) | ((1 & 0x3) << 14);
    assert.deepEqual(client.character.charms, [{ charmID: expectedCharmId, count: 1 }]);
    assert.equal(client.character.craftXP, 19, 'size-1 charms should award 8 base xp with the Coals bonus applied');
    assert.equal(client.character.magicForge?.primary, 0);
    assert.equal(client.character.magicForge?.secondary, 0);
    assert.equal(client.character.magicForge?.secondary_tier, 0);
}

async function testForgeRerollPreservesTierAndUpdatesUsedlist(): Promise<void> {
    const client = createClient();
    client.character.magicForge = {
        stats_by_building: { '2': 5 },
        primary: CharmID.Trog01,
        secondary: 2,
        secondary_tier: 2,
        usedlist: 1 << 1,
        ReadyTime: 0,
        forge_roll_a: 123,
        forge_roll_b: 456,
        is_extended_forge: false
    };

    await withMockedCharacterSave(async () =>
        withPatchedRandom([0], async () => {
            await ForgeHandler.handleMagicForgeReroll(client as never, createForgeRerollPacket(0));
        })
    );

    assert.equal(client.character.mammothIdols, 15);
    assert.equal(client.character.magicForge?.secondary, 3);
    assert.equal(client.character.magicForge?.secondary_tier, 2);
    assert.equal(client.character.magicForge?.usedlist, (1 << 1) | (1 << 2));

    const resultPacket = client.sentPackets.find((packet) => packet.id === 0xCD);
    assert.ok(resultPacket, 'reroll should emit the result packet');

    const decoded = decodeForgeResultPacket(resultPacket!.payload);
    assert.equal(decoded.primary, CharmID.Trog01);
    assert.equal(decoded.secondary, 3);
    assert.equal(decoded.tier, 2);
    assert.equal(decoded.usedlist, (1 << 1) | (1 << 2));
    assert.equal(decoded.rollA, 123);
    assert.equal(decoded.rollB, 456);
}

async function testForgeXpConsumableAppliesCapAndRefreshesInventory(): Promise<void> {
    const client = createClient();
    client.character.craftXP = 158000;

    await withMockedCharacterSave(async () => {
        await ForgeHandler.handleUseForgeConsumable(client as never, createUseConsumablePacket(ConsumableID.ForgeXP));
    });

    assert.equal(client.character.craftXP, 159948);
    assert.equal(client.character.consumables?.find((entry: any) => entry.consumableID === ConsumableID.ForgeXP)?.count, 0);

    const updatePacket = client.sentPackets.find((packet) => packet.id === 0x10C);
    assert.ok(updatePacket, 'forge xp use should refresh the consumable count');
    assert.deepEqual(decodeConsumableUpdatePacket(updatePacket!.payload), {
        consumableId: ConsumableID.ForgeXP,
        count: 0
    });
}

async function testArtisanSkillAllocationUnpacksPackedNibbles(): Promise<void> {
    const client = createClient();

    await withMockedCharacterSave(async () => {
        await ForgeHandler.handleAllocateMagicForgeArtisanSkillPoints(
            client as never,
            createCraftTalentPointsPacket([1, 2, 3, 4, 5])
        );
    });

    assert.deepEqual(client.character.craftTalentPoints, [1, 2, 3, 4, 5]);
}

async function testSyncCompletionStateFinalizesExpiredForgeRolls(): Promise<void> {
    const client = createClient();
    client.character.magicForge = {
        stats_by_building: { '2': 5 },
        primary: CharmID.Trog01,
        secondary: 2,
        secondary_tier: 2,
        usedlist: 1 << 1,
        ReadyTime: Math.floor(Date.now() / 1000) - 1,
        forge_roll_a: 0,
        forge_roll_b: 0,
        is_extended_forge: false
    };

    await withMockedCharacterSave(async () =>
        withPatchedRandom([0.1, 0.2], async () => {
            await ForgeHandler.syncCompletionState(client as never);
        })
    );

    assert.equal(client.character.magicForge?.ReadyTime, 0);
    assert.ok(Number(client.character.magicForge?.forge_roll_a ?? 0) > 0);
    assert.ok(Number(client.character.magicForge?.forge_roll_b ?? 0) > 0);
    assert.equal(client.sentPackets.length, 0, 'offline completion sync should not emit live forge packets');
}

async function testScheduledForgeCompletionRearmsWhenTimerFiresBeforeReadySecond(): Promise<void> {
    const client = createClient();
    client.character.magicForge = {
        stats_by_building: { '2': 5 },
        primary: CharmID.Trog01,
        secondary: 2,
        secondary_tier: 2,
        usedlist: 1 << 1,
        ReadyTime: 1001,
        forge_roll_a: 0,
        forge_roll_b: 0,
        is_extended_forge: false
    };

    await withMockedDateNow(1_000_999, async (setNowMs) =>
        withCapturedTimers(async (callbacks, delays) =>
            withMockedCharacterSave(async () =>
                withPatchedRandom([0.1, 0.2], async () => {
                    await ForgeHandler.syncCompletionState(client as never);
                    assert.equal(callbacks.length, 1);
                    assert.ok(delays[0] < 10, 'initial timer can land before the ReadyTime second boundary');

                    callbacks[0]!();
                    await new Promise((resolve) => setImmediate(resolve));

                    assert.equal(client.character.magicForge?.ReadyTime, 1001);
                    assert.equal(client.sentPackets.some((packet) => packet.id === 0xCD), false);
                    assert.equal(callbacks.length, 2, 'early completion callback should re-arm instead of abandoning the forge');

                    setNowMs(1_001_000);
                    callbacks[1]!();
                    await new Promise((resolve) => setImmediate(resolve));

                    assert.equal(client.character.magicForge?.ReadyTime, 0);
                    assert.ok(client.sentPackets.find((packet) => packet.id === 0xCD), 're-armed timer should finish and notify the client');
                })
            )
        )
    );
}

async function main(): Promise<void> {
    await testStartForgeConsumesInputsAndQueuesState();
    await testStartForgePrunesZeroCountMaterials();
    await testForgeSpeedupCompletesImmediatelyAndSendsResultPacket();
    await testForgeSpeedupRejectsZeroCostBeforeReady();
    await testForgeSpeedupZeroCostAfterReadySendsCompletedResult();
    await testCollectForgeCharmAwardsCharmAndCraftXp();
    await testForgeRerollPreservesTierAndUpdatesUsedlist();
    await testForgeXpConsumableAppliesCapAndRefreshesInventory();
    await testArtisanSkillAllocationUnpacksPackedNibbles();
    await testSyncCompletionStateFinalizesExpiredForgeRolls();
    await testScheduledForgeCompletionRearmsWhenTimerFiresBeforeReadySecond();
    console.log('forge_regression: ok');
}

void main().catch((error) => {
    console.error('forge_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
