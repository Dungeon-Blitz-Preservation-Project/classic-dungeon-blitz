import { strict as assert } from 'assert';
import * as path from 'path';
import { Character } from '../database/Database';
import { GlobalState } from '../core/GlobalState';
import { normalizeCharacterKey } from '../core/SocialState';
import { LevelConfig } from '../core/LevelConfig';
import { SocialHandler } from '../handlers/SocialHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { MissionLoader } from '../data/MissionLoader';
import { getCraftTownHomeInstanceId } from '../utils/HomeVisitGuard';
import { JsonAdapter } from '../database/JsonAdapter';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    userId: number | null;
    character: Character;
    characters: Character[];
    currentLevel: string;
    levelInstanceId: string;
    craftTownHostCharacter: Character | null;
    entryLevel: string;
    currentRoomId: number;
    clientEntID: number;
    playerSpawned: boolean;
    startedRoomEvents: Set<string>;
    entities: Map<number, any>;
    lastDoorId: number;
    lastDoorTargetLevel: string;
    armPendingTransferGrace: () => void;
    socket: {
        destroyed: boolean;
        readyState: string;
    };
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
    sentPackets: SentPacket[];
};

function createCharacter(name: string, friends: Array<{ name: string; isRequest: boolean }> = []): Character {
    return {
        name,
        class: 'Paladin',
        gender: 'male',
        level: 1,
        friends: friends.map((entry) => ({ ...entry })),
        ignored: []
    };
}

function createFakeClient(name: string, friends: Array<{ name: string; isRequest: boolean }> = []): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = createCharacter(name, friends);

    return {
        token: Math.floor(Math.random() * 100000) + 1,
        userId: null,
        character,
        characters: [character],
        currentLevel: '',
        levelInstanceId: '',
        craftTownHostCharacter: null,
        entryLevel: '',
        currentRoomId: 0,
        clientEntID: 0,
        playerSpawned: false,
        startedRoomEvents: new Set<string>(),
        entities: new Map<number, any>(),
        lastDoorId: -1,
        lastDoorTargetLevel: '',
        armPendingTransferGrace() {
            return;
        },
        socket: {
            destroyed: false,
            readyState: 'open'
        },
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function buildNamePacket(name: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod26(name);
    return bb.toBuffer();
}

function buildVisitHousePacket(name: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod13(name);
    return bb.toBuffer();
}

function buildQueryAnswerPacket(token: number, name: string, accepted: boolean): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(token);
    bb.writeMethod26(name);
    bb.writeMethod15(accepted);
    return bb.toBuffer();
}

function decodeFriendUpdate(payload: Buffer): { name: string; isRequest: boolean } {
    const br = new BitReader(payload);
    return {
        name: br.readMethod13(),
        isRequest: br.readMethod15()
    };
}

function decodeFriendStatus(payload: Buffer): {
    name: string;
    isRequest: boolean;
    online: boolean;
    displayName: string;
    classId: number;
    level: number;
} {
    const br = new BitReader(payload);
    const name = br.readMethod13();
    const isRequest = br.readMethod15();
    const online = br.readMethod15();
    let displayName = name;
    let classId = 0;
    let level = 0;
    if (online) {
        displayName = br.readMethod15() ? br.readMethod13() : name;
        classId = br.readMethod6(2);
        level = br.readMethod6(6);
    }
    return { name, isRequest, online, displayName, classId, level };
}

function decodeFriendRemoved(payload: Buffer): string {
    const br = new BitReader(payload);
    return br.readMethod13();
}

function decodeQueryMessageQuestion(payload: Buffer): { token: number; name: string; message: string } {
    const br = new BitReader(payload);
    return {
        token: br.readMethod9(),
        name: br.readMethod26(),
        message: br.readMethod26()
    };
}

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
    if (!MissionLoader.findPrimaryMissionByDungeon('AC_Mission6')) {
        MissionLoader.load(path.resolve(__dirname, '../data'));
    }
}

async function testAcceptPreservesExistingFriendKey(): Promise<void> {
    const requester = createFakeClient('Requester');
    const receiver = createFakeClient('Receiver', [{ name: 'requester', isRequest: true }]);

    GlobalState.sessionsByToken.set(requester.token, requester as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(requester.character.name), requester as never);

    await SocialHandler.handleFriendRequest(receiver as never, buildNamePacket('requester'));

    assert.deepEqual(receiver.character.friends, [{ name: 'requester', isRequest: false }]);
    assert.deepEqual(requester.character.friends, [{ name: 'Receiver', isRequest: false }]);

    const receiverUpdate = receiver.sentPackets
        .filter((packet) => packet.id === 0x92)
        .map((packet) => decodeFriendUpdate(packet.payload))
        .at(-1);

    assert.ok(receiverUpdate, 'receiver should get an incremental friend update');
    assert.equal(receiverUpdate?.name, 'requester');
    assert.equal(receiverUpdate?.isRequest, false);
}

async function testLiveFriendRequestSendsVisiblePromptAndAccepts(): Promise<void> {
    const requester = createFakeClient('Elmayuk');
    const receiver = createFakeClient('Fleerpuh');
    requester.character.class = 'Mage';
    requester.character.level = 37;
    receiver.character.class = 'Rogue';
    receiver.character.level = 12;
    requester.token = 9101;
    receiver.token = 9102;

    GlobalState.sessionsByToken.set(requester.token, requester as never);
    GlobalState.sessionsByToken.set(receiver.token, receiver as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(requester.character.name), requester as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(receiver.character.name), receiver as never);

    await SocialHandler.handleFriendRequest(requester as never, buildNamePacket('Fleerpuh'));

    assert.deepEqual(receiver.character.friends, [{ name: 'Elmayuk', isRequest: true }]);

    const receiverRequestUpdate = receiver.sentPackets
        .filter((packet) => packet.id === 0x92)
        .map((packet) => decodeFriendUpdate(packet.payload))
        .at(-1);
    assert.deepEqual(receiverRequestUpdate, { name: 'Elmayuk', isRequest: true });

    const prompt = receiver.sentPackets
        .filter((packet) => packet.id === 0x58)
        .map((packet) => decodeQueryMessageQuestion(packet.payload))
        .at(-1);
    assert.ok(prompt, 'receiver should get a visible friend-request query prompt');
    assert.equal(prompt?.name, 'Elmayuk');
    assert.equal(prompt?.message, 'Elmayuk wants to be your friend');

    await SocialHandler.handleQueryMessageAnswer(
        receiver as never,
        buildQueryAnswerPacket(prompt!.token, prompt!.name, true)
    );

    assert.deepEqual(receiver.character.friends, [{ name: 'Elmayuk', isRequest: false }]);
    assert.deepEqual(requester.character.friends, [{ name: 'Fleerpuh', isRequest: false }]);

    const receiverAcceptUpdate = receiver.sentPackets
        .filter((packet) => packet.id === 0x92)
        .map((packet) => decodeFriendStatus(packet.payload))
        .at(-1);
    const requesterAcceptUpdate = requester.sentPackets
        .filter((packet) => packet.id === 0x92)
        .map((packet) => decodeFriendStatus(packet.payload))
        .at(-1);

    assert.deepEqual(receiverAcceptUpdate, {
        name: 'Elmayuk',
        isRequest: false,
        online: true,
        displayName: 'Elmayuk',
        classId: 2,
        level: 37
    });
    assert.deepEqual(requesterAcceptUpdate, {
        name: 'Fleerpuh',
        isRequest: false,
        online: true,
        displayName: 'Fleerpuh',
        classId: 1,
        level: 12
    });
}

function testBlankSavedFriendNamesAreDroppedFromFullList(): void {
    const client = createFakeClient('Receiver', [
        { name: '   ', isRequest: false },
        { name: 'Elmayuk', isRequest: false }
    ]);

    SocialHandler.handleRequestFriendList(client as never, Buffer.alloc(0));

    const packet = client.sentPackets.find((entry) => entry.id === 0xCA);
    assert.ok(packet, 'friend-list request should send a full friend list');
    const br = new BitReader(packet!.payload);
    assert.equal(br.readMethod4(), 1, 'blank saved friend entries should not be sent to the client');
    assert.equal(br.readMethod13(), 'Elmayuk');
    assert.equal(br.readMethod15(), false);
}

async function testPendingFriendRequestResendsVisiblePrompt(): Promise<void> {
    const requester = createFakeClient('Elmayuk');
    const receiver = createFakeClient('Fleerpuh', [{ name: 'Elmayuk', isRequest: true }]);
    requester.token = 9201;
    receiver.token = 9202;

    GlobalState.sessionsByToken.set(requester.token, requester as never);
    GlobalState.sessionsByToken.set(receiver.token, receiver as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(requester.character.name), requester as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(receiver.character.name), receiver as never);

    await SocialHandler.handleFriendRequest(requester as never, buildNamePacket('Fleerpuh'));

    const prompt = receiver.sentPackets
        .filter((packet) => packet.id === 0x58)
        .map((packet) => decodeQueryMessageQuestion(packet.payload))
        .at(-1);

    assert.ok(prompt, 'already-pending live friend request should still show a visible prompt');
    assert.equal(prompt?.name, 'Elmayuk');
    assert.equal(prompt?.message, 'Elmayuk wants to be your friend');
}

async function testStaleCharacterIndexFallsBackToActiveTokenSession(): Promise<void> {
    const requester = createFakeClient('Elmayuk');
    const staleReceiver = createFakeClient('Fleerpuh');
    const activeReceiver = createFakeClient('Fleerpuh');
    requester.token = 9301;
    staleReceiver.token = 9302;
    activeReceiver.token = 9303;
    staleReceiver.socket.destroyed = true;
    staleReceiver.socket.readyState = 'closed';

    GlobalState.sessionsByToken.set(requester.token, requester as never);
    GlobalState.sessionsByToken.set(activeReceiver.token, activeReceiver as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(requester.character.name), requester as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(activeReceiver.character.name), staleReceiver as never);

    await SocialHandler.handleFriendRequest(requester as never, buildNamePacket('Fleerpuh'));

    assert.equal(staleReceiver.sentPackets.length, 0);
    assert.equal(activeReceiver.sentPackets.some((packet) => packet.id === 0x58), true);
    assert.equal(
        GlobalState.sessionsByCharacterName.get(normalizeCharacterKey('Fleerpuh')),
        activeReceiver as never
    );
}

async function testLivePartyInvitePromptCreatesPartyOnAccept(): Promise<void> {
    const inviter = createFakeClient('Elmayuk');
    const invitee = createFakeClient('Fleerpuh');
    inviter.token = 9401;
    invitee.token = 9402;
    inviter.clientEntID = 4101;
    invitee.clientEntID = 4102;

    GlobalState.sessionsByToken.set(inviter.token, inviter as never);
    GlobalState.sessionsByToken.set(invitee.token, invitee as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(inviter.character.name), inviter as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(invitee.character.name), invitee as never);

    SocialHandler.handleGroupInvite(inviter as never, buildNamePacket('Fleerpuh'));

    const prompt = invitee.sentPackets
        .filter((packet) => packet.id === 0x58)
        .map((packet) => decodeQueryMessageQuestion(packet.payload))
        .at(-1);
    assert.ok(prompt, 'party invite should show a visible query prompt');
    assert.equal(prompt?.token, inviter.clientEntID);
    assert.equal(prompt?.name, 'Elmayuk');
    assert.equal(prompt?.message, 'Elmayuk has invited you to join a party');

    await SocialHandler.handleQueryMessageAnswer(
        invitee as never,
        buildQueryAnswerPacket(prompt!.token, prompt!.name, true)
    );

    const partyId = GlobalState.partyByMember.get(normalizeCharacterKey('Elmayuk'));
    assert.ok(partyId, 'accepting a party invite should create a party for the inviter');
    assert.equal(GlobalState.partyByMember.get(normalizeCharacterKey('Fleerpuh')), partyId);
    assert.deepEqual(GlobalState.partyGroups.get(partyId!)?.members, ['Elmayuk', 'Fleerpuh']);
}

async function testUnfriendUsesRemovedEntryKeyForReverseUpdate(): Promise<void> {
    const requester = createFakeClient('Requester', [{ name: 'receiver', isRequest: false }]);
    const receiver = createFakeClient('Receiver', [{ name: 'Requester', isRequest: false }]);

    GlobalState.sessionsByToken.set(requester.token, requester as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(requester.character.name), requester as never);

    await SocialHandler.handleUnfriend(receiver as never, buildNamePacket('Requester'));

    assert.deepEqual(receiver.character.friends, []);
    assert.deepEqual(requester.character.friends, []);

    const requesterRemoval = requester.sentPackets
        .filter((packet) => packet.id === 0x93)
        .map((packet) => decodeFriendRemoved(packet.payload))
        .at(-1);

    assert.equal(requesterRemoval, 'receiver');
}

function testTeleportToPlayerCapturesDungeonAnchorState(): void {
    const caller = createFakeClient('Caller');
    const target = createFakeClient('Target');
    caller.token = 1001;
    caller.currentLevel = 'BridgeTown';
    caller.playerSpawned = true;
    caller.clientEntID = 4001;
    const callerMissionDef = MissionLoader.findPrimaryMissionByDungeon('TutorialDungeon');
    if (callerMissionDef) {
        (caller.character as any).missions = {
            [String(callerMissionDef.MissionID)]: { state: 1 }
        };
    }
    target.token = 1002;
    target.currentLevel = 'TutorialDungeon';
    target.entryLevel = 'NewbieRoad';
    target.currentRoomId = 15;
    target.playerSpawned = true;
    target.clientEntID = 4002;
    target.entities.set(target.clientEntID, { x: 1444, y: 2333 });
    target.startedRoomEvents = new Set([
        'TutorialDungeon:0',
        'TutorialDungeon:4',
        'TutorialDungeon:15',
        'OtherLevel:2'
    ]);

    GlobalState.sessionsByToken.set(caller.token, caller as never);
    GlobalState.sessionsByToken.set(target.token, target as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(caller.character.name), caller as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(target.character.name), target as never);

    const partyId = 77;
    GlobalState.partyGroups.set(partyId, {
        id: partyId,
        leader: caller.character.name,
        members: [caller.character.name, target.character.name],
        locked: false
    });
    GlobalState.partyByMember.set(normalizeCharacterKey(caller.character.name), partyId);
    GlobalState.partyByMember.set(normalizeCharacterKey(target.character.name), partyId);

    SocialHandler.handleTeleportToPlayer(caller as never, buildNamePacket(target.character.name));

    const pendingTeleport = GlobalState.pendingTeleports.get(caller.token);
    assert.ok(pendingTeleport);
    assert.equal(pendingTeleport?.targetLevel, 'TutorialDungeon');
    assert.equal(pendingTeleport?.x, 1444);
    assert.equal(pendingTeleport?.y, 2333);
    assert.equal(pendingTeleport?.syncAnchorToken, target.token);
    assert.equal(pendingTeleport?.syncAnchorCharacterName, target.character.name);
    assert.equal(pendingTeleport?.syncRoomId, 15);
    assert.deepEqual(pendingTeleport?.syncStartedRoomIds, [0, 4, 15]);
    assert.equal(caller.lastDoorTargetLevel, 'TutorialDungeon');
    assert.equal(caller.sentPackets.some((packet) => packet.id === 0x2E), true);
}

function testTeleportToPartyMemberHomeCarriesHomeOwner(): void {
    const caller = createFakeClient('Elmayuk');
    const target = createFakeClient('Fleerpuh');
    caller.token = 1051;
    caller.currentLevel = 'NewbieRoad';
    caller.playerSpawned = true;
    caller.clientEntID = 4051;
    target.token = 1052;
    target.currentLevel = 'CraftTown';
    target.levelInstanceId = getCraftTownHomeInstanceId(target.character);
    target.currentRoomId = 0;
    target.playerSpawned = true;
    target.clientEntID = 4052;
    target.entities.set(target.clientEntID, { x: 444, y: 1555 });

    GlobalState.sessionsByToken.set(caller.token, caller as never);
    GlobalState.sessionsByToken.set(target.token, target as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(caller.character.name), caller as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(target.character.name), target as never);

    const partyId = 177;
    GlobalState.partyGroups.set(partyId, {
        id: partyId,
        leader: target.character.name,
        members: [caller.character.name, target.character.name],
        locked: false
    });
    GlobalState.partyByMember.set(normalizeCharacterKey(caller.character.name), partyId);
    GlobalState.partyByMember.set(normalizeCharacterKey(target.character.name), partyId);

    SocialHandler.handleTeleportToPlayer(caller as never, buildNamePacket(target.character.name));

    const pendingTeleport = GlobalState.pendingTeleports.get(caller.token);
    assert.ok(pendingTeleport);
    assert.equal(pendingTeleport?.targetLevel, 'CraftTown');
    assert.equal(pendingTeleport?.levelInstanceId, getCraftTownHomeInstanceId(target.character));
    assert.equal(pendingTeleport?.craftTownHostCharacter?.name, target.character.name);
    assert.equal(caller.craftTownHostCharacter?.name, target.character.name);
    assert.equal(caller.lastDoorTargetLevel, 'CraftTown');
    assert.equal(caller.sentPackets.some((packet) => packet.id === 0x2E), true);
}

async function testVisitHousePrefersLiveServerCharacter(): Promise<void> {
    const caller = createFakeClient('Elmayuk');
    const target = createFakeClient('Fleerpuh');
    caller.token = 1061;
    target.token = 1062;
    target.character.magicForge = { stats_by_building: { '2': 5, '12': 4, '3': 3, '1': 1, '13': 2 } } as never;

    const savedTarget = createCharacter('Fleerpuh');
    savedTarget.magicForge = { stats_by_building: { '2': 1, '12': 1, '3': 1, '1': 1, '13': 1 } } as never;
    const originalGetAccountIdByCharName = JsonAdapter.prototype.getAccountIdByCharName;
    const originalLoadCharacters = JsonAdapter.prototype.loadCharacters;
    JsonAdapter.prototype.getAccountIdByCharName = async function(): Promise<number | null> {
        return 26;
    };
    JsonAdapter.prototype.loadCharacters = async function(): Promise<Character[]> {
        return [savedTarget];
    };

    try {
        GlobalState.sessionsByToken.set(target.token, target as never);
        GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(target.character.name), target as never);

        await SocialHandler.handleRequestVisitPlayerHouse(caller as never, buildVisitHousePacket(target.character.name));

        assert.equal(caller.craftTownHostCharacter, target.character);
        assert.equal(GlobalState.houseVisits.get(caller.token), target.character);
        assert.equal(caller.lastDoorTargetLevel, 'CraftTown');
        assert.equal(caller.sentPackets.some((packet) => packet.id === 0x2E), true);
    } finally {
        JsonAdapter.prototype.getAccountIdByCharName = originalGetAccountIdByCharName;
        JsonAdapter.prototype.loadCharacters = originalLoadCharacters;
    }
}

function testTeleportToLockedPartyDungeonStartsPartyJoinTransfer(): void {
    const caller = createFakeClient('Caller');
    const target = createFakeClient('Target');
    caller.token = 1101;
    caller.currentLevel = 'AshwoodCaverns';
    caller.playerSpawned = true;
    caller.clientEntID = 4101;
    target.token = 1102;
    target.currentLevel = 'AC_Mission6';
    target.currentRoomId = 3;
    target.playerSpawned = true;
    target.clientEntID = 4102;
    target.entities.set(target.clientEntID, { x: 700, y: 800 });

    GlobalState.sessionsByToken.set(caller.token, caller as never);
    GlobalState.sessionsByToken.set(target.token, target as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(caller.character.name), caller as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(target.character.name), target as never);

    const partyId = 78;
    GlobalState.partyGroups.set(partyId, {
        id: partyId,
        leader: target.character.name,
        members: [caller.character.name, target.character.name],
        locked: false
    });
    GlobalState.partyByMember.set(normalizeCharacterKey(caller.character.name), partyId);
    GlobalState.partyByMember.set(normalizeCharacterKey(target.character.name), partyId);

    SocialHandler.handleTeleportToPlayer(caller as never, buildNamePacket(target.character.name));

    const pendingTeleport = GlobalState.pendingTeleports.get(caller.token);
    assert.ok(pendingTeleport, 'locked party member should still be able to join an existing party dungeon');
    assert.equal(pendingTeleport?.targetLevel, 'AC_Mission6');
    assert.equal(pendingTeleport?.syncAnchorToken, target.token);
    assert.equal(caller.sentPackets.some((packet) => packet.id === 0x2E), true);
}

function testTeleportToUnlockedPartyDungeonStartsTransfer(): void {
    const caller = createFakeClient('Caller');
    const target = createFakeClient('Target');
    caller.token = 1201;
    caller.currentLevel = 'AshwoodCaverns';
    caller.playerSpawned = true;
    caller.clientEntID = 4201;
    target.token = 1202;
    target.currentLevel = 'AC_Mission6';
    target.currentRoomId = 3;
    target.playerSpawned = true;
    target.clientEntID = 4202;
    target.entities.set(target.clientEntID, { x: 701, y: 801 });

    const missionDef = MissionLoader.findPrimaryMissionByDungeon('AC_Mission6');
    assert.ok(missionDef, 'AC_Mission6 should have a primary dungeon mission');
    (caller.character as any).missions = {
        [String(missionDef!.MissionID)]: { state: 1 }
    };

    GlobalState.sessionsByToken.set(caller.token, caller as never);
    GlobalState.sessionsByToken.set(target.token, target as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(caller.character.name), caller as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(target.character.name), target as never);

    const partyId = 79;
    GlobalState.partyGroups.set(partyId, {
        id: partyId,
        leader: target.character.name,
        members: [caller.character.name, target.character.name],
        locked: false
    });
    GlobalState.partyByMember.set(normalizeCharacterKey(caller.character.name), partyId);
    GlobalState.partyByMember.set(normalizeCharacterKey(target.character.name), partyId);

    SocialHandler.handleTeleportToPlayer(caller as never, buildNamePacket(target.character.name));

    const pendingTeleport = GlobalState.pendingTeleports.get(caller.token);
    assert.ok(pendingTeleport);
    assert.equal(pendingTeleport?.targetLevel, 'AC_Mission6');
    assert.equal(pendingTeleport?.syncAnchorToken, target.token);
    assert.equal(caller.sentPackets.some((packet) => packet.id === 0x2E), true);
}

async function main(): Promise<void> {
    ensureLevelConfigLoaded();

    const sessionsByCharacterName = new Map(GlobalState.sessionsByCharacterName);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const sessionsByUserId = new Map(GlobalState.sessionsByUserId);
    const tokenChar = new Map(GlobalState.tokenChar);
    const pendingWorld = new Map(GlobalState.pendingWorld);
    const pendingExtended = new Map(GlobalState.pendingExtended);
    const partyGroups = new Map(GlobalState.partyGroups);
    const partyByMember = new Map(GlobalState.partyByMember);
    const pendingTeleports = new Map(GlobalState.pendingTeleports);
    const houseVisits = new Map(GlobalState.houseVisits);

    GlobalState.sessionsByCharacterName.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.sessionsByUserId.clear();
    GlobalState.tokenChar.clear();
    GlobalState.pendingWorld.clear();
    GlobalState.pendingExtended.clear();
    GlobalState.partyGroups.clear();
    GlobalState.partyByMember.clear();
    GlobalState.pendingTeleports.clear();
    GlobalState.houseVisits.clear();

    try {
        await testAcceptPreservesExistingFriendKey();

        GlobalState.sessionsByCharacterName.clear();
        GlobalState.sessionsByToken.clear();
        await testLiveFriendRequestSendsVisiblePromptAndAccepts();

        GlobalState.sessionsByCharacterName.clear();
        GlobalState.sessionsByToken.clear();
        testBlankSavedFriendNamesAreDroppedFromFullList();

        GlobalState.sessionsByCharacterName.clear();
        GlobalState.sessionsByToken.clear();
        await testPendingFriendRequestResendsVisiblePrompt();

        GlobalState.sessionsByCharacterName.clear();
        GlobalState.sessionsByToken.clear();
        await testStaleCharacterIndexFallsBackToActiveTokenSession();

        GlobalState.sessionsByCharacterName.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        await testLivePartyInvitePromptCreatesPartyOnAccept();

        GlobalState.sessionsByCharacterName.clear();
        GlobalState.sessionsByToken.clear();
        await testUnfriendUsesRemovedEntryKeyForReverseUpdate();

        GlobalState.sessionsByCharacterName.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        GlobalState.pendingTeleports.clear();
        testTeleportToPlayerCapturesDungeonAnchorState();

        GlobalState.sessionsByCharacterName.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        GlobalState.pendingTeleports.clear();
        testTeleportToPartyMemberHomeCarriesHomeOwner();

        GlobalState.sessionsByCharacterName.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        GlobalState.pendingTeleports.clear();
        GlobalState.houseVisits.clear();
        await testVisitHousePrefersLiveServerCharacter();

        GlobalState.sessionsByCharacterName.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        GlobalState.pendingTeleports.clear();
        testTeleportToLockedPartyDungeonStartsPartyJoinTransfer();

        GlobalState.sessionsByCharacterName.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        GlobalState.pendingTeleports.clear();
        testTeleportToUnlockedPartyDungeonStartsTransfer();
    } finally {
        GlobalState.sessionsByCharacterName = sessionsByCharacterName;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.sessionsByUserId = sessionsByUserId;
        GlobalState.tokenChar = tokenChar;
        GlobalState.pendingWorld = pendingWorld;
        GlobalState.pendingExtended = pendingExtended;
        GlobalState.partyGroups = partyGroups;
        GlobalState.partyByMember = partyByMember;
        GlobalState.pendingTeleports = pendingTeleports;
        GlobalState.houseVisits = houseVisits;
    }

    console.log('friend_social_regression: ok');
}

void main().catch((error) => {
    console.error('friend_social_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
