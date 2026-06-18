import { strict as assert } from 'assert';
import path from 'path';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { PetConfig } from '../core/PetConfig';
import { PetHandler } from '../handlers/PetHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    userId: number;
    character: Character;
    characters: Character[];
    sentPackets: SentPacket[];
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function createCharacter(): Character {
    return {
        name: 'Neodevil',
        class: 'Paladin',
        gender: 'male',
        level: 20,
        gold: 100000,
        mammothIdols: 10,
        showHigher: false,
        pets: [
            {
                typeID: 1,
                special_id: 10,
                level: 2,
                xp: 0
            }
        ],
        trainingPet: [],
        OwnedEggsID: [1, 5],
        EggHachery: {},
        activeEggCount: 0,
        CurrentLevel: { name: 'CraftTown', x: 360, y: 1460 },
        PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 }
    };
}

function createClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = createCharacter();

    return {
        userId: 7,
        character,
        characters: [character],
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createTrainPacket(typeId: number, uniqueId: number, nextRank: number, useIdols: boolean): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod6(typeId, 7);
    bb.writeMethod9(uniqueId);
    bb.writeMethod6(nextRank, 6);
    bb.writeMethod15(useIdols);
    return bb.toBuffer();
}

function createEggHatchPacket(slotIndex: number, useIdols: boolean): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod20(4, slotIndex);
    bb.writeMethod15(useIdols);
    return bb.toBuffer();
}

async function withMockedCharacterSave<T>(fn: () => Promise<T>): Promise<T> {
    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(userId: number, character: Character): Promise<Character[]> {
        assert.equal(userId, 7);
        return [character];
    };

    try {
        return await fn();
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
    }
}

async function testPetTrainingWithGoldCompletesImmediately(): Promise<void> {
    const client = createClient();

    await withMockedCharacterSave(async () => {
        await PetHandler.handleTrainPet(client as never, createTrainPacket(1, 10, 3, false));
    });

    assert.equal(client.character.gold, 96000, 'training with gold should deduct the gold cost');
    assert.ok(client.sentPackets.some((packet) => packet.id === 0xB4), 'training with gold should refresh the gold UI');
    assert.equal(client.character.pets?.[0]?.level, 3, 'training with gold should level the pet immediately');
    assert.deepEqual(client.character.trainingPet, [], 'instant training should not leave a pending pet');

    const completionPacket = client.sentPackets.find((packet) => packet.id === 0xEE);
    assert.ok(completionPacket, 'instant training should notify the client that pet training completed');
    const completionReader = new BitReader(completionPacket!.payload);
    assert.equal(completionReader.readMethod6(7), 1, 'completion packet should identify the trained pet type');

    await withMockedCharacterSave(async () => {
        await PetHandler.handlePetTrainingCollect(client as never, Buffer.alloc(0));
    });

    assert.equal(client.character.pets?.[0]?.level, 3, 'a delayed collect packet must not level the pet twice');
}

async function testEggHatchCannotBeCollectedBeforeReadyTimeAndRefreshesIdols(): Promise<void> {
    const client = createClient();
    const expectedEggPets = new Set(
        PetConfig.getHatchablePetsForEgg(5).map((pet) => Number(pet?.PetID ?? 0))
    );

    await withMockedCharacterSave(async () => {
        await PetHandler.handleEggHatch(client as never, createEggHatchPacket(1, true));
    });

    assert.equal(client.character.mammothIdols, 7, 'starting hatch with idols should deduct the idol cost');

    const idolUpdatePacket = client.sentPackets.find((packet) => packet.id === 0xA1);
    assert.ok(idolUpdatePacket, 'pet idol spending should refresh the idol UI');
    const idolReader = new BitReader(idolUpdatePacket!.payload);
    assert.equal(idolReader.readMethod4(), 7, 'idol refresh packet should contain the updated idol total');

    const initialPetCount = client.character.pets?.length ?? 0;

    await withMockedCharacterSave(async () => {
        await PetHandler.handleCollectHatchedEgg(client as never, Buffer.alloc(0));
    });

    assert.equal(client.character.pets?.length ?? 0, initialPetCount, 'egg should not hatch before ready time');
    assert.equal(Number(client.character.EggHachery?.EggID ?? 0), 5, 'egg hatchery should remain active before ready');
    assert.deepEqual(client.character.OwnedEggsID, [1, 5], 'owned eggs should remain unchanged before ready');

    client.character.EggHachery = {
        EggID: 5,
        ReadyTime: Math.floor(Date.now() / 1000) - 1,
        slotIndex: 1
    };

    await withMockedCharacterSave(async () => {
        await PetHandler.handleCollectHatchedEgg(client as never, Buffer.alloc(0));
    });

    assert.equal(client.character.pets?.length ?? 0, initialPetCount + 1, 'ready egg should grant a new pet');
    assert.equal(
        expectedEggPets.has(Number(client.character.pets?.[initialPetCount]?.typeID ?? 0)),
        true,
        'ready egg should hatch into a valid pet for the egg type'
    );
    assert.deepEqual(client.character.OwnedEggsID, [1], 'hatched egg should be removed from owned eggs');
    assert.equal(Number(client.character.EggHachery?.EggID ?? 0), 0, 'hatchery should reset after collection');
}

async function testRankTwoEggHatchCapsAtSevenDays(): Promise<void> {
    const client = createClient();
    client.character.OwnedEggsID = [21];
    const beforeStart = Math.floor(Date.now() / 1000);

    await withMockedCharacterSave(async () => {
        await PetHandler.handleEggHatch(client as never, createEggHatchPacket(0, false));
    });

    const readyTime = Number(client.character.EggHachery?.ReadyTime ?? 0);
    assert.ok(readyTime >= beforeStart + PetConfig.EGG_HATCH_MAX_TIME);
    assert.ok(
        readyTime <= Math.floor(Date.now() / 1000) + PetConfig.EGG_HATCH_MAX_TIME + 5,
        'rank two eggs should cap at seven days'
    );
}

async function testRankOneEggHatchUsesFiveDays(): Promise<void> {
    const client = createClient();
    client.character.OwnedEggsID = [5];
    const beforeStart = Math.floor(Date.now() / 1000);

    await withMockedCharacterSave(async () => {
        await PetHandler.handleEggHatch(client as never, createEggHatchPacket(0, false));
    });

    const readyTime = Number(client.character.EggHachery?.ReadyTime ?? 0);
    assert.ok(readyTime >= beforeStart + (5 * 24 * 60 * 60));
    assert.ok(
        readyTime <= Math.floor(Date.now() / 1000) + (5 * 24 * 60 * 60) + 5,
        'rank one rare eggs should hatch in five days'
    );
}

async function main(): Promise<void> {
    PetConfig.load(path.resolve(__dirname, '..', 'data'));
    await testPetTrainingWithGoldCompletesImmediately();
    await testEggHatchCannotBeCollectedBeforeReadyTimeAndRefreshesIdols();
    await testRankTwoEggHatchCapsAtSevenDays();
    await testRankOneEggHatchUsesFiveDays();
    console.log('pet_timing_idol_regression: ok');
}

void main().catch((error) => {
    console.error('pet_timing_idol_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
