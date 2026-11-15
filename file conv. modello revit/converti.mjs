// Converte e ottimizza un modello Revit (OBJ / FBX / GLB / GLTF) per il viewer VR.
// Uso: node converti.mjs "percorso\modello.obj"   (di solito lo lancia converti-modello.bat)
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const input = process.argv[2];
const upAxis = (process.env.UPAXIS || 'Y').toUpperCase();   // Y oppure Z
const texSize = process.env.TEXSIZE || '2048';
const rot = ['ROTX', 'ROTY', 'ROTZ'].map(k => parseFloat(process.env[k]) || 0);   // gradi
const isWin = process.platform === 'win32';

if (!input || !existsSync(input)) { console.error('File non trovato: ' + input); process.exit(1); }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin && cmd === 'npm', ...opts });
  if (r.status !== 0) { console.error('\nERRORE nel comando: ' + cmd + ' ' + args.join(' ')); process.exit(1); }
}

// 1) installazione strumenti (solo la prima volta, nella cartella dello script)
if (!existsSync(path.join(here, 'node_modules', 'obj2gltf')) ||
    !existsSync(path.join(here, 'node_modules', 'fbx2gltf')) ||
    !existsSync(path.join(here, 'node_modules', '@gltf-transform', 'cli'))) {
  console.log('Prima esecuzione: installo gli strumenti (serve internet, un paio di minuti)...\n');
  if (existsSync(path.join(here, 'package.json'))) {
    // reinstalla esattamente le versioni gia' provate (package.json + package-lock.json)
    run('npm', ['install', '--no-audit', '--no-fund'], { cwd: here });
  } else {
    run('npm', ['init', '-y', '--silent'], { cwd: here });
    run('npm', ['install', 'obj2gltf', 'fbx2gltf', '@gltf-transform/cli', '--no-audit', '--no-fund'], { cwd: here });
  }
}

const ext = path.extname(input).toLowerCase();
const dir = path.dirname(path.resolve(input));
const base = path.basename(input, path.extname(input));
const tmp = path.join(dir, base + '__tmp.glb');
const out = path.join(dir, base + '_quest.glb');
let source = input;

// 2) conversione in GLB (i colori e i materiali del file MTL / FBX vengono mantenuti)
if (ext === '.obj') {
  console.log('Converto OBJ -> GLB (asse verticale: ' + upAxis + ')...');
  run(process.execPath, [path.join(here, 'node_modules', 'obj2gltf', 'bin', 'obj2gltf.js'),
    '-i', path.resolve(input), '-o', tmp, '--binary', '--inputUpAxis', upAxis, '--outputUpAxis', 'Y']);
  source = tmp;
} else if (ext === '.fbx') {
  console.log('Converto FBX -> GLB...');
  const convert = createRequire(import.meta.url)(path.join(here, 'node_modules', 'fbx2gltf'));
  try { await convert(path.resolve(input), tmp); }
  catch (e) { console.error('ERRORE conversione FBX: ' + (e && e.message || e)); process.exit(1); }
  source = tmp;
} else if (ext !== '.glb' && ext !== '.gltf') {
  console.error('Formato non supportato: ' + ext + ' (usa .obj, .fbx, .glb o .gltf)'); process.exit(1);
}

// 2b) rotazione del modello (es. Revit usa Z verso l'alto: ROTX=-90 lo raddrizza)
let toRotate = null;
if (rot.some(v => v !== 0)) {
  console.log('\nApplico la rotazione X/Y/Z = ' + rot.join(' / ') + ' gradi...');
  const req = createRequire(path.join(here, 'noop.js'));
  const { NodeIO } = req('@gltf-transform/core');
  const { KHRDracoMeshCompression } = req('@gltf-transform/extensions');
  const draco3d = req('draco3dgltf');
  const io = new NodeIO().registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
  const doc = await io.read(source);
  doc.getRoot().listExtensionsUsed().forEach(e => { if (e.extensionName === 'KHR_draco_mesh_compression') e.dispose(); });
  const d = Math.PI / 180;
  const q = (ax, a) => { const h = a * d / 2, s = Math.sin(h); return [ax[0]*s, ax[1]*s, ax[2]*s, Math.cos(h)]; };
  const mul = (a, b) => [
    a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
    a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
    a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
    a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2]];
  const quat = mul(mul(q([1,0,0], rot[0]), q([0,1,0], rot[1])), q([0,0,1], rot[2]));
  for (const scene of doc.getRoot().listScenes()) {
    const root = doc.createNode('RotazioneModello').setRotation(quat);
    for (const c of scene.listChildren()) { scene.removeChild(c); root.addChild(c); }
    scene.addChild(root);
  }
  toRotate = path.join(dir, base + '__rot.glb');
  await io.write(toRotate, doc);
  source = toRotate;
}

// 3) ottimizzazione per il Quest
console.log('\nOttimizzo per il Quest...');
run(process.execPath, [path.join(here, 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js'),
  'optimize', source, out,
  '--compress', 'draco', '--instance', 'false', '--sparse', 'false',
  '--palette', 'false', '--simplify', 'false', '--texture-size', texSize]);

if (existsSync(tmp)) unlinkSync(tmp);
if (toRotate && existsSync(toRotate)) unlinkSync(toRotate);
console.log('\nFATTO. File creato:\n' + out);
