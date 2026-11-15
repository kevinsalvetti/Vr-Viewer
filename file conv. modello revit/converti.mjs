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

// 2b) porte apribili + rotazione del modello
const req = createRequire(path.join(here, 'noop.js'));
const { NodeIO } = req('@gltf-transform/core');
const { KHRDracoMeshCompression } = req('@gltf-transform/extensions');
const draco3d = req('draco3dgltf');
const io = new NodeIO().registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
const doc = await io.read(source);
doc.getRoot().listExtensionsUsed().forEach(e => { if (e.extensionName === 'KHR_draco_mesh_compression') e.dispose(); });

// Porte: i gruppi il cui nome contiene uno dei tipi in PORTE; l'anta e' la parte col materiale ANTA.
// Ogni anta diventa un oggetto separato "PORTA:<nome>" con le informazioni per farla ruotare nel viewer.
const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
const doorTypes = norm(process.env.PORTE ?? '80x210').split(',').filter(t => t && t !== 'nessuna');
const leafMat = norm(process.env.ANTA ?? 'ante');
let doors = 0;
const doorNodes = new Set();
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh || !doorTypes.some(t => norm(node.getName()).includes(t))) continue;
  for (const prim of mesh.listPrimitives()) {
    if (!norm(prim.getMaterial() && prim.getMaterial().getName()).includes(leafMat)) continue;
    const pos = prim.getAttribute('POSITION'), cnt = pos.getCount(), v = [0, 0, 0];
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < cnt; i++) { pos.getElement(i, v); for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]); } }
    const ext = mx.map((x, k) => x - mn[k]);
    const up = ext.indexOf(Math.max(...ext));              // l'altezza e' la dimensione maggiore
    const [a, b] = [0, 1, 2].filter(k => k !== up);
    // direzione della larghezza nel piano orizzontale (analisi delle componenti principali, vale anche per muri inclinati)
    let ma = 0, mb = 0; for (let i = 0; i < cnt; i++) { pos.getElement(i, v); ma += v[a]; mb += v[b]; } ma /= cnt; mb /= cnt;
    let caa = 0, cbb = 0, cab = 0;
    for (let i = 0; i < cnt; i++) { pos.getElement(i, v); const x = v[a] - ma, y = v[b] - mb; caa += x * x; cbb += y * y; cab += x * y; }
    const phi = 0.5 * Math.atan2(2 * cab, caa - cbb), w2 = [Math.cos(phi), Math.sin(phi)], n2 = [-w2[1], w2[0]];
    let w0 = Infinity, w1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (let i = 0; i < cnt; i++) {
      pos.getElement(i, v);
      const pw = v[a] * w2[0] + v[b] * w2[1], pn = v[a] * n2[0] + v[b] * n2[1];
      w0 = Math.min(w0, pw); w1 = Math.max(w1, pw); t0 = Math.min(t0, pn); t1 = Math.max(t1, pn);
    }
    const cw = (w0 + w1) / 2, cn = (t0 + t1) / 2, c = [0, 0, 0], wdir = [0, 0, 0], updir = [0, 0, 0];
    c[a] = cw * w2[0] + cn * n2[0]; c[b] = cw * w2[1] + cn * n2[1]; c[up] = mn[up];
    wdir[a] = w2[0]; wdir[b] = w2[1]; updir[up] = 1;
    // sposta i vertici dell'anta attorno al suo centro (in basso), cosi' il nodo puo' ruotare
    const p2 = pos.clone();
    for (let i = 0; i < cnt; i++) { pos.getElement(i, v); p2.setElement(i, [v[0] - c[0], v[1] - c[1], v[2] - c[2]]); }
    const leaf = prim.clone().setAttribute('POSITION', p2);
    const name = 'PORTA:' + node.getName();
    const door = doc.createNode(name).setTranslation(c)
      .setMesh(doc.createMesh(name).addPrimitive(leaf))
      .setExtras({ porta: true, asse: updir, larghezza: wdir, meta: (w1 - w0) / 2 });
    node.addChild(door);
    doorNodes.add(door);
    mesh.removePrimitive(prim);
    doors++;
  }
  if (!mesh.listPrimitives().length) { node.setMesh(null); mesh.dispose(); }
}
// solo le porte tengono il nome: tutto il resto puo' essere unito per alleggerire il modello
for (const n of doc.getRoot().listNodes()) if (!doorNodes.has(n)) { n.setName(''); if (n.getMesh()) n.getMesh().setName(''); }
console.log('\nPorte apribili trovate: ' + doors + (doors ? '' : '  (controlla PORTE in converti-modello.bat)'));

{
  const d = Math.PI / 180;
  const q = (ax, a) => { const h = a * d / 2, s = Math.sin(h); return [ax[0]*s, ax[1]*s, ax[2]*s, Math.cos(h)]; };
  const mul = (a, b) => [
    a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
    a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
    a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
    a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2]];
  const quat = mul(mul(q([1,0,0], rot[0]), q([0,1,0], rot[1])), q([0,0,1], rot[2]));
  if (rot.some(v => v !== 0)) {
    console.log('Applico la rotazione X/Y/Z = ' + rot.join(' / ') + ' gradi...');
    for (const scene of doc.getRoot().listScenes()) {
      const root = doc.createNode('').setRotation(quat);
      for (const c of scene.listChildren()) { scene.removeChild(c); root.addChild(c); }
      scene.addChild(root);
    }
  }
}
const toRotate = path.join(dir, base + '__rot.glb');
await io.write(toRotate, doc);
source = toRotate;

// 3) ottimizzazione per il Quest (--join-named false: le porte restano oggetti separati)
console.log('\nOttimizzo per il Quest...');
run(process.execPath, [path.join(here, 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js'),
  'optimize', source, out,
  '--compress', 'draco', '--instance', 'false', '--sparse', 'false', '--join-named', 'false',
  '--palette', 'false', '--simplify', 'false', '--texture-size', texSize]);

if (existsSync(tmp)) unlinkSync(tmp);
if (toRotate && existsSync(toRotate)) unlinkSync(toRotate);
console.log('\nFATTO. File creato:\n' + out);
