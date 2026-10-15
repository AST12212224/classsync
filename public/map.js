import * as THREE from '/vendor/three/three.module.js';

// ---- the clash rule, same as backend/schedule.js ----
// A hold or class is one vector (room id, 15-minute block, floor) per block it covers.
var STEP = 15;
var mins = function (t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); };
function blocks(from, to) {
  var a = Math.floor(mins(from) / STEP), b = Math.ceil(mins(to) / STEP), out = [];
  for (var i = a; i < b; i++) out.push(i);
  return out;
}
var cross = function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; };
var len2 = function (a) { return a[0] * a[0] + a[1] * a[1] + a[2] * a[2]; };
var vectors = function (room, floor, list) { return list.map(function (t) { return [room, t, floor]; }); };
// First pair (a from A, b from B) that clashes, or null.
function clashPair(A, B) {
  for (var i = 0; i < A.length; i++) for (var j = 0; j < B.length; j++) {
    if (cross(A[i], B[j]).every(function (c) { return c === 0; }) && len2(A[i]) === len2(B[j])) return [A[i], B[j]];
  }
  return null;
}
var vtext = function (v) { return '(' + v.join(', ') + ')'; };
var blockTime = function (b) { var m = b * STEP; return t12((m / 60 < 10 ? '0' : '') + (m / 60 | 0) + ':' + (m % 60 < 10 ? '0' : '') + m % 60); };

// ---- state ----
var data = null, rooms = {}, focus = '', showVec = true, selected = null, probe = null;
var RX = 2.2, FY = 2.6, TZ = 0.5, DAY0 = 8 * 60, DAY_END = 18 * 60;
var px = function (r) { return r.index * RX; };
var py = function (f) { return f.level * FY; };
var pz = function (t) { return (mins(t) - DAY0) / STEP * TZ; };
var ZEND = (DAY_END - DAY0) / STEP * TZ;
var key = function (x) { return x.kind + ':' + x.id; };
var holding = function (x) { return !x.freed_by; };
function itemVectors(x) { var r = rooms[x.room_id]; return vectors(r.id, r.floor.level, blocks(x.from, x.to)); }
function kindLabel(x) { return x.freed_by ? 'Class freed today' : x.kind === 'class' ? 'Timetabled class' : 'Hold'; }
function itemLine(x) {
  var r = rooms[x.room_id];
  return r.name + ' · ' + r.floor.name + ' · ' + t12(x.from) + '–' + t12(x.to);
}

// ---- colors follow the page theme ----
var css = {};
function readColors() {
  var s = getComputedStyle(document.documentElement);
  ['--bg', '--card', '--ink', '--mut', '--line', '--free', '--occ', '--focus', '--cls'].forEach(function (k) { css[k] = s.getPropertyValue(k).trim(); });
}
function kindColor(x) { return x.freed_by ? css['--free'] : x.kind === 'class' ? css['--cls'] : css['--occ']; }

// ---- three.js scene ----
var canvas = $('scene'), wrap = $('wrap');
var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
var scene = new THREE.Scene(), world = new THREE.Group(), pickable = [];
scene.add(world);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2));
var sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(-10, 30, -20); scene.add(sun);
var camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);

var pending = false;
function draw() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(function () { pending = false; renderer.render(scene, camera); });
}
new ResizeObserver(function () {
  var w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); draw();
}).observe(wrap);

// orbit camera: drag turns, wheel or pinch zooms
var view = { target: new THREE.Vector3(), r: 40, theta: -0.75, phi: 1.05 };
function placeCamera() {
  view.phi = Math.min(Math.max(view.phi, 0.15), Math.PI / 2 - 0.02);
  view.r = Math.min(Math.max(view.r, 4), 160);
  camera.position.setFromSphericalCoords(view.r, view.phi, view.theta).add(view.target);
  camera.lookAt(view.target); draw();
}
var home = null;
function frame(box) {
  var size = box.getSize(new THREE.Vector3());
  var fit = Math.min(camera.aspect || 1, 1.4); // tall phone screens need to stand further back
  home = { target: box.getCenter(new THREE.Vector3()), r: Math.max(size.x, size.y, size.z) * 1.35 / fit + 6 };
  resetView();
}
function resetView() {
  view.target.copy(home.target); view.r = home.r; view.theta = -0.75; view.phi = 1.05; placeCamera();
}
var ptrs = {}, drag = null;
canvas.addEventListener('pointerdown', function (e) {
  canvas.setPointerCapture(e.pointerId); ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
  drag = { x: e.clientX, y: e.clientY, moved: 0, pinch: null };
  canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', function (e) {
  var ids = Object.keys(ptrs);
  if (!drag || !ptrs[e.pointerId]) return hover(e);
  var p = ptrs[e.pointerId], dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
  if (ids.length === 2) { // pinch zoom
    var a = ptrs[ids[0]], b = ptrs[ids[1]], d = Math.hypot(a.x - b.x, a.y - b.y);
    if (drag.pinch) view.r *= drag.pinch / d;
    drag.pinch = d;
  } else {
    view.theta -= dx * 0.008; view.phi -= dy * 0.008;
  }
  $('tip').hidden = true; placeCamera();
});
function endPointer(e) {
  if (!ptrs[e.pointerId]) return;
  delete ptrs[e.pointerId];
  if (Object.keys(ptrs).length) return;
  if (drag && drag.moved < 6 && e.type === 'pointerup') pick(e);
  drag = null; canvas.style.cursor = '';
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', function () { if (!drag) $('tip').hidden = true; });
canvas.addEventListener('wheel', function (e) { e.preventDefault(); view.r *= Math.exp(e.deltaY * 0.001); placeCamera(); }, { passive: false });
canvas.addEventListener('keydown', function (e) {
  var k = { ArrowLeft: [0.1, 0], ArrowRight: [-0.1, 0], ArrowUp: [0, -0.08], ArrowDown: [0, 0.08] }[e.key];
  if (k) { view.theta += k[0]; view.phi += k[1]; }
  else if (e.key === '+' || e.key === '=') view.r *= 0.9;
  else if (e.key === '-') view.r *= 1.1;
  else return;
  e.preventDefault(); placeCamera();
});

var ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function hit(e) {
  var b = canvas.getBoundingClientRect();
  ndc.set((e.clientX - b.left) / b.width * 2 - 1, -(e.clientY - b.top) / b.height * 2 + 1);
  ray.setFromCamera(ndc, camera);
  var h = ray.intersectObjects(pickable)[0];
  return h ? h.object.userData.item : null;
}
function hover(e) {
  var x = hit(e), tip = $('tip');
  canvas.style.cursor = x ? 'pointer' : '';
  if (!x) { tip.hidden = true; return; }
  var b = wrap.getBoundingClientRect();
  tip.textContent = '';
  tip.appendChild(el('b', null, itemLine(x)));
  tip.appendChild(el('div', null, kindLabel(x) + (x.faculty ? ' · ' + x.faculty : '')));
  tip.hidden = false;
  tip.style.left = Math.min(e.clientX - b.left + 14, b.width - tip.offsetWidth - 8) + 'px';
  tip.style.top = Math.min(e.clientY - b.top + 14, b.height - tip.offsetHeight - 8) + 'px';
}
function pick(e) { var x = hit(e); select(x && selected && key(x) === key(selected) ? null : x); }

// ---- building the world ----
function clearWorld() {
  world.traverse(function (o) {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
  });
  world.clear(); pickable = [];
}
function label(text, size, color, pos) {
  var c = document.createElement('canvas'), g = c.getContext('2d'), font = '600 40px system-ui, -apple-system, sans-serif';
  g.font = font; c.width = Math.ceil(g.measureText(text).width) + 16; c.height = 56;
  g.font = font; g.fillStyle = color; g.textBaseline = 'middle'; g.fillText(text, 8, 29);
  var tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(size * c.width / c.height, size, 1); s.position.copy(pos);
  world.add(s); return s;
}
function lines(points, color, opacity) {
  var g = new THREE.BufferGeometry().setFromPoints(points);
  var m = new THREE.LineBasicMaterial({ color: color, transparent: opacity < 1, opacity: opacity });
  world.add(new THREE.LineSegments(g, m));
}
function arrow(tip, color, opacity, head) {
  var len = tip.length();
  if (len < 0.01) return;
  var a = new THREE.ArrowHelper(tip.clone().normalize(), new THREE.Vector3(), len, color, head || 0.6, (head || 0.6) * 0.55);
  [a.line.material, a.cone.material].forEach(function (m) { m.transparent = opacity < 1; m.opacity = opacity; });
  world.add(a);
}
function box(x, color, solid) {
  var r = rooms[x.room_id], z0 = pz(x.from), z1 = pz(x.to);
  var geo = new THREE.BoxGeometry(1.05, 0.8, Math.max(z1 - z0 - 0.06, 0.1));
  var mat = solid
    ? new THREE.MeshStandardMaterial({ color: color, roughness: 0.6 })
    : new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.35, depthWrite: false });
  var m = new THREE.Mesh(geo, mat);
  m.position.set(px(r), py(r.floor), (z0 + z1) / 2);
  world.add(m);
  var edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: color }));
  edge.position.copy(m.position); world.add(edge);
  return m;
}
// Where a hold or class starts, in map space: the tip of its pointer.
function tipOf(x) { var r = rooms[x.room_id]; return new THREE.Vector3(px(r), py(r.floor), pz(x.from)); }

function build(reframe) {
  clearWorld(); readColors();
  scene.background = new THREE.Color(css['--bg']);
  var floors = data.floors.filter(function (f) { return !focus || String(f.id) === focus; });
  var width = Math.max.apply(null, floors.map(function (f) { return f.rooms.length; }).concat([1])) * RX;
  var bound = new THREE.Box3(new THREE.Vector3(-RX, 0, 0), new THREE.Vector3(width, 0, ZEND));
  var few = floors.length <= 2;

  floors.forEach(function (f) {
    var y = py(f) - 0.45, seg = [];
    var slab = new THREE.Mesh(new THREE.PlaneGeometry(width + RX, ZEND + 1),
      new THREE.MeshBasicMaterial({ color: css['--line'], transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
    slab.rotation.x = -Math.PI / 2; slab.position.set(width / 2 - RX, y, ZEND / 2); world.add(slab);
    for (var h = 8; h <= 18; h++) { var z = (h * 60 - DAY0) / STEP * TZ; seg.push(new THREE.Vector3(-RX, y, z), new THREE.Vector3(width - RX / 2, y, z)); }
    f.rooms.forEach(function (r) {
      seg.push(new THREE.Vector3(px(r), y, 0), new THREE.Vector3(px(r), y, ZEND));
      if (few) label(r.name, 0.55, css['--mut'], new THREE.Vector3(px(r), y + 0.15, -0.9));
    });
    lines(seg, css['--mut'], 0.35);
    label(f.name, 1.1, css['--ink'], new THREE.Vector3(-RX * 2, py(f), -0.6));
    bound.expandByPoint(new THREE.Vector3(0, py(f) + 0.5, 0)).expandByPoint(new THREE.Vector3(0, y, 0));
  });

  // hour marks along the time axis, under the lowest floor shown
  var low = floors.length ? Math.min.apply(null, floors.map(py)) - 0.45 : 0;
  for (var h = 8; h <= 18; h += 1) label(t12(hh(h)).replace(':00', ''), 0.75, css['--mut'], new THREE.Vector3(-RX * 0.9, low - 0.35, (h * 60 - DAY0) / STEP * TZ));

  // axes from the origin: room (x), floor (y), time (z)
  var top = Math.max(bound.max.y, 1) + 1.2;
  arrow(new THREE.Vector3(width + 0.6, 0, 0), css['--ink'], 0.8, 0.5);
  arrow(new THREE.Vector3(0, top, 0), css['--ink'], 0.8, 0.5);
  arrow(new THREE.Vector3(0, 0, ZEND + 1.2), css['--ink'], 0.8, 0.5);
  label('x · room', 0.8, css['--ink'], new THREE.Vector3(width + 2.4, 0, 0));
  label('y · floor', 0.8, css['--ink'], new THREE.Vector3(0, top + 0.8, 0));
  label('z · time', 0.8, css['--ink'], new THREE.Vector3(0, 0.6, ZEND + 2.4));
  label('O', 0.8, css['--ink'], new THREE.Vector3(-0.4, -0.4, -0.4));
  bound.expandByPoint(new THREE.Vector3(0, top, 0));

  // the current time as a see-through wall
  var t = mins(data.now.time);
  if (t >= DAY0 && t <= DAY_END && floors.length) {
    var z = pz(data.now.time), hgt = bound.max.y - low;
    var wall = new THREE.Mesh(new THREE.PlaneGeometry(width + RX, hgt),
      new THREE.MeshBasicMaterial({ color: css['--focus'], transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
    wall.position.set(width / 2 - RX, low + hgt / 2, z); world.add(wall);
    lines([new THREE.Vector3(-RX, low, z), new THREE.Vector3(width - RX / 2, low, z), new THREE.Vector3(-RX, bound.max.y, z), new THREE.Vector3(width - RX / 2, bound.max.y, z)], css['--focus'], 0.7);
    label('Now ' + t12(data.now.time), 0.8, css['--focus'], new THREE.Vector3(width - RX / 2, bound.max.y + 0.7, z));
  }

  // holds and classes, with a pointer from the origin to where each one starts
  var shown = data.items.filter(function (x) { return !focus || String(rooms[x.room_id].floor.id) === focus; });
  shown.forEach(function (x) {
    var on = selected && key(x) === key(selected);
    var m = box(x, kindColor(x), holding(x));
    m.userData.item = x; pickable.push(m);
    if (on) {
      var ring = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.35, 1.1, m.geometry.parameters.depth + 0.3)),
        new THREE.LineBasicMaterial({ color: css['--ink'] }));
      ring.position.copy(m.position); world.add(ring);
    }
    if (showVec && holding(x) || on) arrow(tipOf(x), kindColor(x), selected && !on ? 0.15 : on ? 1 : 0.55, on ? 0.7 : 0.45);
  });

  if (probe && (!focus || String(probe.room.floor.id) === focus)) {
    var color = probe.clash ? css['--occ'] : css['--free'];
    box(probe.item, color, false); // drawn, but not clickable
    arrow(tipOf(probe.item), color, 1, 0.8);
  }

  if (reframe) frame(bound); else draw();
}

// ---- side panels ----
function select(x) {
  selected = x; build(false); renderInfo(); renderList();
}
function vecList(V) {
  var box = el('div', 'vecs');
  V.forEach(function (v, i) {
    box.appendChild(el('div', 'vec', 'A' + (i + 1) + ' = ' + vtext(v) + '   ' + blockTime(v[1]) + '   |A|² = ' + len2(v)));
  });
  return box;
}
function renderInfo() {
  var box = $('info'); box.textContent = '';
  if (!selected) { box.appendChild(el('p', 'empty', 'Click a block in the map or a row below.')); return; }
  var x = selected, V = itemVectors(x);
  box.appendChild(el('h3', null, itemLine(x)));
  box.appendChild(el('p', 'hint', [kindLabel(x), x.subject, x.batch, x.faculty && 'by ' + x.faculty,
    x.freed_by && 'freed by ' + x.freed_by].filter(Boolean).join(' · ')));
  box.appendChild(el('p', null, 'It covers ' + V.length + ' fifteen-minute block' + (V.length === 1 ? '' : 's') +
    ', so the server checks ' + V.length + ' vector' + (V.length === 1 ? '' : 's') + ' (room id, block, floor):'));
  box.appendChild(vecList(V));
  if (x.freed_by) box.appendChild(el('p', 'hint mt', 'Freed classes are left out of the clash check, so this room can be held again.'));
  box.appendChild(el('div', 'row mt', null, [btn('Clear selection', function () { select(null); })]));
}
function btn(text, fn) { var b = el('button', 'small', text); b.onclick = fn; return b; }

function renderList() {
  var t = $('list'); t.textContent = '';
  var shown = data.items.filter(function (x) { return !focus || String(rooms[x.room_id].floor.id) === focus; });
  $('listHint').textContent = shown.length ? shown.length + ' for today. Each row starts at the vector shown.' : 'Nothing is held or timetabled here today.';
  if (!shown.length) return;
  t.appendChild(el('thead', null, null, [el('tr', null, null, ['Room', 'Floor', 'Time', 'What', 'First vector', ''].map(function (h) { return el('th', null, h); }))]));
  var body = el('tbody');
  shown.slice().sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : 0; }).forEach(function (x) {
    var r = rooms[x.room_id], on = selected && key(x) === key(selected);
    var sw = el('i', 'sw'); sw.style.background = kindColor(x);
    body.appendChild(el('tr', on ? 'on' : null, null, [
      el('td', null, r.name), el('td', null, r.floor.name), el('td', null, t12(x.from) + '–' + t12(x.to)),
      el('td', null, null, [sw, document.createTextNode(kindLabel(x) + (x.subject ? ' · ' + x.subject : ''))]),
      el('td', 'vec', vtext(itemVectors(x)[0])),
      el('td', null, null, [btn(on ? 'Selected' : 'Show', function () { select(on ? null : x); })])]));
  });
  t.appendChild(body);
}
function renderKey() {
  var k = $('key'); k.textContent = '';
  [['--occ', 'Hold'], ['--cls', 'Timetabled class'], ['--free', 'Class freed today'], ['--focus', 'Now']].forEach(function (p) {
    var i = el('i'); i.style.background = css[p[0]];
    k.appendChild(el('span', null, null, [i, document.createTextNode(p[1])]));
  });
}

// ---- test a time ----
function setupProbe() {
  var sel = $('pRoom'); sel.textContent = '';
  data.floors.slice().reverse().forEach(function (f) {
    if (!f.rooms.length) return;
    var g = document.createElement('optgroup'); g.label = f.name;
    f.rooms.forEach(function (r) { var o = el('option', null, r.name); o.value = r.id; g.appendChild(o); });
    sel.appendChild(g);
  });
  var opts = function (list) { return list.map(function (t) { return { value: t, label: t12(t) }; }); };
  var n = data.now.time, start = TIMES.filter(function (t) { return t <= n; }).pop() || TIMES[0];
  if (start === TIMES[TIMES.length - 1]) start = TIMES[0];
  fillSelect($('pFrom'), opts(TIMES.slice(0, -1)));
  $('pFrom').value = start;
  var fillTo = function () {
    var ends = TIMES.filter(function (t) { return t > $('pFrom').value; }), keep = $('pTo').value;
    fillSelect($('pTo'), opts(ends));
    $('pTo').value = ends.indexOf(keep) >= 0 ? keep : ends[Math.min(3, ends.length - 1)];
  };
  $('pFrom').onchange = fillTo; fillTo();
  $('pCheck').onclick = runProbe;
  $('pClear').onclick = function () { probe = null; $('pOut').textContent = ''; build(false); };
}
function runProbe() {
  var r = rooms[$('pRoom').value], from = $('pFrom').value, to = $('pTo').value;
  var item = { kind: 'test', id: 0, room_id: r.id, from: from, to: to };
  var A = itemVectors(item), out = $('pOut'), found = null;
  data.items.filter(holding).some(function (x) { var p = clashPair(A, itemVectors(x)); if (p) found = { x: x, a: p[0], b: p[1] }; return !!p; });
  probe = { room: r, item: item, clash: !!found };
  out.textContent = '';
  if (found) {
    out.appendChild(el('p', 'err', 'Clash with ' + kindLabel(found.x).toLowerCase() + ' ' + itemLine(found.x) + (found.x.faculty ? ' (' + found.x.faculty + ')' : '') + '.'));
    out.appendChild(el('div', 'vec', 'A = ' + vtext(found.a) + '   B = ' + vtext(found.b)));
    out.appendChild(el('div', 'vec', 'A × B = ' + vtext(cross(found.a, found.b)) + '   |A|² = |B|² = ' + len2(found.a)));
    out.appendChild(el('p', 'hint mt', 'The vectors point the same way and are equally long, so it is the same room, block and floor. The server would refuse this hold.'));
  } else {
    out.appendChild(el('p', 'okmsg', 'No clash. ' + r.name + ' is free from ' + t12(from) + ' to ' + t12(to) + '.'));
    out.appendChild(el('p', 'hint', 'None of its ' + A.length + ' vectors matches a vector of today’s holds and classes.'));
  }
  if (focus && String(r.floor.id) !== focus) { focus = String(r.floor.id); $('floorSel').value = focus; build(true); renderList(); }
  else build(false);
}

// ---- start ----
function load(reframe) {
  return api('/map').then(function (d) {
    data = d; rooms = {};
    data.floors.forEach(function (f) {
      f.rooms = d.rooms.filter(function (r) { return r.floor_id === f.id; });
      f.rooms.forEach(function (r, i) { r.index = i; r.floor = f; rooms[r.id] = r; });
    });
    data.items = data.items.filter(function (x) { return rooms[x.room_id]; });
    if (selected) selected = data.items.filter(function (x) { return key(x) === key(selected); })[0] || null;
    $('updated').textContent = DAYS[d.now.day] + ', ' + t12(d.now.time) + ' IST';
    var fs = $('floorSel'), keep = focus;
    fillSelect(fs, [{ value: '', label: 'All floors' }].concat(data.floors.slice().reverse().map(function (f) { return { value: String(f.id), label: f.name }; })));
    focus = data.floors.some(function (f) { return String(f.id) === keep; }) ? keep : '';
    fs.value = focus;
    readColors(); build(reframe); renderKey(); renderInfo(); renderList();
  });
}

$('floorSel').onchange = function () { focus = this.value; selected = null; build(true); renderInfo(); renderList(); };
$('vecChk').onchange = function () { showVec = this.checked; build(false); };
$('resetView').onclick = function () { resetView(); };
$('logoutBtn').onclick = function () { logoutTo('/'); };
// redraw in the new colors when the system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (data) { build(false); renderKey(); renderList(); } });

api('/me').then(function (d) {
  $('whoami').textContent = ROLES[d.user.role] + ' · ' + d.user.email;
  $('logoutBtn').hidden = false;
  ['mapPanel', 'infoPanel', 'probePanel', 'listPanel'].forEach(function (id) { $(id).hidden = false; });
  return load(true).then(function () {
    setupProbe();
    setInterval(function () { if (!document.hidden) load(false).catch(function () {}); }, 60000); // keep "now" moving
  });
}).catch(function (e) {
  if (e.status === 401) { $('gate').hidden = false; return; }
  toast(e.message);
});
