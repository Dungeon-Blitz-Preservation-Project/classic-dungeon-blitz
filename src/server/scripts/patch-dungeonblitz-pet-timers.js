#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_SWF = path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const TRAINING_TIMES_ZERO = '[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]';
const EGG_MAX_SECONDS = 604800;

function parseArgs(argv) {
    const args = {
        swf: DEFAULT_SWF,
        ffdec: '',
        verify: false
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--swf') {
            args.swf = argv[++index] || '';
        } else if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
        } else if (arg === '--verify') {
            args.verify = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log([
                'Usage:',
                '  node src/server/scripts/patch-dungeonblitz-pet-timers.js [--verify] [--swf <path>] [--ffdec <path>]',
                '',
                'Patches DungeonBlitz.swf pet timer constants:',
                '  class_7.const_797 training times => all zero',
                `  class_16.const_907 egg max hatch time => ${EGG_MAX_SECONDS}s`
            ].join('\n'));
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return args;
}

function detectFfdec(repoRoot, explicitPath) {
    const candidates = [
        explicitPath,
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec-cli.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec-cli.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar'
    ].filter(Boolean);

    return candidates.find((candidate) => fs.existsSync(path.resolve(candidate))) || '';
}

function ensureFfdecHome(repoRoot) {
    const ffdecHome = path.join(repoRoot, 'build', 'ffdec-home');
    fs.mkdirSync(path.join(ffdecHome, 'Library', 'Application Support', 'FFDec', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(ffdecHome, 'JPEXS', 'FFDec', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(ffdecHome, 'LocalAppData'), { recursive: true });
    return ffdecHome;
}

function runFfdec(repoRoot, ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    const ffdecHome = ensureFfdecHome(repoRoot);
    const env = {
        ...process.env,
        APPDATA: ffdecHome,
        HOME: ffdecHome,
        LOCALAPPDATA: path.join(ffdecHome, 'LocalAppData'),
        USERPROFILE: ffdecHome
    };

    if (resolved.endsWith('.jar')) {
        execFileSync('java', [`-Duser.home=${ffdecHome}`, '-jar', resolved, '-cli', ...args], { env, stdio: 'inherit' });
        return;
    }

    execFileSync(resolved, ['-cli', ...args], { env, stdio: 'inherit' });
}

function exportScripts(repoRoot, ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(repoRoot, ffdecPath, ['-selectclass', 'class_7,class_16', '-export', 'script', workRoot, swfPath]);
    const scriptsRoot = path.join(workRoot, 'scripts');
    for (const className of ['class_7', 'class_16']) {
        const classPath = path.join(scriptsRoot, `${className}.as`);
        if (!fs.existsSync(classPath)) {
            throw new Error(`FFDec export did not produce ${classPath}`);
        }
    }
    return scriptsRoot;
}

function patchClass7(source) {
    return source.replace(
        /public static const const_797:Array = \[[^\]]+\];/,
        `public static const const_797:Array = ${TRAINING_TIMES_ZERO};`
    );
}

function patchClass16(source) {
    return source.replace(
        /public static const const_907:uint = \d+;/,
        `public static const const_907:uint = ${EGG_MAX_SECONDS};`
    );
}

function verifySources(scriptsRoot) {
    const class7 = fs.readFileSync(path.join(scriptsRoot, 'class_7.as'), 'utf8');
    const class16 = fs.readFileSync(path.join(scriptsRoot, 'class_16.as'), 'utf8');

    if (!class7.includes(`public static const const_797:Array = ${TRAINING_TIMES_ZERO};`)) {
        throw new Error('class_7.const_797 is not patched to zero training times');
    }
    if (!class16.includes(`public static const const_907:uint = ${EGG_MAX_SECONDS};`)) {
        throw new Error(`class_16.const_907 is not patched to ${EGG_MAX_SECONDS}`);
    }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-pet-timers');
    const scriptsRoot = exportScripts(repoRoot, ffdecPath, workRoot, swfPath);
    const class7Path = path.join(scriptsRoot, 'class_7.as');
    const class16Path = path.join(scriptsRoot, 'class_16.as');

    fs.writeFileSync(class7Path, patchClass7(fs.readFileSync(class7Path, 'utf8')), 'utf8');
    fs.writeFileSync(class16Path, patchClass16(fs.readFileSync(class16Path, 'utf8')), 'utf8');
    verifySources(scriptsRoot);

    const patchedSwfPath = `${swfPath}.patched`;
    fs.rmSync(patchedSwfPath, { force: true });
    runFfdec(repoRoot, ffdecPath, ['-importScript', swfPath, patchedSwfPath, scriptsRoot]);
    fs.renameSync(patchedSwfPath, swfPath);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(repoRoot, 'build', 'ffdec-dungeonblitz-pet-timers-verify');
    const scriptsRoot = exportScripts(repoRoot, ffdecPath, workRoot, swfPath);
    verifySources(scriptsRoot);
}

function main() {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const args = parseArgs(process.argv.slice(2));
    const swfPath = path.resolve(repoRoot, args.swf);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);

    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    }
    if (!fs.existsSync(swfPath)) {
        throw new Error(`SWF not found: ${swfPath}`);
    }

    if (!args.verify) {
        patchSwf(repoRoot, ffdecPath, swfPath);
    }
    verifySwf(repoRoot, ffdecPath, swfPath);
    console.log(`${args.verify ? 'Verified' : 'Patched'} DungeonBlitz pet timers in ${swfPath}`);
}

main();
