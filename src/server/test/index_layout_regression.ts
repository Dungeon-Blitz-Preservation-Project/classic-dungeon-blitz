import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function resolveIndexPath(): string {
    const candidates = [
        path.resolve(__dirname, '../../client/content/localhost/index.html'),
        path.resolve(__dirname, '../../../client/content/localhost/index.html'),
        path.resolve(process.cwd(), 'src/client/content/localhost/index.html'),
        path.resolve(process.cwd(), '../client/content/localhost/index.html')
    ];

    const found = candidates.find((candidate) => fs.existsSync(candidate));
    assert.ok(found, 'localhost index.html should exist');
    return found;
}

function main(): void {
    const indexHtml = fs.readFileSync(resolveIndexPath(), 'utf8');
    const rootRule = indexHtml.match(/html,\s*body\s*\{([\s\S]*?)\n    \}/);
    const containerRule = indexHtml.match(/#game-container\s*\{([\s\S]*?)\n    \}/);
    const objectRule = indexHtml.match(/#DungeonBlitz,\s*\r?\n\s*object#DungeonBlitz,\s*\r?\n\s*embed#DungeonBlitz\s*\{([\s\S]*?)\n    \}/);

    assert.ok(rootRule, 'DungeonBlitz root page CSS rule not found');
    assert.ok(containerRule, 'DungeonBlitz game-container CSS rule not found');
    assert.ok(objectRule, 'DungeonBlitz embedded object CSS rule not found');
    assert.equal(indexHtml.includes('id="game-shell"'), false, 'Flash host should not wrap the game in a scaled shell');
    assert.equal(indexHtml.includes('transform: scale('), false, 'Flash host should not browser-scale the SWF');
    assert.equal(indexHtml.includes('layout=fit-center-buffer'), false, 'Flash host should not request the fit-center-buffer layout');
    assert.equal(/background:\s*#484955/.test(rootRule[1]), true, 'Flash host should use the chosen HUD/page background color');
    assert.equal(/display:\s*flex/.test(rootRule[1]), true, 'Flash host should center the fitted game viewport');
    assert.equal(/align-items:\s*center/.test(rootRule[1]), true, 'Flash host should vertically center the fitted game viewport');
    assert.equal(/justify-content:\s*center/.test(rootRule[1]), true, 'Flash host should horizontally center the fitted game viewport');
    assert.equal(/width:\s*min\(100vw,\s*150vh\)/.test(containerRule[1]), true, 'Flash host should fit the original 3:2 game width inside the browser');
    assert.equal(/height:\s*min\(100vh,\s*66\.6667vw\)/.test(containerRule[1]), true, 'Flash host should fit the original 3:2 game height inside the browser');
    assert.equal(/aspect-ratio:\s*3\s*\/\s*2/.test(containerRule[1]), true, 'Flash host should preserve the original game aspect ratio');
    assert.equal(/width:\s*100%\s*!important/.test(objectRule[1]), true, 'Embedded Flash object should fill the fitted game viewport width');
    assert.equal(/height:\s*100%\s*!important/.test(objectRule[1]), true, 'Embedded Flash object should fill the fitted game viewport height');
    assert.equal(indexHtml.includes('"100%",'), true, 'Flash host should embed the SWF at 100% inside the fitted game viewport');
    assert.equal(indexHtml.includes('"1152",'), false, 'Flash host should not force the embedded object to a fixed authored width');
    assert.equal(indexHtml.includes('"768",'), false, 'Flash host should not force the embedded object to a fixed authored height');
    assert.equal(
        indexHtml.includes('p/cbp/DungeonBlitz.swf?fv=cbx&gv=cbv'),
        true,
        'Flash host should still request the current DungeonBlitz.swf version'
    );

    console.log('index_layout_regression: ok');
}

main();
