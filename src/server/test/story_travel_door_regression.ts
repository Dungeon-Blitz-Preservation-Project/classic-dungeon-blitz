import { strict as assert } from 'assert';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    currentLevel: string;
    currentRoomId: number;
    entryLevel?: string;
    levelInstanceId: string;
    playerSpawned: boolean;
    mountTransferGraceUntil: number;
    lastDoorId?: number;
    lastDoorTargetLevel?: string;
    character: {
        name: string;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, Record<string, number>>;
        equippedMount?: number;
    };
    sentPackets: SentPacket[];
    armPendingTransferGrace: () => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

type StoryDoorCase = {
    label: string;
    currentLevel: string;
    doorId: number;
    missionId: MissionID;
    dungeonTarget: string;
    travelTarget: string;
};

type DirectTravelDoorCase = {
    currentLevel: string;
    doorId: number;
    travelTarget: string;
};

type DungeonDoorCase = {
    currentLevel: string;
    doorId: number;
    dungeonTarget: string;
};

type QuestLockedDungeonDoorCase = {
    label: string;
    currentLevel: string;
    doorId: number;
    missionId: MissionID;
    dungeonTarget: string;
};

const STORY_DOOR_CASES: StoryDoorCase[] = [
    {
        label: 'Black Rose Mire to Felbridge',
        currentLevel: 'SwampRoadNorth',
        doorId: 1,
        missionId: MissionID.ClearTheBridge,
        dungeonTarget: 'SwampRoadConnectionMission',
        travelTarget: 'SwampRoadConnection'
    },
    {
        label: 'Felbridge to Castle Hocke',
        currentLevel: 'BridgeTown',
        doorId: 3,
        missionId: MissionID.DeepgardDragon,
        dungeonTarget: 'AC_Mission1',
        travelTarget: 'Castle'
    },
    {
        label: 'Dread Felbridge to Dread Castle Hocke',
        currentLevel: 'BridgeTownHard',
        doorId: 3,
        missionId: MissionID.DeepgardDragonHard,
        dungeonTarget: 'AC_Mission1Hard',
        travelTarget: 'CastleHard'
    },
    {
        label: 'Shazari Desert to Valhaven',
        currentLevel: 'ShazariDesert',
        doorId: 2,
        missionId: MissionID.HeadToValhaven,
        dungeonTarget: 'JC_Mission1',
        travelTarget: 'JadeCity'
    },
    {
        label: 'Dread Shazari Desert to Dread Valhaven',
        currentLevel: 'ShazariDesertHard',
        doorId: 2,
        missionId: MissionID.HeadToValhavenHard,
        dungeonTarget: 'JC_Mission1Hard',
        travelTarget: 'JadeCityHard'
    }
];

const DIRECT_WORLD_TRAVEL_CASES: DirectTravelDoorCase[] = [
    { currentLevel: 'NewbieRoad', doorId: 2, travelTarget: 'SwampRoadNorth' },
    { currentLevel: 'NewbieRoadHard', doorId: 2, travelTarget: 'SwampRoadNorthHard' },
    { currentLevel: 'SwampRoadNorthHard', doorId: 1, travelTarget: 'SwampRoadConnectionHard' },
    { currentLevel: 'BridgeTown', doorId: 2, travelTarget: 'CemeteryHill' },
    { currentLevel: 'BridgeTownHard', doorId: 2, travelTarget: 'CemeteryHillHard' },
    { currentLevel: 'BridgeTown', doorId: 6, travelTarget: 'OldMineMountain' },
    { currentLevel: 'BridgeTownHard', doorId: 6, travelTarget: 'OldMineMountainHard' },
    { currentLevel: 'OldMineMountain', doorId: 2, travelTarget: 'EmeraldGlades' },
    { currentLevel: 'OldMineMountainHard', doorId: 2, travelTarget: 'EmeraldGladesHard' },
    { currentLevel: 'EmeraldGlades', doorId: 1, travelTarget: 'OldMineMountain' },
    { currentLevel: 'EmeraldGladesHard', doorId: 1, travelTarget: 'OldMineMountainHard' },
    { currentLevel: 'Castle', doorId: 4, travelTarget: 'ShazariDesert' },
    { currentLevel: 'CastleHard', doorId: 4, travelTarget: 'ShazariDesertHard' },
    { currentLevel: 'ShazariDesert', doorId: 1, travelTarget: 'Castle' },
    { currentLevel: 'ShazariDesertHard', doorId: 1, travelTarget: 'CastleHard' },
    { currentLevel: 'JadeCity', doorId: 1, travelTarget: 'ShazariDesert' },
    { currentLevel: 'JadeCityHard', doorId: 1, travelTarget: 'ShazariDesertHard' }
];

const DUNGEON_DOOR_CASES: DungeonDoorCase[] = [
    { currentLevel: 'NewbieRoad', doorId: 101, dungeonTarget: 'TutorialDungeon' },
    { currentLevel: 'CemeteryHill', doorId: 101, dungeonTarget: 'CH_Mission1' },
    { currentLevel: 'CemeteryHillHard', doorId: 101, dungeonTarget: 'CH_Mission1Hard' },
    { currentLevel: 'Castle', doorId: 106, dungeonTarget: 'AC_Mission6' },
    { currentLevel: 'CastleHard', doorId: 106, dungeonTarget: 'AC_Mission6Hard' },
    { currentLevel: 'JadeCity', doorId: 111, dungeonTarget: 'JC_Mission11' },
    { currentLevel: 'JadeCityHard', doorId: 111, dungeonTarget: 'JC_Mission11Hard' }
];

const QUEST_LOCKED_DUNGEON_DOOR_CASES: QuestLockedDungeonDoorCase[] = [
    {
        label: 'Mystery of the Yornak',
        currentLevel: 'SwampRoadNorth',
        doorId: 102,
        missionId: MissionID.SlayYornak,
        dungeonTarget: 'SRN_Mission2'
    },
    {
        label: 'Dereliction of Duty',
        currentLevel: 'BridgeTown',
        doorId: 104,
        missionId: MissionID.DerelictionOfDuty,
        dungeonTarget: 'BT_Mission4'
    },
    {
        label: 'Abandoned Armory',
        currentLevel: 'OldMineMountain',
        doorId: 104,
        missionId: MissionID.AbandonedArmory,
        dungeonTarget: 'OMM_Mission4'
    },
    {
        label: 'Ancient Unrest',
        currentLevel: 'ShazariDesert',
        doorId: 105,
        missionId: MissionID.AncientBurialGrounds,
        dungeonTarget: 'SD_Mission5'
    }
];

function getRequiredDirectTravelMission(currentLevel: string, travelTarget: string): MissionID | null {
    if (currentLevel === 'Castle' && travelTarget === 'ShazariDesert') {
        return MissionID.IntoTheDepths;
    }

    if (currentLevel === 'CastleHard' && travelTarget === 'ShazariDesertHard') {
        return MissionID.IntoTheDepthsHard;
    }

    if (currentLevel === 'BridgeTownHard' && travelTarget === 'CemeteryHillHard') {
        return MissionID.OldHeroesNeverDieHard;
    }

    if (currentLevel === 'BridgeTownHard' && travelTarget === 'OldMineMountainHard') {
        return MissionID.DerelictionOfDutyHard;
    }

    return null;
}

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('BridgeTown')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.DeepgardDragon)) {
        MissionLoader.load(dataDir);
    }
}

function createDoorPacket(doorId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(doorId);
    return bb.toBuffer();
}

function readMethod91(br: BitReader): number {
    const prefix = br.readMethod20(3);
    return br.readMethod20((prefix + 1) * 2);
}

function decodeDoorStatePacket(payload: Buffer): { doorId: number; state: number; targetLevel: string; stars: number } {
    const br = new BitReader(payload);
    const doorId = br.readMethod4();
    const state = readMethod91(br);
    const targetLevel = br.readMethod13();
    return {
        doorId,
        state,
        targetLevel,
        stars: state === 3 ? br.readMethod6(4) : 0
    };
}

function decodeDoorTargetPacket(payload: Buffer): { doorId: number; targetLevel: string } {
    const br = new BitReader(payload);
    return {
        doorId: br.readMethod4(),
        targetLevel: br.readMethod13()
    };
}

function createClient(currentLevel: string, missionId: MissionID, missionState: number): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        currentLevel,
        currentRoomId: 0,
        levelInstanceId: 'story-travel-door-regression',
        playerSpawned: true,
        mountTransferGraceUntil: 0,
        character: {
            name: 'StoryTravelDoorTester',
            CurrentLevel: { name: currentLevel, x: 0, y: 0 },
            PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 },
            missions: {
                [String(missionId)]: {
                    state: missionState,
                    currCount: missionState >= 2 ? 1 : 0,
                    Tier: 12,
                    highscore: 180000,
                    Time: 555555
                }
            }
        },
        sentPackets,
        armPendingTransferGrace(): void {},
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createDungeonDoorClient(currentLevel: string, dungeonTarget: string): FakeClient {
    const missionDef = MissionLoader.findPrimaryMissionByDungeon(dungeonTarget);
    assert(missionDef, `expected primary mission for ${dungeonTarget}`);
    return createClient(currentLevel, missionDef.MissionID as MissionID, 1);
}

function latestPacket(client: FakeClient, id: number): SentPacket {
    const packet = [...client.sentPackets].reverse().find((entry) => entry.id === id);
    assert(packet, `expected packet ${id}`);
    return packet;
}

function testUnfinishedStoryDoorsStillEnterTheirDungeon(): void {
    for (const testCase of STORY_DOOR_CASES) {
        const client = createClient(testCase.currentLevel, testCase.missionId, 1);

        LevelHandler.handleRequestDoorState(client as never, createDoorPacket(testCase.doorId));
        LevelHandler.handleOpenDoor(client as never, createDoorPacket(testCase.doorId));

        assert.deepEqual(
            decodeDoorStatePacket(latestPacket(client, 0x42).payload),
            {
                doorId: testCase.doorId,
                state: 2,
                targetLevel: testCase.dungeonTarget,
                stars: 0
            },
            `${testCase.label} should still show the story dungeon before it is cleared`
        );
        assert.deepEqual(
            decodeDoorTargetPacket(latestPacket(client, 0x2E).payload),
            {
                doorId: testCase.doorId,
                targetLevel: testCase.dungeonTarget
            },
            `${testCase.label} should still open the story dungeon before it is cleared`
        );
    }
}

function testCompletedStoryDoorsBecomeMapTravel(): void {
    for (const testCase of STORY_DOOR_CASES) {
        const client = createClient(testCase.currentLevel, testCase.missionId, 2);

        LevelHandler.handleRequestDoorState(client as never, createDoorPacket(testCase.doorId));
        LevelHandler.handleOpenDoor(client as never, createDoorPacket(testCase.doorId));

        assert.deepEqual(
            decodeDoorStatePacket(latestPacket(client, 0x42).payload),
            {
                doorId: testCase.doorId,
                state: 1,
                targetLevel: testCase.travelTarget,
                stars: 0
            },
            `${testCase.label} should use the travel plate after the story dungeon is cleared`
        );
        assert.deepEqual(
            decodeDoorTargetPacket(latestPacket(client, 0x2E).payload),
            {
                doorId: testCase.doorId,
                targetLevel: testCase.travelTarget
            },
            `${testCase.label} should transfer to the unlocked map after the story dungeon is cleared`
        );
    }
}

function testClaimedOldSaveStoryDoorsStayMapTravelWithoutStars(): void {
    for (const testCase of STORY_DOOR_CASES) {
        const client = createClient(testCase.currentLevel, testCase.missionId, 3);

        LevelHandler.handleRequestDoorState(client as never, createDoorPacket(testCase.doorId));

        assert.deepEqual(
            decodeDoorStatePacket(latestPacket(client, 0x42).payload),
            {
                doorId: testCase.doorId,
                state: 1,
                targetLevel: testCase.travelTarget,
                stars: 0
            },
            `${testCase.label} should read old completed saves as travel, not mission repeat`
        );
    }
}

function testDirectWorldTravelDoorsUseTravelState(): void {
    for (const testCase of DIRECT_WORLD_TRAVEL_CASES) {
        const client = createClient(testCase.currentLevel, MissionID.DefendTheShip, 0);
        const requiredMissionId = getRequiredDirectTravelMission(testCase.currentLevel, testCase.travelTarget);
        if (requiredMissionId !== null) {
            client.character.missions[String(requiredMissionId)] = {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            };
        }

        LevelHandler.handleRequestDoorState(client as never, createDoorPacket(testCase.doorId));

        assert.deepEqual(
            decodeDoorStatePacket(latestPacket(client, 0x42).payload),
            {
                doorId: testCase.doorId,
                state: 1,
                targetLevel: testCase.travelTarget,
                stars: 0
            },
            `${testCase.currentLevel} door ${testCase.doorId} should remain a map travel door`
        );
    }
}

function testFirstTimeDungeonDoorsUseDungeonState(): void {
    for (const testCase of DUNGEON_DOOR_CASES) {
        const client = createDungeonDoorClient(testCase.currentLevel, testCase.dungeonTarget);

        LevelHandler.handleRequestDoorState(client as never, createDoorPacket(testCase.doorId));

        assert.deepEqual(
            decodeDoorStatePacket(latestPacket(client, 0x42).payload),
            {
                doorId: testCase.doorId,
                state: 2,
                targetLevel: testCase.dungeonTarget,
                stars: 0
            },
            `${testCase.currentLevel} door ${testCase.doorId} should show the dungeon plate before completion`
        );
    }
}

function testQuestLockedDungeonDoorsRequireAcceptedMission(): void {
    for (const testCase of QUEST_LOCKED_DUNGEON_DOOR_CASES) {
        const lockedClient = createClient(testCase.currentLevel, testCase.missionId, 0);

        LevelHandler.handleRequestDoorState(lockedClient as never, createDoorPacket(testCase.doorId));
        LevelHandler.handleOpenDoor(lockedClient as never, createDoorPacket(testCase.doorId));

        assert.deepEqual(
            decodeDoorStatePacket(latestPacket(lockedClient, 0x42).payload),
            {
                doorId: testCase.doorId,
                state: 4,
                targetLevel: testCase.dungeonTarget,
                stars: 0
            },
            `${testCase.label} should stay locked until the NPC grants the quest`
        );
        assert.equal(
            lockedClient.sentPackets.some((packet) => packet.id === 0x2E),
            false,
            `${testCase.label} should not send a door target before quest acceptance`
        );

        const acceptedClient = createClient(testCase.currentLevel, testCase.missionId, 1);

        LevelHandler.handleRequestDoorState(acceptedClient as never, createDoorPacket(testCase.doorId));
        LevelHandler.handleOpenDoor(acceptedClient as never, createDoorPacket(testCase.doorId));

        assert.deepEqual(
            decodeDoorStatePacket(latestPacket(acceptedClient, 0x42).payload),
            {
                doorId: testCase.doorId,
                state: 2,
                targetLevel: testCase.dungeonTarget,
                stars: 0
            },
            `${testCase.label} should show the dungeon once the quest is accepted`
        );
        assert.deepEqual(
            decodeDoorTargetPacket(latestPacket(acceptedClient, 0x2E).payload),
            {
                doorId: testCase.doorId,
                targetLevel: testCase.dungeonTarget
            },
            `${testCase.label} should transfer once the quest is accepted`
        );
    }
}

function testDreadShazariPortalIsReturnOnlyFromNormalSide(): void {
    const freshNormalClient = createClient('ShazariDesert', MissionID.Capstone, 3);

    LevelHandler.handleRequestDoorState(freshNormalClient as never, createDoorPacket(300));

    assert.deepEqual(
        decodeDoorStatePacket(latestPacket(freshNormalClient, 0x42).payload),
        {
            doorId: 300,
            state: 4,
            targetLevel: 'ShazariDesertHard',
            stars: 0
        },
        'normal Shazari Dread portal should stay locked unless it is returning from Dread Shazari'
    );

    const returningClient = createClient('ShazariDesert', MissionID.Capstone, 3);
    returningClient.character.PreviousLevel.name = 'ShazariDesertHard';

    LevelHandler.handleRequestDoorState(returningClient as never, createDoorPacket(300));

    assert.deepEqual(
        decodeDoorStatePacket(latestPacket(returningClient, 0x42).payload),
        {
            doorId: 300,
            state: 1,
            targetLevel: 'ShazariDesertHard',
            stars: 0
        },
        'normal Shazari Dread portal should reopen as a return portal after entering from Dread Shazari'
    );
}

function testShazariPortalRequiresTitusMissionAfterCapstone(): void {
    const capstoneOnlyClient = createClient('Castle', MissionID.Capstone, 3);

    LevelHandler.handleRequestDoorState(capstoneOnlyClient as never, createDoorPacket(4));
    LevelHandler.handleOpenDoor(capstoneOnlyClient as never, createDoorPacket(4));

    assert.deepEqual(
        decodeDoorStatePacket(latestPacket(capstoneOnlyClient, 0x42).payload),
        {
            doorId: 4,
            state: 4,
            targetLevel: 'ShazariDesert',
            stars: 0
        },
        'Castle portal should stay locked after Capstone until Titus starts Into the Depths'
    );
    assert.equal(
        capstoneOnlyClient.sentPackets.some((packet) => packet.id === 0x2E),
        false,
        'Castle portal should not transfer before Into the Depths is accepted'
    );

    const acceptedClient = createClient('Castle', MissionID.Capstone, 3);
    acceptedClient.character.missions[String(MissionID.IntoTheDepths)] = {
        state: 1,
        currCount: 0
    };

    LevelHandler.handleRequestDoorState(acceptedClient as never, createDoorPacket(4));
    LevelHandler.handleOpenDoor(acceptedClient as never, createDoorPacket(4));

    assert.deepEqual(
        decodeDoorStatePacket(latestPacket(acceptedClient, 0x42).payload),
        {
            doorId: 4,
            state: 1,
            targetLevel: 'ShazariDesert',
            stars: 0
        },
        'Castle portal should become travel after Titus starts Into the Depths'
    );
    assert.deepEqual(
        decodeDoorTargetPacket(latestPacket(acceptedClient, 0x2E).payload),
        {
            doorId: 4,
            targetLevel: 'ShazariDesert'
        },
        'Castle portal should transfer after Into the Depths is accepted'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    testUnfinishedStoryDoorsStillEnterTheirDungeon();
    testCompletedStoryDoorsBecomeMapTravel();
    testClaimedOldSaveStoryDoorsStayMapTravelWithoutStars();
    testDirectWorldTravelDoorsUseTravelState();
    testFirstTimeDungeonDoorsUseDungeonState();
    testQuestLockedDungeonDoorsRequireAcceptedMission();
    testDreadShazariPortalIsReturnOnlyFromNormalSide();
    testShazariPortalRequiresTitusMissionAfterCapstone();
    console.log('story_travel_door_regression: ok');
}

void main().catch((error) => {
    console.error('story_travel_door_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
