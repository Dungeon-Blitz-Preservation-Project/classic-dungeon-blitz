#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGET_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');

function parseArgs(argv) {
    const args = {
        ffdec: '',
        swf: TARGET_SWF,
        output: '',
        verify: false
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
            continue;
        }
        if (arg === '--swf' || arg === '-s') {
            args.swf = argv[++index] || '';
            continue;
        }
        if (arg === '--output' || arg === '-o') {
            args.output = argv[++index] || '';
            continue;
        }
        if (arg === '--verify' || arg === '--dry-run') {
            args.verify = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    return args;
}

function printHelp() {
    console.log([
        'Usage:',
        '  node src/server/scripts/patch-dungeonblitz-linkupdater-incremental-guard.js [--verify] [--swf <path>] [--output <path>] [--ffdec <path>]',
        '',
        'Patches LinkUpdater.method_1072 so incremental entity updates ignore entities whose',
        'movement/display state has not been fully initialized yet.'
    ].join('\n'));
}

function resolveRepoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(repoRoot, value) {
    if (!value) {
        return '';
    }
    if (path.isAbsolute(value)) {
        return value;
    }
    return path.join(repoRoot, value);
}

function detectFfdec(repoRoot, preferred) {
    const candidates = [];
    if (preferred) {
        candidates.push(resolvePath(repoRoot, preferred));
    }

    candidates.push(
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec-cli.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec-cli.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec-cli.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.0.0', 'ffdec.bat'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh'
    );

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return '';
}

function ensureFfdecHome(repoRoot) {
    const ffdecHome = path.join(repoRoot, 'build', 'ffdec-home');
    fs.mkdirSync(path.join(ffdecHome, 'Library', 'Application Support', 'FFDec', 'logs'), { recursive: true });
    return ffdecHome;
}

function runFfdec(repoRoot, ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    const basename = path.basename(resolved).toLowerCase();
    const ffdecHome = ensureFfdecHome(repoRoot);
    const env = {
        ...process.env,
        HOME: ffdecHome
    };

    if (basename.endsWith('.jar')) {
        execFileSync('java', [`-Duser.home=${ffdecHome}`, '-jar', resolved, '-cli', ...args], {
            env,
            stdio: 'inherit'
        });
        return;
    }

    execFileSync(resolved, ['-cli', ...args], {
        env,
        stdio: 'inherit'
    });
}

function replaceExact(source, needle, replacement, label) {
    if (!source.includes(needle)) {
        throw new Error(`Could not find patch marker: ${label}`);
    }

    return source.replace(needle, replacement);
}

function patchLinkUpdater(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);
    let patched = source;

    if (!patched.includes('if(!_loc3_ || !_loc3_.var_38)')) {
        patched = replaceExact(
            patched,
            join([
                '         _loc3_ = this.var_1.GetEntFromID(_loc2_);',
                '         if(!_loc3_)',
                '         {',
                '            return;',
                '         }'
            ]),
            join([
                '         _loc3_ = this.var_1.GetEntFromID(_loc2_);',
                '         if(!_loc3_ || !_loc3_.var_38)',
                '         {',
                '            return;',
                '         }'
            ]),
            'LinkUpdater.method_1072 entity movement state guard'
        );
    }

    if (!patched.includes('if(Boolean(_loc3_.gfx) && Boolean(_loc3_.gfx.m_Seq))' + eol + '               {' + eol + '                  _loc3_.BeginActive();')) {
        patched = replaceExact(
            patched,
            join([
                '            if(_loc3_.entState == Entity.const_78 && !_loc8_)',
                '            {',
                '               _loc3_.BeginActive();',
                '            }',
                '            else if(_loc3_.entState != Entity.const_78 && _loc8_)',
                '            {',
                '               _loc3_.BeginSleep();',
                '            }'
            ]),
            join([
                '            if(_loc3_.entState == Entity.const_78 && !_loc8_)',
                '            {',
                '               if(Boolean(_loc3_.gfx) && Boolean(_loc3_.gfx.m_Seq))',
                '               {',
                '                  _loc3_.BeginActive();',
                '               }',
                '            }',
                '            else if(_loc3_.entState != Entity.const_78 && _loc8_)',
                '            {',
                '               if(Boolean(_loc3_.gfx) && Boolean(_loc3_.gfx.m_Seq))',
                '               {',
                '                  _loc3_.BeginSleep();',
                '               }',
                '            }'
            ]),
            'LinkUpdater.method_1072 active/sleep animation guard'
        );
    }

    if (!patched.includes('if(Boolean(_loc3_.gfx) && Boolean(_loc3_.gfx.m_TheDO))')) {
        patched = replaceExact(
            patched,
            join([
                '         if(_loc3_.var_38.var_1667)',
                '         {',
                '            _loc3_.var_38.var_1667 = false;',
                '            _loc3_.var_38.var_556 = true;',
                '            _loc3_.gfx.m_TheDO.visible = true;',
                '         }'
            ]),
            join([
                '         if(_loc3_.var_38.var_1667)',
                '         {',
                '            _loc3_.var_38.var_1667 = false;',
                '            _loc3_.var_38.var_556 = true;',
                '            if(Boolean(_loc3_.gfx) && Boolean(_loc3_.gfx.m_TheDO))',
                '            {',
                '               _loc3_.gfx.m_TheDO.visible = true;',
                '            }',
                '         }'
            ]),
            'LinkUpdater.method_1072 display object guard'
        );
    }

    return patched;
}

function patchSwf(repoRoot, ffdecPath, swfPath, outputPath, verify) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-linkupdater-incremental-guard');
    const scriptsRoot = path.join(workRoot, 'scripts');
    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);

    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(repoRoot, ffdecPath, ['-selectclass', 'LinkUpdater', '-export', 'script', workRoot, swfPath]);

    const linkUpdaterPath = path.join(scriptsRoot, 'LinkUpdater.as');
    if (!fs.existsSync(linkUpdaterPath)) {
        throw new Error(`FFDec export did not produce ${linkUpdaterPath}`);
    }

    const original = fs.readFileSync(linkUpdaterPath, 'utf8');
    const patched = patchLinkUpdater(original);
    if (patched === original) {
        console.log(`SWF already contains LinkUpdater incremental guard patch: ${swfPath}`);
        return;
    }

    console.log('Patch: LinkUpdater.method_1072 guards incomplete entity movement/display state.');
    if (verify) {
        return;
    }

    fs.writeFileSync(linkUpdaterPath, patched, 'utf8');
    runFfdec(repoRoot, ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsRoot]);
    fs.copyFileSync(patchedSwfPath, outputPath);
    console.log(`Patched SWF written to ${outputPath}`);
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
    const swfPath = resolvePath(repoRoot, args.swf);
    const outputPath = resolvePath(repoRoot, args.output || args.swf);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);

    if (!fs.existsSync(swfPath)) {
        throw new Error(`SWF not found: ${swfPath}`);
    }
    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or restore the repo-bundled FFDec app.');
    }

    patchSwf(repoRoot, ffdecPath, swfPath, outputPath, args.verify);
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
