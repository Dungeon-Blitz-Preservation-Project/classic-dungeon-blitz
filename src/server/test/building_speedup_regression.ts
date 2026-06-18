import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { BuildingID } from '../core/Enums';
import { BuildingHandler } from '../handlers/BuildingHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    userId: number;
    character: Character;
    craftTownHostCharacter: Character | null;
    characters: Character[];
    currentLevel: string;
    playerSpawned: boolean;
    sentPackets: SentPacket[];
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

const EXPECTED_CRAFT_TOWN_REASSERT_DELTA_COUNT = 7;

function createCharacter(): Character {
    return {
        name: 'Neodevil',
        class: 'Paladin',
        gender: 'male',
        level: 10,
        MasterClass: 4,
        gold: 100000,
        mammothIdols: 12,
        magicForge: {
            stats_by_building: {
                '1': 0,
                '2': 5,
                '3': 2,
                '12': 0,
                '13': 4
            }
        },
        buildingUpgrade: {
            buildingID: 1,
            rank: 1,
            ReadyTime: Math.floor(Date.now() / 1000) + 60
        },
        CurrentLevel: { name: 'CraftTown', x: 360, y: 1460 },
        PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 }
    };
}

function createClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = createCharacter();

    return {
        userId: 6,
        character,
        craftTownHostCharacter: null,
        characters: [character],
        currentLevel: 'CraftTown',
        playerSpawned: true,
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createSpeedupPacket(idolCost: number): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod9(idolCost);
    return bb.toBuffer();
}

function createUpgradePacket(buildingId: number, targetRank: number, usedIdols: boolean): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod20(5, buildingId);
    bb.writeMethod20(5, targetRank);
    bb.writeMethod15(usedIdols);
    return bb.toBuffer();
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

async function testBuildingSpeedupCompletesUpgradeAndReassertsCraftTownState(): Promise<void> {
    const client = createClient();

    await withMockedCharacterSave(async () => {
        await BuildingHandler.handleBuildingSpeedUpRequest(client as never, createSpeedupPacket(3));
    });

    assert.equal(client.character.mammothIdols, 9);
    assert.equal(client.character.magicForge?.stats_by_building?.['1'], 1);
    assert.deepEqual(client.character.buildingUpgrade, { buildingID: 0, rank: 0, ReadyTime: 0 });
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xB5), true, 'speedup should refresh idol UI');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xD8), true, 'speedup should complete the upgrade');
    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0xDA).length,
        EXPECTED_CRAFT_TOWN_REASSERT_DELTA_COUNT,
        'speedup should immediately reassert CraftTown building state'
    );
}

async function testOfflineExpiredBuildingUpgradeAppliesOnSync(): Promise<void> {
    const client = createClient();
    client.character.buildingUpgrade = {
        buildingID: 1,
        rank: 2,
        ReadyTime: Math.floor(Date.now() / 1000) - 30
    };

    await withMockedCharacterSave(async () => {
        await BuildingHandler.syncCompletionState(client as never);
    });

    assert.equal(client.character.magicForge?.stats_by_building?.['1'], 2);
    assert.deepEqual(client.character.buildingUpgrade, { buildingID: 0, rank: 0, ReadyTime: 0 });
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0xD8),
        true,
        'offline completed building upgrade should send a completion packet when the player is in CraftTown'
    );
    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0xDA).length,
        EXPECTED_CRAFT_TOWN_REASSERT_DELTA_COUNT,
        'offline completed building upgrade should reassert CraftTown building state without scaffolding'
    );
    const tomePacket = client.sentPackets
        .filter((packet) => packet.id === 0xDA)
        .map((packet) => decodeBuildingDelta(packet.payload))
        .find((packet) => packet.targetBuildingId === 1);
    assert.equal(tomePacket?.targetRank, 2);
    assert.equal(tomePacket?.scaffoldingId, 0);
}

async function testStormgazeRefugeRankFiveUpgradePersistsAfterRelog(): Promise<void> {
    const client = createClient();
    client.character.class = 'Paladin';
    client.character.MasterClass = 5;
    client.character.magicForge = {
        stats_by_building: {
            '1': 1,
            '2': 5,
            '3': 1,
            '4': 4,
            '5': 1,
            '12': 0,
            '13': 4
        }
    };
    client.character.buildingUpgrade = {
        buildingID: BuildingID.SentinelTower,
        rank: 5,
        ReadyTime: Math.floor(Date.now() / 1000) - 30
    };

    await withMockedCharacterSave(async () => {
        await BuildingHandler.syncCompletionState(client as never);
    });

    assert.equal(
        client.character.magicForge?.stats_by_building?.[String(BuildingID.SentinelTower)],
        5,
        'expired Stormgaze Refuge upgrade should be committed to the saved building rank on relog'
    );
    assert.deepEqual(client.character.buildingUpgrade, { buildingID: 0, rank: 0, ReadyTime: 0 });

    const completePacket = client.sentPackets.find((packet) => packet.id === 0xD8);
    assert.ok(completePacket, 'Stormgaze Refuge completion should be replayed after relog');
    if (completePacket) {
        const br = new BitReader(completePacket.payload);
        assert.equal(br.readMethod20(5), BuildingID.SentinelTower);
        assert.equal(br.readMethod20(5), 5);
    }

    const stormgazePacket = client.sentPackets
        .filter((packet) => packet.id === 0xDA)
        .map((packet) => decodeBuildingDelta(packet.payload))
        .find((packet) => packet.targetBuildingId === BuildingID.SentinelTower);

    assert.equal(stormgazePacket?.targetRank, 5, 'CraftTown refresh should reassert Stormgaze Refuge rank 5');
    assert.equal(stormgazePacket?.scaffoldingId, 0, 'completed Stormgaze Refuge upgrade should not keep scaffolding active');
}

async function testDuplicateBuiltTomeUpgradeRequestIsIgnoredAndReassertsHomeState(): Promise<void> {
    const client = createClient();
    client.character.magicForge = {
        stats_by_building: {
            '1': 1,
            '2': 5,
            '3': 2,
            '12': 0,
            '13': 4
        }
    };
    client.character.buildingUpgrade = { buildingID: 0, rank: 0, ReadyTime: 0 };

    await withMockedCharacterSave(async () => {
        await BuildingHandler.handleBuildingUpgrade(client as never, createUpgradePacket(1, 1, false));
    });

    assert.deepEqual(client.character.buildingUpgrade, { buildingID: 0, rank: 0, ReadyTime: 0 });
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0xD8),
        true,
        'duplicate built Tome request should emit a completion packet so stale client UI can close'
    );
    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0xDA).length,
        EXPECTED_CRAFT_TOWN_REASSERT_DELTA_COUNT,
        'duplicate built Tome request should reassert existing CraftTown building state'
    );
}

async function testBuildingUpgradePersistsGoldPurchaseAndRealReadyTime(): Promise<void> {
    const client = createClient();
    const beforeStart = Math.floor(Date.now() / 1000);
    client.character.gold = 10000;
    client.character.magicForge = {
        stats_by_building: {
            '1': 1,
            '2': 5,
            '3': 2,
            '12': 0,
            '13': 4
        }
    };
    client.character.buildingUpgrade = { buildingID: 0, rank: 0, ReadyTime: 0 };

    await withMockedCharacterSave(async () => {
        await BuildingHandler.handleBuildingUpgrade(client as never, createUpgradePacket(1, 2, false));
    });

    assert.equal(client.character.gold, 4128, 'building upgrade should persist the gold purchase');
    assert.deepEqual(
        {
            buildingID: client.character.buildingUpgrade?.buildingID,
            rank: client.character.buildingUpgrade?.rank
        },
        { buildingID: 1, rank: 2 }
    );
    assert.ok(
        Number(client.character.buildingUpgrade?.ReadyTime ?? 0) >= beforeStart + (4 * 60 * 60),
        'building upgrade should persist the real BuildingTypes upgrade timer'
    );
}

async function testBuildingUpgradePersistsIdolPurchase(): Promise<void> {
    const client = createClient();
    client.character.gold = 0;
    client.character.mammothIdols = 12;
    client.character.magicForge = {
        stats_by_building: {
            '1': 1,
            '2': 5,
            '3': 2,
            '12': 0,
            '13': 4
        }
    };
    client.character.buildingUpgrade = { buildingID: 0, rank: 0, ReadyTime: 0 };

    await withMockedCharacterSave(async () => {
        await BuildingHandler.handleBuildingUpgrade(client as never, createUpgradePacket(1, 2, true));
    });

    assert.equal(client.character.mammothIdols, 9, 'building upgrade should persist the idol purchase');
    assert.equal(client.character.buildingUpgrade?.buildingID, 1);
    assert.equal(client.character.buildingUpgrade?.rank, 2);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xB5), true, 'idol upgrade should refresh premium UI');
}

async function testBuildingCancelClearsSavedProgressAndReassertsHomeState(): Promise<void> {
    const client = createClient();

    await withMockedCharacterSave(async () => {
        await BuildingHandler.handleBuildingCancel(client as never, Buffer.alloc(0));
    });

    assert.deepEqual(client.character.buildingUpgrade, { buildingID: 0, rank: 0, ReadyTime: 0 });
    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0xDA).length,
        EXPECTED_CRAFT_TOWN_REASSERT_DELTA_COUNT,
        'cancel should immediately reassert CraftTown building state'
    );
}

async function testDuplicateSpeedupRequestReplaysCompletionForBuiltTome(): Promise<void> {
    const client = createClient();
    client.character.magicForge = {
        stats_by_building: {
            '1': 1,
            '2': 5,
            '3': 2,
            '12': 0,
            '13': 4
        }
    };
    client.character.buildingUpgrade = { buildingID: 0, rank: 0, ReadyTime: 0 };

    await withMockedCharacterSave(async () => {
        await BuildingHandler.handleBuildingSpeedUpRequest(client as never, createSpeedupPacket(0));
    });

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0xD8),
        true,
        'duplicate speedup request should replay completion for the already-built Tome'
    );
    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0xDA).length,
        EXPECTED_CRAFT_TOWN_REASSERT_DELTA_COUNT,
        'duplicate speedup request should reassert CraftTown building state'
    );
}

function testCraftTownSpawnRefreshSendsImmediateBuildingReassert(): void {
    const client = createClient();
    const observedDelays: number[] = [];
    const originalSetTimeout = global.setTimeout;

    (global as typeof globalThis & {
        setTimeout: typeof setTimeout;
    }).setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
        observedDelays.push(Number(delay ?? 0));
        return { unref() { return undefined; } } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;

    try {
        BuildingHandler.refreshCraftTownBuildingsOnSpawn(client as never);
    } finally {
        (global as typeof globalThis & {
            setTimeout: typeof setTimeout;
        }).setTimeout = originalSetTimeout;
    }

    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0xDA).length,
        EXPECTED_CRAFT_TOWN_REASSERT_DELTA_COUNT,
        'CraftTown spawn should immediately resend home building state'
    );
    assert.deepEqual(observedDelays, [1200, 2800]);
}

function decodeBuildingDelta(packet: Buffer): {
    previousBuildingId: number;
    previousRank: number;
    targetBuildingId: number;
    targetRank: number;
    scaffoldingId: number;
} {
    const br = new BitReader(packet);
    return {
        previousBuildingId: br.readMethod20(5),
        previousRank: br.readMethod20(5),
        targetBuildingId: br.readMethod20(5),
        targetRank: br.readMethod20(5),
        scaffoldingId: br.readMethod20(5)
    };
}

function testCraftTownRefreshUsesSupportedRepairedKeepArtRank(): void {
    const client = createClient();
    client.character.magicForge = {
        stats_by_building: {
            '1': 1,
            '2': 5,
            '3': 2,
            '12': 5,
            '13': 4
        }
    };

    BuildingHandler.refreshCraftTownBuildingsOnSpawn(client as never);

    const keepPacket = client.sentPackets
        .filter((packet) => packet.id === 0xDA)
        .map((packet) => decodeBuildingDelta(packet.payload))
        .find((packet) => packet.targetBuildingId === 12);

    assert.ok(keepPacket, 'CraftTown refresh should still emit a keep delta');
    assert.equal(keepPacket?.targetRank, 0, 'CraftTown refresh should use the supported repaired rank-zero art entry');
}

function testCraftTownRefreshUsesResolvedDisciplineTower(): void {
    const client = createClient();
    client.character.MasterClass = 5;
    client.character.magicForge = {
        stats_by_building: {
            '1': 1,
            '2': 5,
            '3': 2,
            '4': 0,
            '12': 0,
            '13': 4
        }
    };

    BuildingHandler.refreshCraftTownBuildingsOnSpawn(client as never);

    const towerPacket = client.sentPackets
        .filter((packet) => packet.id === 0xDA)
        .map((packet) => decodeBuildingDelta(packet.payload))
        .find((packet) => packet.targetBuildingId === 3);

    assert.ok(towerPacket, 'CraftTown refresh should emit the Justicar discipline tower for master class 5');
    assert.equal(towerPacket?.targetRank, 2);
}

function testCraftTownRefreshUsesVisitedHomeOwnerBuildingState(): void {
    const client = createClient();
    client.character.MasterClass = 5;
    client.character.magicForge = {
        stats_by_building: {
            '1': 1,
            '2': 1,
            '3': 1,
            '12': 1,
            '13': 1
        }
    };
    client.craftTownHostCharacter = {
        ...createCharacter(),
        name: 'HouseOwner',
        MasterClass: 5,
        magicForge: {
            stats_by_building: {
                '1': 1,
                '2': 5,
                '3': 4,
                '12': 0,
                '13': 4
            }
        }
    };

    BuildingHandler.refreshCraftTownBuildingsOnSpawn(client as never);

    const towerPacket = client.sentPackets
        .filter((packet) => packet.id === 0xDA)
        .map((packet) => decodeBuildingDelta(packet.payload))
        .find((packet) => packet.targetBuildingId === 3);

    assert.ok(towerPacket, 'visited CraftTown refresh should emit the home owner discipline tower');
    assert.equal(towerPacket?.targetRank, 4);
}

async function main(): Promise<void> {
    await testBuildingSpeedupCompletesUpgradeAndReassertsCraftTownState();
    await testOfflineExpiredBuildingUpgradeAppliesOnSync();
    await testStormgazeRefugeRankFiveUpgradePersistsAfterRelog();
    await testDuplicateBuiltTomeUpgradeRequestIsIgnoredAndReassertsHomeState();
    await testBuildingUpgradePersistsGoldPurchaseAndRealReadyTime();
    await testBuildingUpgradePersistsIdolPurchase();
    await testBuildingCancelClearsSavedProgressAndReassertsHomeState();
    await testDuplicateSpeedupRequestReplaysCompletionForBuiltTome();
    testCraftTownSpawnRefreshSendsImmediateBuildingReassert();
    testCraftTownRefreshUsesSupportedRepairedKeepArtRank();
    testCraftTownRefreshUsesResolvedDisciplineTower();
    testCraftTownRefreshUsesVisitedHomeOwnerBuildingState();
    console.log('building_speedup_regression: ok');
}

void main().catch((error) => {
    console.error('building_speedup_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
