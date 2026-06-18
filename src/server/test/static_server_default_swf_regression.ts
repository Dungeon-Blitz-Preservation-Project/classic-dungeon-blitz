import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { GlobalState } from '../core/GlobalState';
import { StaticServer } from '../core/StaticServer';

function getSwfBody(buffer: Buffer): Buffer {
    const signature = buffer.subarray(0, 3).toString('ascii');
    return signature === 'CWS' ? zlib.inflateSync(buffer.subarray(8)) : buffer.subarray(8);
}

function testStaticServerServesSingleSwfByDefault(): void {
    const server = new StaticServer();
    const selectedSwfPath = (server as any).getSelectedSwfPath() as string;
    const selectedSwfUrl = (server as any).getSelectedSwfUrl() as string;

    assert.equal(path.basename(selectedSwfPath), 'DungeonBlitz.swf');
    assert.equal(selectedSwfUrl, '/p/cbp/DungeonBlitz.swf?fv=cdb&gv=cdb');
    assert.equal(fs.existsSync(selectedSwfPath), true);
}

function testStaticServerCanonicalizesDirectSwfVersionParams(): void {
    const server = new StaticServer();
    const staleRequest = {
        query: { fv: 'cbx', gv: 'cbx', lang: 'tr' },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };
    const canonicalRequest = {
        query: { fv: 'cdb', gv: 'cdb' },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };

    assert.equal((server as any).isCanonicalSelectedSwfRequest(staleRequest), false);
    assert.equal((server as any).isCanonicalSelectedSwfRequest(canonicalRequest), true);
    assert.equal(
        (server as any).getCanonicalSelectedSwfUrl(staleRequest),
        '/p/cbp/DungeonBlitz.swf?fv=cdb&gv=cdb&lang=tr'
    );
}

function testStaticServerRootServesIndexHtml(): void {
    const server = new StaticServer();
    const rootRoute = (server as any).app.router.stack.find((layer: any) => layer.route?.path === '/');
    const rootHandler = String(rootRoute?.route?.stack?.[0]?.handle ?? '');

    assert.equal(rootHandler.includes('index.html'), true, 'Static root should serve the legacy small-screen HTML wrapper');
    assert.equal(rootHandler.includes('redirect'), false, 'Static root should not redirect into direct SWF playback');
    assert.equal(rootHandler.includes('application/x-shockwave-flash'), false, 'Static root should not serve raw SWF bytes');
}

function testStaticServerSelectsLocalizedGameSwz(): void {
    const server = new StaticServer();
    const englishPath = (server as any).getGameSwzPathForLocale('en') as string;
    const turkishPath = (server as any).getGameSwzPathForLocale('tr') as string;

    assert.equal(path.basename(englishPath), 'Game.en.swz');
    assert.equal(path.basename(turkishPath), 'Game.tr.swz');
    assert.equal(fs.existsSync(englishPath), true);
    assert.equal(fs.existsSync(turkishPath), true);
}

function testStaticServerAliasesVersionedGameSwzRequests(): void {
    const server = new StaticServer();
    const gameSwzRoute = (server as any).app.router.stack.find((layer: any) => {
        return layer.route?.path === '/p/:assetVersion/Game.swz';
    });

    assert.ok(gameSwzRoute, 'Static server should alias versioned Game.swz requests such as /p/cdb/Game.swz');
    assert.equal(gameSwzRoute.route?.methods?.get, true);
}

function testStaticServerAliasesCurrentFlashVersionManifest(): void {
    const server = new StaticServer();
    const manifestPath = (server as any).getFlashVersionAssetPath('/masterFileList.xml') as string;

    assert.equal(path.basename(path.dirname(manifestPath)), 'cbq');
    assert.equal(path.basename(manifestPath), 'masterFileList.xml');
    assert.equal(fs.existsSync(manifestPath), true);
}

function testBrowserEmbedUsesOriginalGameViewport(): void {
    const server = new StaticServer();
    const contentDir = (server as any).contentDir as string;
    const indexHtml = fs.readFileSync(path.join(contentDir, 'index.html'), 'utf8');
    const rootRule = indexHtml.match(/html,\s*body\s*\{([\s\S]*?)\n    \}/);
    const containerRule = indexHtml.match(/#game-container\s*\{([\s\S]*?)\n    \}/);
    const objectRule = indexHtml.match(/#DungeonBlitz,\s*\r?\n\s*object#DungeonBlitz,\s*\r?\n\s*embed#DungeonBlitz\s*\{([\s\S]*?)\n    \}/);

    assert.ok(rootRule, 'DungeonBlitz root page CSS rule not found');
    assert.ok(containerRule, 'DungeonBlitz game-container CSS rule not found');
    assert.ok(objectRule, 'DungeonBlitz embedded object CSS rule not found');
    assert.equal(indexHtml.includes('id="game-shell"'), false, 'Flash host must not use the edge-offset shell');
    assert.equal(indexHtml.includes('id="game-stage"'), false, 'Flash host must not use the clipped edge-offset stage');
    assert.equal(/padding:\s*0\s*;/.test(rootRule[1]), true, 'DungeonBlitz root page must not reserve body edge padding');
    assert.equal(/background:\s*#484955/.test(rootRule[1]), true, 'DungeonBlitz root page must use the HUD color behind the fitted viewport');
    assert.equal(/display:\s*flex/.test(rootRule[1]), true, 'DungeonBlitz root page must center the fitted viewport');
    assert.equal(/align-items:\s*center/.test(rootRule[1]), true, 'DungeonBlitz root page must vertically center the fitted viewport');
    assert.equal(/justify-content:\s*center/.test(rootRule[1]), true, 'DungeonBlitz root page must horizontally center the fitted viewport');
    assert.equal(/width:\s*min\(100vw,\s*150vh\)/.test(containerRule[1]), true, 'DungeonBlitz game container must fit the original 3:2 game width inside the browser');
    assert.equal(/height:\s*min\(100vh,\s*66\.6667vw\)/.test(containerRule[1]), true, 'DungeonBlitz game container must fit the original 3:2 game height inside the browser');
    assert.equal(/aspect-ratio:\s*3\s*\/\s*2/.test(containerRule[1]), true, 'DungeonBlitz game container must preserve the original 3:2 aspect ratio');
    assert.equal(/width:\s*100%\s*!important/.test(objectRule[1]), true, 'DungeonBlitz object must fill the fitted viewport width');
    assert.equal(/height:\s*100%\s*!important/.test(objectRule[1]), true, 'DungeonBlitz object must fill the fitted viewport height');
    assert.equal(indexHtml.includes('top: 40px'), false, 'Flash host must not pin a top edge offset');
    assert.equal(indexHtml.includes('bottom: 70px'), false, 'Flash host must not pin a bottom edge offset');
    assert.equal(indexHtml.includes('canvas#DungeonBlitz'), false, 'Flash host must not override FlashBrowser canvas sizing');
    assert.equal(indexHtml.includes('syncGameStageSize'), false, 'Flash host must not run edge-offset canvas resync logic');
    assert.equal(/swfobject\.embedSWF\([\s\S]*"100%",\s*\r?\n\s*"100%"/.test(indexHtml), true, 'DungeonBlitz SWF must fill the centered fitted viewport');
    assert.equal(/swfobject\.embedSWF\([\s\S]*"1152",\s*\r?\n\s*"768"/.test(indexHtml), false, 'DungeonBlitz SWF must not force an oversized authored viewport in short FlashBrowser windows');
    assert.equal(indexHtml.includes('DungeonBlitz.swf?fv=cdb&gv=cdb'), true, 'Flash host must request the current cache-busted SWF URL');
    assert.equal(indexHtml.includes('{ fv: "cdb", gv: "cdb" }'), true, 'Flash vars must match the current cache-busted SWF URL');
}

function testStaticServerResolvesGameSwzLocaleFromRequest(): void {
    const server = new StaticServer();
    const queryRequest = {
        query: { lang: 'tr' },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };
    const sessionRequest = {
        query: {},
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };
    const defaultRequest = {
        query: {},
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
    };

    assert.equal((server as any).resolveGameSwzLocale(queryRequest), 'tr');
    assert.equal((server as any).resolveSwfLocale(queryRequest), 'tr');
    assert.equal((server as any).resolveGameSwzLocale(defaultRequest), 'en');
    assert.equal((server as any).resolveSwfLocale(defaultRequest), 'en');

    GlobalState.sessionsByToken.set(1, {
        socket: { remoteAddress: '127.0.0.1' },
        playerSpawned: true,
        character: { dialogueLanguage: 'tr' }
    } as never);
    try {
        assert.equal((server as any).resolveGameSwzLocale(sessionRequest), 'tr');
        assert.equal((server as any).resolveSwfLocale(sessionRequest), 'tr');
    } finally {
        GlobalState.sessionsByToken.delete(1);
    }
}

function testStaticServerBuildsLocalizedSwfTextByLocale(): void {
    const server = new StaticServer();
    const englishBody = getSwfBody((server as any).getSelectedSwfBuffer('en') as Buffer);
    const turkishBody = getSwfBody((server as any).getSelectedSwfBuffer('tr') as Buffer);
    const englishDiscipline = Buffer.from('Blessed by the Storm Gods, you draw enemy wrath', 'utf8');
    const turkishDiscipline = Buffer.from('Firtina Tanrilari tarafindan kutsanmis olarak', 'utf8');

    assert.equal(englishBody.includes(englishDiscipline), true);
    assert.equal(englishBody.includes(turkishDiscipline), false);
    assert.equal(turkishBody.includes(englishDiscipline), false);
    assert.equal(turkishBody.includes(turkishDiscipline), true);
}

function main(): void {
    testStaticServerServesSingleSwfByDefault();
    testStaticServerCanonicalizesDirectSwfVersionParams();
    testStaticServerRootServesIndexHtml();
    testStaticServerSelectsLocalizedGameSwz();
    testStaticServerAliasesVersionedGameSwzRequests();
    testStaticServerAliasesCurrentFlashVersionManifest();
    testBrowserEmbedUsesOriginalGameViewport();
    testStaticServerResolvesGameSwzLocaleFromRequest();
    testStaticServerBuildsLocalizedSwfTextByLocale();
    console.log('static_server_default_swf_regression: ok');
}

main();
