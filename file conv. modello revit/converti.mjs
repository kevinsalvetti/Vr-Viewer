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
// Porte scorrevoli: i gruppi il cui nome contiene uno dei tipi in SCORREVOLI; l'anta e' riconosciuta dalla
// forma (lastra sottile e alta), perche' spesso Revit non le da' un materiale proprio.
const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
const typeList = (v, def) => norm(v ?? def).split(',').filter(t => t && t !== 'nessuna');
const doorTypes = typeList(process.env.PORTE, '80x210,90x210');
const slideTypes = typeList(process.env.SCORREVOLI, '100x210');
const leafMat = norm(process.env.ANTA ?? 'ante');
const isType = (node, list) => list.some(t => norm(node.getName()).includes(t));

// misure di un pezzo: altezza (asse maggiore), direzione della larghezza nel piano orizzontale
// (componenti principali: vale anche per muri inclinati), spessore, centro in basso
function measure(prims){
  const v = [0, 0, 0], mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const each = f => { for (const p of prims) { const pos = p.getAttribute('POSITION'); for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); f(v); } } };
  let cnt = 0;
  each(v => { cnt++; for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]); } });
  const ext = mx.map((x, k) => x - mn[k]);
  const up = ext.indexOf(Math.max(...ext));
  const [a, b] = [0, 1, 2].filter(k => k !== up);
  let ma = 0, mb = 0; each(v => { ma += v[a]; mb += v[b]; }); ma /= cnt; mb /= cnt;
  let caa = 0, cbb = 0, cab = 0;
  each(v => { const x = v[a] - ma, y = v[b] - mb; caa += x * x; cbb += y * y; cab += x * y; });
  const phi = 0.5 * Math.atan2(2 * cab, caa - cbb), w2 = [Math.cos(phi), Math.sin(phi)], n2 = [-w2[1], w2[0]];
  let w0 = Infinity, w1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  each(v => {
    const pw = v[a] * w2[0] + v[b] * w2[1], pn = v[a] * n2[0] + v[b] * n2[1];
    w0 = Math.min(w0, pw); w1 = Math.max(w1, pw); t0 = Math.min(t0, pn); t1 = Math.max(t1, pn);
  });
  const cw = (w0 + w1) / 2, cn = (t0 + t1) / 2, c = [0, 0, 0], wdir = [0, 0, 0], updir = [0, 0, 0];
  c[a] = cw * w2[0] + cn * n2[0]; c[b] = cw * w2[1] + cn * n2[1]; c[up] = mn[up];
  wdir[a] = w2[0]; wdir[b] = w2[1]; updir[up] = 1;
  return { mn, mx, height: ext[up], width: w1 - w0, thick: t1 - t0, c, wdir, updir };
}

// crea il nodo dell'anta (vertici spostati attorno al centro in basso, cosi' il viewer puo' muoverla)
function makeLeaf(node, prims, name, m, extras){
  const mesh = doc.createMesh(name);
  for (const prim of prims) {
    const pos = prim.getAttribute('POSITION'), p2 = pos.clone(), v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); p2.setElement(i, [v[0] - m.c[0], v[1] - m.c[1], v[2] - m.c[2]]); }
    mesh.addPrimitive(prim.clone().setAttribute('POSITION', p2));
    node.getMesh().removePrimitive(prim);
  }
  const door = doc.createNode(name).setTranslation(m.c).setMesh(mesh).setExtras(extras);
  node.addChild(door);
  doorNodes.add(door);
  if (!node.getMesh().listPrimitives().length) { const old = node.getMesh(); node.setMesh(null); old.dispose(); }
}

let doors = 0, slides = 0;
const doorNodes = new Set();
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh || !isType(node, doorTypes)) continue;
  for (const prim of mesh.listPrimitives()) {
    if (!norm(prim.getMaterial() && prim.getMaterial().getName()).includes(leafMat)) continue;
    const m = measure([prim]);
    makeLeaf(node, [prim], 'PORTA:' + node.getName(), m,
      { porta: true, asse: m.updir, larghezza: m.wdir, meta: m.width / 2 });
    doors++;
    if (!node.getMesh()) break;
  }
}

// Scorrevoli: l'anta e' il pezzo sottile (<= 6 cm) e alto (>= 1,5 m) del tipo; gli altri pezzi della stessa
// porta (telai) sono quelli vicini. L'anta scorre verso il lato in cui sporge oltre i telai (la "tasca" nel muro).
const slideParts = doc.getRoot().listNodes().filter(n => n.getMesh() && isType(n, slideTypes))
  .map(n => ({ node: n, m: measure(n.getMesh().listPrimitives()) }));
const near = (p, q, pad) => [0, 1, 2].every(k => p.m.mn[k] - pad <= q.m.mx[k] && q.m.mn[k] - pad <= p.m.mx[k]);
const isSlideLeaf = m => m.thick <= 0.06 && m.height >= 1.5 && m.width >= 0.5;
for (const p of slideParts) {
  const m = p.m;
  if (!isSlideLeaf(m)) continue;
  const proj = x => x[0] * m.wdir[0] + x[1] * m.wdir[1] + x[2] * m.wdir[2];
  const others = slideParts.filter(q => q !== p && !isSlideLeaf(q.m) && near(p, q, 0.3));
  let side = 1, travel = m.width * 0.9;
  if (others.length) {                                   // telai lungo la larghezza dell'anta
    let lo = Infinity, hi = -Infinity;
    for (const q of others) for (const x of [q.m.mn, q.m.mx]) { const s = proj(x); lo = Math.min(lo, s); hi = Math.max(hi, s); }
    const leafMid = proj(m.c), frameMid = (lo + hi) / 2;
    if (Math.abs(leafMid - frameMid) > 0.02) side = Math.sign(leafMid - frameMid);
    // aperta: il bordo dell'anta si ferma 12 cm prima del bordo del telaio dal lato della tasca,
    // cosi' resta un pezzetto visibile (nel modello Revit l'anta puo' essere gia' un po' dentro il muro)
    const leafBack = side > 0 ? leafMid - m.width / 2 : -(leafMid + m.width / 2);
    const frameEdge = side > 0 ? hi : -lo;
    travel = Math.min(Math.max(frameEdge - 0.12 - leafBack, m.width * 0.3), m.width);
  }
  const id = slides;
  makeLeaf(p.node, p.node.getMesh().listPrimitives(), 'SCORREVOLE:' + p.node.getName(), m,
    { porta: 'scorrevole', portaId: id, larghezza: m.wdir.map(x => x * side), corsa: +travel.toFixed(3) });
  // i telai restano oggetti separati: puntandoli si apre/chiude la porta (comodo quando e' aperta)
  for (const q of others) if (!doorNodes.has(q.node)) {
    q.node.setName('TELAIO:' + p.node.getName()).setExtras({ telaioDi: id }); doorNodes.add(q.node);
  }
  slides++;
}

// solo le porte tengono il nome: tutto il resto puo' essere unito per alleggerire il modello
for (const n of doc.getRoot().listNodes()) if (!doorNodes.has(n)) { n.setName(''); if (n.getMesh()) n.getMesh().setName(''); }
console.log('\nPorte apribili trovate: ' + doors + (doors ? '' : '  (controlla PORTE in converti-modello.bat)') +
  '\nPorte scorrevoli trovate: ' + slides + (slides ? '' : '  (controlla SCORREVOLI in converti-modello.bat)'));

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
