import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { GlobalState } from '../core/GlobalState';
import { BuildingHandler } from '../handlers/BuildingHandler';
import { CharacterHandler } from '../handlers/CharacterHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { getClientLevelScope } from '../core/LevelScope';
import { getCraftTownHomeInstanceId, isVisitingAnotherPlayersCraftTown } from '../utils/HomeVisitGuard';
import { WorldEnter } from '../utils/WorldEnter';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    userId: number;
    token: number;
    character: Character;
    craftTownHostCharacter: Character | null;
    characters: Character[];
    currentLevel: string;
    levelInstanceId: string;
    playerSpawned: boolean;
    clientEntID: number;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    sendBitBuffer(id: number, bb: BitBuffer): void;
    send(id: number, payload: Buffer): void;
};

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function createCharacter(name: string = 'Visitor'): Character {
    return {
        name,
        class: 'Mage',
        gender: 'male',
        level: 10,
        MasterClass: 5,
        gold: 100000,
        mammothIdols: 25,
        headSet: 'HeadA',
        hairSet: 'HairA',
        mouthSet: 'MouthA',
        faceSet: 'FaceA',
        hairColor: 111,
        skinColor: 222,
        shirtColor: 333,
        pantColor: 444,
        activeAbilities: [10, 14, 31],
        learnedAbilities: [
            { abilityID: 10, rank: 1 },
            { abilityID: 14, rank: 1 },
            { abilityID: 31, rank: 1 }
        ],
        SkillResearch: { abilityID: 0, rank: 0, ReadyTime: 0 },
        talentPoints: { '1': 1 },
        talentResearch: { classIndex: null, ReadyTime: 0 },
        TalentTree: {
            '5': {
                nodes: [
                    { nodeID: 1, points: 1, filled: true },
                    null,
                    null,
                    null,
                    null
                ]
            }
        },
        magicForge: {
            stats_by_building: {
                '1': 1,
                '2': 1,
                '3': 1,
                '12': 1,
                '13': 1
            },
            primary: 0,
            secondary: 0,
            secondary_tier: 0,
            usedlist: 0,
            ReadyTime: 0,
            forge_roll_a: 0,
            forge_roll_b: 0,
            is_extended_forge: false
        },
        buildingUpgrade: {
            buildingID: 1,
            rank: 2,
            ReadyTime: Math.floor(Date.now() / 1000) + 300
        },
        equippedGears: [
            { gearID: 1177, tier: 1, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] }
        ],
        inventoryGears: [
            { gearID: 1177, tier: 1, runes: [0, 0, 0], colors: [0, 0] },
            { gearID: 1188, tier: 1, runes: [0, 0, 0], colors: [0, 0] }
        ],
        gearSets: [
            { name: 'Set 1', slots: [0, 1177, 0, 0, 0, 0, 0] }
        ],
        craftTalentPoints: [0, 0, 0, 0, 0],
        CurrentLevel: { name: 'CraftTown', x: 360, y: 1460 },
        PreviousLevel: { name: 'NewbieRoad', x: 100, y: 100 }
    };
}

function createVisitedClient(): FakeClient {
    const character = createCharacter('Visitor');
    const sentPackets: SentPacket[] = [];
    return {
        userId: 6,
        token: 123,
        character,
        craftTownHostCharacter: {
            ...createCharacter('Owner'),
            class: 'Paladin',
            MasterClass: 5,
            magicForge: {
                stats_by_building: {
                    '1': 4,
                    '2': 5,
                    '3': 4,
                    '6': 3,
                    '12': 3,
                    '13': 4
                }
            },
            buildingUpgrade: {
                buildingID: 13,
                rank: 5,
                ReadyTime: Math.floor(Date.now() / 1000) + 600
            },
            inventoryGears: [
                { gearID: 1178, tier: 2, runes: [0, 0, 0], colors: [0, 0] },
                { gearID: 1180, tier: 1, runes: [0, 0, 0], colors: [0, 0] }
            ]
        },
        characters: [character],
        currentLevel: 'CraftTown',
        levelInstanceId: getCraftTownHomeInstanceId(character, createCharacter('Owner')),
        playerSpawned: true,
        clientEntID: 4001,
        entities: new Map([[4001, { id: 4001, isPlayer: true, equippedGears: character.equippedGears }]]),
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        },
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload });
        }
    };
}

function createOwnHomeClient(name: string = 'Builder'): FakeClient {
    const client = createVisitedClient();
    client.character = createCharacter(name);
    client.characters = [client.character];
    client.craftTownHostCharacter = null;
    client.levelInstanceId = getCraftTownHomeInstanceId(client.character);
    return client;
}

async function withSavesBlocked<T>(fn: () => Promise<T> | T): Promise<T> {
    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    const originalSaveCharacters = JsonAdapter.prototype.saveCharacters;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(): Promise<Character[]> {
        throw new Error('unexpected saveCharacterSnapshot during visited Home guard');
    };
    JsonAdapter.prototype.saveCharacters = async function(): Promise<void> {
        throw new Error('unexpected saveCharacters during visited Home guard');
    };

    try {
        return await fn();
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
        JsonAdapter.prototype.saveCharacters = originalSaveCharacters;
    }
}

async function withMockedCharacterSave<T>(fn: () => Promise<T> | T): Promise<T> {
    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(userId: number, character: Character): Promise<Character[]> {
        return [{ ...character, userId } as Character];
    };

    try {
        return await fn();
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
    }
}

function createBuildingUpgradePacket(): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod20(5, 2);
    bb.writeMethod20(5, 2);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function createArmoryRequestPacket(): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod9(0);
    return bb.toBuffer();
}

function decodeBuildingDelta(payload: Buffer): { targetBuildingId: number; targetRank: number } {
    const br = new BitReader(payload);
    br.readMethod6(5);
    br.readMethod6(5);
    const targetBuildingId = br.readMethod6(5);
    const targetRank = br.readMethod6(5);
    return { targetBuildingId, targetRank };
}

function decodeArmoryGears(payload: Buffer): Array<{ gearID: number; tier: number }> {
    const br = new BitReader(payload);
    const count = br.readMethod4();
    const gears: Array<{ gearID: number; tier: number }> = [];

    for (let index = 0; index < count; index += 1) {
        gears.push({
            gearID: br.readMethod6(11),
            tier: br.readMethod6(2)
        });
    }

    return gears;
}

function readFlag(br: BitReader): boolean {
    return br.readMethod20(1) === 1;
}

function readMethod91(br: BitReader): number {
    const prefix = br.readMethod20(3);
    return br.readMethod20((prefix + 1) * 2);
}

function decodeCraftTownOwnerToken(payload: Buffer): { transferToken: number; ownerToken: number; isCraftTown: boolean } {
    const br = new BitReader(payload);
    const transferToken = br.readMethod4();
    br.readMethod4();
    br.readMethod13();
    if (readFlag(br)) {
        br.readMethod4();
        br.readMethod4();
    }
    br.readMethod13();
    br.readMethod4();
    br.readMethod13();
    br.readMethod20(6);
    br.readMethod20(6);
    br.readMethod13();
    br.readMethod13();
    br.readMethod13();
    readFlag(br);
    if (readFlag(br)) {
        br.readMethod45();
        br.readMethod45();
    }
    const isCraftTown = readFlag(br);
    const ownerToken = isCraftTown ? br.readMethod4() : 0;
    return { transferToken, ownerToken, isCraftTown };
}

function testGuardDetectsOnlyOtherPlayersHome(): void {
    const client = createVisitedClient();
    assert.equal(isVisitingAnotherPlayersCraftTown(client as never), true);

    client.craftTownHostCharacter = { ...client.character };
    assert.equal(isVisitingAnotherPlayersCraftTown(client as never), false);

    client.craftTownHostCharacter = createCharacter('Owner');
    client.currentLevel = 'NewbieRoad';
    assert.equal(isVisitingAnotherPlayersCraftTown(client as never), false);
}

async function testBuildingMutationBlockedAndOwnerStateReasserted(): Promise<void> {
    const client = createVisitedClient();
    const beforeCharacter = clone(client.character);

    await withSavesBlocked(async () => {
        await BuildingHandler.handleBuildingUpgrade(client as never, createBuildingUpgradePacket());
    });

    assert.deepEqual(client.character, beforeCharacter, 'visited Home building upgrade should not mutate visitor save state');
    const ownerTower = client.sentPackets
        .filter((packet) => packet.id === 0xDA)
        .map((packet) => decodeBuildingDelta(packet.payload))
        .find((packet) => packet.targetBuildingId === 3);
    assert.equal(ownerTower?.targetRank, 4, 'visited Home building refresh should reassert owner tower state');
}

async function testBuildingUpgradeTimeUsesRankSchedule(): Promise<void> {
    const client = createOwnHomeClient('Builder');
    const before = Math.floor(Date.now() / 1000);

    await withMockedCharacterSave(async () => {
        await BuildingHandler.handleBuildingUpgrade(client as never, createBuildingUpgradePacket());
    });

    const readyTime = Number(client.character.buildingUpgrade?.ReadyTime ?? 0);
    assert.ok(
        readyTime >= before + (4 * 60 * 60),
        'rank 2 home building upgrade should use the configured four-hour timer'
    );
    assert.ok(
        readyTime <= Math.floor(Date.now() / 1000) + (4 * 60 * 60) + 5,
        'rank 2 home building upgrade should not exceed the configured four-hour timer'
    );
}

function testBuildingRefreshReassertsInactiveClassTowers(): void {
    const character = {
        ...createCharacter('DariusLike'),
        class: 'Paladin',
        MasterClass: 5,
        magicForge: {
            stats_by_building: {
                '1': 10,
                '2': 1,
                '3': 10,
                '4': 10,
                '5': 10,
                '12': 5,
                '13': 0
            }
        },
        buildingUpgrade: { buildingID: 0, rank: 0, ReadyTime: 0 }
    };
    const sentPackets: SentPacket[] = [];
    const client: FakeClient = {
        userId: 9,
        token: 93001,
        character,
        craftTownHostCharacter: null,
        characters: [character],
        currentLevel: 'CraftTown',
        levelInstanceId: getCraftTownHomeInstanceId(character),
        playerSpawned: true,
        clientEntID: 4001,
        entities: new Map(),
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        },
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload });
        }
    };

    BuildingHandler.sendBuildingUpdate(client as never);

    const deltas = sentPackets
        .filter((packet) => packet.id === 0xDA)
        .map((packet) => decodeBuildingDelta(packet.payload));
    const ranksByBuilding = new Map(deltas.map((delta) => [delta.targetBuildingId, delta.targetRank]));

    assert.equal(ranksByBuilding.get(3), 10, 'Justicar tower should still be reasserted as the active tower');
    assert.equal(ranksByBuilding.get(4), 10, 'Sentinel tower should be reasserted even when Justicar is active');
    assert.equal(ranksByBuilding.get(5), 10, 'Templar tower should be reasserted even when Justicar is active');

    const classTowerOrder = deltas
        .map((delta) => delta.targetBuildingId)
        .filter((buildingId) => [3, 4, 5].includes(buildingId));
    assert.deepEqual(
        classTowerOrder,
        [4, 5, 3],
        'active Justicar tower should be the final class-tower refresh so inactive tower art cannot override it'
    );
}

function testBuildingRefreshKeepsVisitedOwnerInactiveClassTowers(): void {
    const client = createVisitedClient();
    client.craftTownHostCharacter = {
        ...createCharacter('DariusOwner'),
        class: 'Paladin',
        MasterClass: 4,
        magicForge: {
            stats_by_building: {
                '1': 10,
                '2': 1,
                '3': 10,
                '4': 9,
                '5': 8,
                '12': 5,
                '13': 0
            }
        },
        buildingUpgrade: { buildingID: 0, rank: 0, ReadyTime: 0 }
    };

    BuildingHandler.sendBuildingUpdate(client as never);

    const deltas = client.sentPackets
        .filter((packet) => packet.id === 0xDA)
        .map((packet) => decodeBuildingDelta(packet.payload));
    const ranksByBuilding = new Map(deltas.map((delta) => [delta.targetBuildingId, delta.targetRank]));

    assert.equal(ranksByBuilding.get(3), 10, 'visited owner Justicar tower should be reasserted');
    assert.equal(ranksByBuilding.get(4), 9, 'visited owner Sentinel tower should be reasserted');
    assert.equal(ranksByBuilding.get(5), 8, 'visited owner Templar tower should be reasserted');

    const classTowerOrder = deltas
        .map((delta) => delta.targetBuildingId)
        .filter((buildingId) => [3, 4, 5].includes(buildingId));
    assert.deepEqual(
        classTowerOrder,
        [3, 5, 4],
        'visited owner active Sentinel tower should be the final class-tower refresh'
    );
}

function testVisitedHomeEnterWorldMarksOwnerToken(): void {
    const client = createVisitedClient();
    const packet = WorldEnter.buildEnterWorldPacket(
        client.token,
        0,
        '',
        false,
        0,
        0,
        'localhost',
        8080,
        'LevelsHome.swf',
        1,
        1,
        'CraftTown',
        '',
        '',
        false,
        true,
        10,
        20,
        client.craftTownHostCharacter,
        client.token + 1
    ).toBuffer();
    const decoded = decodeCraftTownOwnerToken(packet);

    assert.equal(decoded.isCraftTown, true);
    assert.equal(decoded.transferToken, client.token);
    assert.notEqual(decoded.ownerToken, decoded.transferToken, 'visited Home owner token should make the client non-interactive');
}

function testVisitedHomeTransferFallsBackToSessionHostWhenVisitMapMisses(): void {
    const client = createVisitedClient();
    GlobalState.houseVisits.delete(client.token);

    const resolveVisitedCraftTownHostCharacter = (LevelHandler as any).resolveVisitedCraftTownHostCharacter as (
        client: FakeClient,
        transferToken: number,
        activeCharacter: Character,
        targetLevel: string
    ) => Character;

    const resolved = resolveVisitedCraftTownHostCharacter(
        client,
        client.token,
        client.character,
        'CraftTown'
    );
    assert.equal(
        resolved.name,
        client.craftTownHostCharacter?.name,
        'visited Home transfer should keep using the session host when the one-shot visit map misses'
    );

    const nonHomeResolved = resolveVisitedCraftTownHostCharacter(
        client,
        client.token,
        client.character,
        'NewbieRoad'
    );
    assert.equal(nonHomeResolved.name, client.character.name, 'session host fallback should only apply to CraftTown');
}

function testCraftTownHomeScopesAreOwnerSpecific(): void {
    const visitor = createCharacter('Visitor');
    const owner = createCharacter('Fleerpuh');
    const otherOwner = createCharacter('OtherOwner');

    const ownerHomeScope = getClientLevelScope({
        currentLevel: 'CraftTown',
        levelInstanceId: getCraftTownHomeInstanceId(owner)
    } as never);
    const visitorInOwnerHomeScope = getClientLevelScope({
        currentLevel: 'CraftTown',
        levelInstanceId: getCraftTownHomeInstanceId(visitor, owner)
    } as never);
    const otherOwnerHomeScope = getClientLevelScope({
        currentLevel: 'CraftTown',
        levelInstanceId: getCraftTownHomeInstanceId(otherOwner)
    } as never);

    assert.equal(
        visitorInOwnerHomeScope,
        ownerHomeScope,
        'visitors to the same owner should share that owner Home scope'
    );
    assert.notEqual(
        ownerHomeScope,
        otherOwnerHomeScope,
        'different players entering their own Homes should not share the same CraftTown scope'
    );
}

function testCraftTownPendingTransferStoresOwnerSpecificScope(): void {
    const visitor = createCharacter('Visitor');
    const owner = createCharacter('Fleerpuh');
    const storePendingTransferToken = (LevelHandler as any).storePendingTransferToken as (
        token: number,
        character: Character,
        userId: number,
        targetLevel: string,
        previousLevel: string,
        newX: number,
        newY: number,
        newHasCoord: boolean,
        sendExtended: boolean,
        syncState: null,
        doorContext: null,
        craftTownHostCharacter?: Character
    ) => void;

    GlobalState.pendingWorld.delete(92001);
    GlobalState.pendingWorld.delete(92002);
    storePendingTransferToken(92001, visitor, 6, 'CraftTown', 'NewbieRoad', 360, 1460, true, false, null, null, owner);
    storePendingTransferToken(92002, owner, 7, 'CraftTown', 'NewbieRoad', 360, 1460, true, false, null, null);

    assert.equal(
        GlobalState.pendingWorld.get(92001)?.levelInstanceId,
        getCraftTownHomeInstanceId(visitor, owner),
        'visited Home pending transfer should use the visited owner Home scope'
    );
    assert.equal(
        GlobalState.pendingWorld.get(92002)?.levelInstanceId,
        getCraftTownHomeInstanceId(owner),
        'own Home pending transfer should use the character owner Home scope'
    );
    assert.equal(
        GlobalState.pendingWorld.get(92001)?.levelInstanceId,
        GlobalState.pendingWorld.get(92002)?.levelInstanceId,
        'owner and visitor should meet only when the owner names match'
    );
    GlobalState.pendingWorld.delete(92001);
    GlobalState.pendingWorld.delete(92002);
}

function testPartyTeleportHostStoresOwnerSpecificPendingHomeScope(): void {
    const visitor = createCharacter('Elmayuk');
    const owner = createCharacter('Fleerpuh');
    const client = {
        ...createVisitedClient(),
        token: 93000,
        character: visitor,
        craftTownHostCharacter: owner,
        currentLevel: 'NewbieRoad',
        levelInstanceId: ''
    };
    const resolveVisitedCraftTownHostCharacter = (LevelHandler as any).resolveVisitedCraftTownHostCharacter as (
        client: FakeClient,
        transferToken: number,
        activeCharacter: Character,
        targetLevel: string
    ) => Character;
    const storePendingTransferToken = (LevelHandler as any).storePendingTransferToken as (
        token: number,
        character: Character,
        userId: number,
        targetLevel: string,
        previousLevel: string,
        newX: number,
        newY: number,
        newHasCoord: boolean,
        sendExtended: boolean,
        syncState: null,
        doorContext: null,
        craftTownHostCharacter?: Character
    ) => void;

    const host = resolveVisitedCraftTownHostCharacter(client as never, client.token, visitor, 'CraftTown');
    GlobalState.pendingWorld.delete(93001);
    storePendingTransferToken(93001, visitor, 6, 'CraftTown', 'NewbieRoad', 444, 1555, true, false, null, null, host);

    const entry = GlobalState.pendingWorld.get(93001);
    assert.equal(entry?.craftTownHostCharacter?.name, owner.name);
    assert.equal(
        entry?.levelInstanceId,
        getCraftTownHomeInstanceId(visitor, owner),
        'party teleport to a Home should store the target owner scope, not the caller Home scope'
    );
    assert.notEqual(entry?.levelInstanceId, getCraftTownHomeInstanceId(visitor));
    GlobalState.pendingWorld.delete(93001);
}

function testVisitedHomePlayerDataUsesHostBuildingDetails(): void {
    const visitor = createCharacter('Visitor');
    const owner = createVisitedClient().craftTownHostCharacter!;
    const buildingState = WorldEnter.getPlayerDataBuildingState(visitor, 'CraftTown', owner);

    assert.equal(buildingState.statsByBuilding['2'], 5, 'visited Home player data should use owner forge rank');
    assert.equal(buildingState.statsByBuilding['6'], 3, 'visited Home player data should use owner mage tower rank');
    assert.equal(buildingState.statsByBuilding['13'], 4, 'visited Home player data should use owner barn rank');
    assert.equal(buildingState.buildingUpgrade.buildingID, 13, 'visited Home player data should use owner active upgrade');
    assert.ok(Number(buildingState.buildingUpgrade.ReadyTime ?? 0) > Math.floor(Date.now() / 1000));
}

function testVisitedHomePlayerDataUsesHostBuildingClassOrder(): void {
    const visitor = createCharacter('Elmayuk');
    visitor.class = 'Mage';
    const owner = createCharacter('Fleerpuh');
    owner.class = 'Paladin';

    assert.deepEqual(
        WorldEnter.getPlayerDataBuildingOrder(visitor, owner),
        [2, 12, 4, 3, 5, 1, 13],
        'visited Home extended player data should serialize building ranks using the owner class buildings'
    );
    assert.notDeepEqual(
        WorldEnter.getPlayerDataBuildingOrder(visitor, owner),
        WorldEnter.getPlayerDataBuildingOrder(visitor),
        'visited Home owner building order must not fall back to the visitor class'
    );
}

function testVisitedHomeLoginForcesExtendedPlayerData(): void {
    const visitor = createCharacter('Visitor');
    const owner = createCharacter('Owner');
    const shouldSendExtendedPlayerData = (CharacterHandler as any).shouldSendExtendedPlayerData as (
        firstLogin: boolean,
        pendingExtended: boolean,
        entry: Record<string, unknown>
    ) => boolean;

    assert.equal(
        shouldSendExtendedPlayerData(false, false, {
            character: visitor,
            craftTownHostCharacter: owner,
            targetLevel: 'CraftTown'
        }),
        true,
        'visited Home login should send extended player data so building details refresh from the owner'
    );
    assert.equal(
        shouldSendExtendedPlayerData(false, false, {
            character: visitor,
            craftTownHostCharacter: visitor,
            targetLevel: 'CraftTown'
        }),
        false,
        'own Home transfers should stay compact'
    );
}

async function testArmoryUsesVisitedHomeHostInventory(): Promise<void> {
    const client = createVisitedClient();
    const beforeCharacter = clone(client.character);

    await withSavesBlocked(async () => {
        CharacterHandler.handleRequestArmoryGears(client as never, createArmoryRequestPacket());
    });

    assert.deepEqual(client.character, beforeCharacter, 'visited Home armory request should not mutate visitor save state');
    const armoryPacket = client.sentPackets.find((packet) => packet.id === 0xF5);
    assert.ok(armoryPacket, 'visited Home armory request should still get a response');
    assert.deepEqual(
        decodeArmoryGears(armoryPacket.payload),
        [
            { gearID: 1178, tier: 2 },
            { gearID: 1180, tier: 1 }
        ],
        'visited Home armory response should use host gear, not visitor gear'
    );
}

async function main(): Promise<void> {
    testGuardDetectsOnlyOtherPlayersHome();
    await testBuildingMutationBlockedAndOwnerStateReasserted();
    await testBuildingUpgradeTimeUsesRankSchedule();
    testBuildingRefreshReassertsInactiveClassTowers();
    testBuildingRefreshKeepsVisitedOwnerInactiveClassTowers();
    testVisitedHomeEnterWorldMarksOwnerToken();
    testVisitedHomeTransferFallsBackToSessionHostWhenVisitMapMisses();
    testCraftTownHomeScopesAreOwnerSpecific();
    testCraftTownPendingTransferStoresOwnerSpecificScope();
    testPartyTeleportHostStoresOwnerSpecificPendingHomeScope();
    testVisitedHomePlayerDataUsesHostBuildingDetails();
    testVisitedHomePlayerDataUsesHostBuildingClassOrder();
    testVisitedHomeLoginForcesExtendedPlayerData();
    await testArmoryUsesVisitedHomeHostInventory();
    console.log('home_building_armory_regression: ok');
}

void main().catch((error) => {
    console.error('home_building_armory_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
