var user = null, profile = {}, building = { floors: [], now: null }, teachers = [];
var openFloor = null, selRoom = null, sched = null;

fillSelect($('sCourse'), COURSES, 'Select');
fillSelect($('sSem'), SEMESTERS, 'Select');
fillSelect($('sBatch'), BATCHES, 'Select');

function init() {
  return api('/me').then(function (d) { user = d.user; profile = d.profile || {}; })
    .catch(function () { user = null; })
    .then(function () {
      if (!user) return;
      return Promise.all([loadBuilding(), loadTeachers()]).catch(function (e) { toast(e.message); });
    })
    .then(function () { renderAuth(); if (user && user.role === 'student') loadMyDay(); });
}
function loadBuilding() {
  return api('/building').then(function (d) {
    building = d;
    $('updated').textContent = DAYS[d.now.day] + ', ' + t12(d.now.time) + ' IST';
    renderQuick();
  });
}
function loadTeachers() { return api('/teachers').then(function (rows) { teachers = rows; renderDir(); }); }

function renderAuth() {
  var on = !!user, role = on ? user.role : '';
  $('loginBtn').hidden = on; $('logoutBtn').hidden = !on;
  $('adminLink').hidden = !isAdmin(user); $('ttLink').hidden = !isManager(user);
  $('whoami').textContent = on ? ROLES[role] + ' · ' + user.email : '';
  $('gate').hidden = on; $('buildingPanel').hidden = !on; $('dirPanel').hidden = !on;
  $('studentPanel').hidden = role !== 'student'; $('teacherPanel').hidden = role !== 'teacher';
  if (role === 'student') {
    $('sSem').value = profile.semester || ''; $('sCourse').value = profile.course || ''; $('sBatch').value = profile.batch || '';
  } else if (role === 'teacher') {
    $('tName').value = user.name || ''; $('tCourses').value = profile.courses || '';
    $('tPlace').value = profile.free_place || ''; $('tWhere').value = profile.free_location || '';
  }
  renderTower();
}

// ---- building: floors stacked top to bottom, rooms green (free) or red (occupied) ----
function renderTower() {
  var t = $('tower'); t.innerHTML = '';
  if (!user) return;
  if (!building.floors.length) {
    t.appendChild(el('div', 'empty', isAdmin(user) ? 'No floors yet. Add floors and rooms from the Admin page.' : 'No rooms have been set up yet.'));
    t.firstChild.style.padding = '16px';
    return;
  }
  building.floors.forEach(function (f) {
    var used = f.rooms.filter(function (r) { return r.busy; }).length, total = f.rooms.length;
    var d = el('div', 'floor' + (openFloor === f.id ? ' open' : ''));
    var counts = el('span', null, null, [
      el('span', 'nf', (total - used) + ' free'), document.createTextNode(' · '), el('span', used ? 'no' : 'zero', used + ' occupied')]);
    var bar = el('span', 'bar', null, [el('div')]); bar.firstChild.style.width = (total ? used / total * 100 : 0) + '%';
    var b = el('button', 'fbtn', null, [
      el('span', 'fnum', f.level === 0 ? 'G' : String(f.level)),
      el('span', 'fname', null, [el('b', null, f.name), counts]),
      total ? bar : null,
      el('span', 'chev', '▸')]);
    b.setAttribute('aria-expanded', openFloor === f.id);
    b.onclick = function () { openFloor = openFloor === f.id ? null : f.id; selRoom = null; renderTower(); };
    d.appendChild(b);
    if (openFloor === f.id) {
      var w = el('div', 'rooms'), g = el('div', 'grid');
      if (!total) w.appendChild(el('div', 'empty', 'No rooms on this floor yet.'));
      f.rooms.forEach(function (r) {
        var x = el('button', 'rsel', null, [
          el('span', 'rn', null, [el('b', null, r.name), r.type === 'lab' ? el('span', 'tag', 'Lab') : null]),
          el('small', null, r.busy ? 'Occupied till ' + t12(r.busy.to) : 'Free')]);
        x.setAttribute('aria-label', r.name + (r.type === 'lab' ? ' lab' : '') + (r.busy ? ', occupied' : ', free') + ': open details');
        x.onclick = function () { selectRoom(r.id); };
        g.appendChild(el('div', 'room' + (r.busy ? ' occ' : '') + (selRoom === r.id ? ' sel' : ''), null, [x, tileAction(r)]));
      });
      w.appendChild(g);
      if (selRoom && f.rooms.some(function (r) { return r.id === selRoom; })) w.appendChild(detail());
      d.appendChild(w);
    }
    t.appendChild(d);
  });
}

// ---- hold / free straight from a room tile (teachers and admins) ----
function isStaff() { return !!user && ['teacher', 'admin', 'superadmin'].indexOf(user.role) >= 0; }
// A hold starts at the current quarter hour (India time), never before 8 AM.
function holdStart() {
  var n = building.now ? building.now.time : '00:00';
  return TIMES.filter(function (t) { return t <= n; }).pop() || TIMES[0];
}
function renderQuick() {
  var show = isStaff(), start = holdStart(), sel = $('holdUntil'), keep = sel.value;
  var ends = TIMES.filter(function (t) { return t > start; });
  $('quick').hidden = !show;
  if (!show) return;
  sel.disabled = !ends.length;
  $('quickHint').textContent = ends.length ? 'Use Hold or Release on any room below.' : 'Rooms can only be held between 8:00 AM and 6:00 PM.';
  fillSelect(sel, ends.map(function (t) { return { value: t, label: t12(t) }; }));
  sel.value = ends.indexOf(keep) >= 0 ? keep : ends[Math.min(3, ends.length - 1)] || '';
}
function tileAction(r) {
  if (!isStaff()) return null;
  var b, run;
  if (!r.busy) {
    if ($('holdUntil').disabled) return null;
    b = el('button', 'ract hold', 'Hold');
    b.setAttribute('aria-label', 'Hold ' + r.name + ' until ' + t12($('holdUntil').value));
    run = function () {
      return api('/rooms/' + r.id + '/bookings', 'POST', { faculty: user.name, from: holdStart(), to: $('holdUntil').value })
        .then(function () { return r.name + ' held till ' + t12($('holdUntil').value); });
    };
  } else if (r.busy.kind === 'class' || r.busy.created_by === user.id || isAdmin(user)) {
    b = el('button', 'ract free', 'Release');
    b.setAttribute('aria-label', 'Release ' + r.name);
    run = r.busy.kind === 'class'
      ? function () { return api('/classes/' + r.busy.id + '/free', 'POST').then(function () { return r.name + ' released for today'; }); }
      : function () { return api('/bookings/' + r.busy.id, 'DELETE').then(function () { return r.name + ' released'; }); };
  } else {
    return el('small', 'by', 'Held by ' + r.busy.faculty);
  }
  b.onclick = function () {
    b.disabled = true;
    run().then(function (msg) { return refreshAfterChange().then(function () { toast(msg); }); })
      .catch(function (e) { toast(e.message); b.disabled = false; });
  };
  return b;
}

function selectRoom(id) {
  selRoom = selRoom === id ? null : id; sched = null; renderTower();
  if (selRoom) loadSched();
}
function loadSched() {
  var id = selRoom;
  return api('/rooms/' + id + '/schedule').then(function (d) {
    if (selRoom !== id) return;
    sched = d; var old = $('roomDetail'); if (old) old.replaceWith(detail());
  }).catch(function (e) { toast(e.message); });
}

function detail() {
  var d = el('div', 'detail'); d.id = 'roomDetail';
  if (!sched) { d.appendChild(el('div', 'empty', 'Loading today\u2019s schedule\u2026')); return d; }
  var now = sched.now.time, staff = ['teacher', 'admin', 'superadmin'].indexOf(user.role) >= 0;
  var current = sched.items.filter(function (i) { return !i.freed_by && i.from <= now && now < i.to; })[0];
  d.appendChild(el('div', 'row', null, [
    el('h3', null, sched.room.name + ' \u00b7 ' + sched.room.floor),
    el('span', 'tag', TYPES[sched.room.type])]));

  // Big red/green status, with the one action that changes it
  var box = el('div', 'status ' + (current ? 'o' : 'f'));
  if (current) {
    box.appendChild(el('div', null, null, [
      el('b', null, 'Occupied till ' + t12(current.to)),
      el('small', null, [current.subject, current.faculty, current.batch].filter(Boolean).join(' \u00b7 '))]));
    var act = staff && freeAction(current, 'Release room');
    if (act) box.appendChild(act);
    else if (staff) box.appendChild(el('small', null, 'Held by ' + current.faculty + '. Only they or an admin can release it.'));
  } else {
    box.appendChild(el('div', null, null, [el('b', null, 'Free now'), el('small', null, staff ? 'Hold it to mark it occupied (red).' : 'Nobody is using this room right now.')]));
  }
  d.appendChild(box);
  if (staff && !current) d.appendChild(bookForm());

  d.appendChild(el('h3', 'mt', 'Today in this room'));
  var list = el('div', 'list');
  if (!sched.items.length) list.appendChild(el('div', 'empty', 'Nothing scheduled here today.'));
  sched.items.forEach(function (i) {
    var who = [i.faculty, i.batch].filter(Boolean).join(' \u00b7 ');
    var note = i.freed_by ? ' \u00b7 released today by ' + i.freed_by : i.kind === 'class' ? ' (timetable)' : ' (held)';
    var row = el('div', 'item' + (i === current ? ' now' : '') + (i.freed_by ? ' freed' : ''), null, [
      el('span', 't', t12(i.from) + '\u2013' + t12(i.to)),
      el('div', 'n', null, [el('b', null, i.subject || (i.kind === 'class' ? 'Class' : 'Held')), el('small', null, who + note)])]);
    var act = staff && i !== current && freeAction(i, i.kind === 'class' ? 'Release for today' : 'Release');
    if (act) row.appendChild(act);
    list.appendChild(row);
  });
  d.appendChild(list);
  if (staff && current) d.appendChild(bookForm());
  return d;
}

// The button that frees (or un-frees) one entry, or null when this user may not change it.
function freeAction(i, label) {
  var call;
  if (i.kind === 'booking') {
    if (i.created_by !== user.id && !isAdmin(user)) return null;
    call = function () { return api('/bookings/' + i.id, 'DELETE').then(function () { return 'Room released'; }); };
  } else if (i.freed_by) {
    label = 'Undo';
    call = function () { return api('/classes/' + i.id + '/free', 'DELETE').then(function () { return 'Class restored'; }); };
  } else {
    call = function () { return api('/classes/' + i.id + '/free', 'POST').then(function () { return 'Room released for today'; }); };
  }
  var b = el('button', 'small ' + (label === 'Undo' ? '' : 'danger'), label);
  b.onclick = function () {
    b.disabled = true;
    call().then(function (msg) { return refreshAfterChange().then(function () { toast(msg); }); })
      .catch(function (e) { toast(e.message); b.disabled = false; });
  };
  return b;
}

function bookForm() {
  var f = el('div', 'mt'), q = {};
  f.appendChild(el('h3', null, 'Hold this room'));
  var fields = el('div', 'fields');
  [['faculty', 'Faculty'], ['subject', 'Subject (optional)'], ['from', 'From'], ['to', 'To']].forEach(function (x) {
    var inp;
    if (x[0] === 'from' || x[0] === 'to') { // 8:00 AM to 6:00 PM, 15-minute steps only
      inp = el('select');
      fillSelect(inp, (x[0] === 'from' ? TIMES.slice(0, -1) : TIMES.slice(1)).map(function (t) { return { value: t, label: t12(t) }; }));
    } else { inp = el('input'); inp.maxLength = 80; }
    q[x[0]] = inp;
    fields.appendChild(el('label', null, x[1], [inp]));
  });
  q.faculty.value = user.name || '';
  // start at the current quarter hour (India time), for one hour
  var n = sched.now.time, start = TIMES.filter(function (t) { return t <= n; }).pop() || TIMES[0];
  if (start === TIMES[TIMES.length - 1]) start = TIMES[TIMES.length - 2];
  q.from.value = start; q.to.value = TIMES[Math.min(TIMES.indexOf(start) + 4, TIMES.length - 1)];
  q.from.onchange = function () { // keep "to" after "from"
    if (q.to.value <= q.from.value) q.to.value = TIMES[Math.min(TIMES.indexOf(q.from.value) + 4, TIMES.length - 1)];
  };
  var err = el('div', 'err'), btn = el('button', 'pri', 'Hold room');
  btn.onclick = function () {
    err.textContent = ''; btn.disabled = true;
    api('/rooms/' + selRoom + '/bookings', 'POST', { faculty: q.faculty.value, subject: q.subject.value, from: q.from.value, to: q.to.value })
      .then(refreshAfterChange).then(function () { toast('Room held: it now shows red'); })
      .catch(function (e) { err.textContent = e.message; }).then(function () { btn.disabled = false; });
  };
  f.appendChild(fields); f.appendChild(el('div', 'row mt', null, [btn])); f.appendChild(err);
  return f;
}
function refreshAfterChange() {
  return Promise.all([loadBuilding(), loadTeachers()]).then(function () { renderTower(); return selRoom ? loadSched() : null; });
}

// ---- student: today's classes ----
function loadMyDay() {
  var box = $('myDay'); box.innerHTML = '';
  if (!profile.course || !profile.semester || !profile.batch) {
    box.appendChild(el('div', 'empty', 'Save your course, semester and batch to see today’s classes.')); return;
  }
  var qs = '?course=' + encodeURIComponent(profile.course) + '&semester=' + profile.semester + '&batch=' + encodeURIComponent(profile.batch);
  api('/timetable' + qs).then(function (rows) {
    var n = building.now, today = rows.filter(function (r) { return r.day === n.day; });
    $('myDayTitle').textContent = 'Today’s classes (' + DAYS[n.day] + ')';
    box.innerHTML = '';
    if (!today.length) { box.appendChild(el('div', 'empty', 'No classes on the timetable for today.')); return; }
    var hour = Number(n.time.slice(0, 2));
    today.forEach(function (r) {
      var tag = r.freed_today ? 'Cancelled today' : r.slot === hour ? 'Now' : r.slot > hour ? '' : 'Done';
      box.appendChild(el('div', 'item' + (r.freed_today ? ' freed' : r.slot === hour ? ' now' : ''), null, [
        el('span', 't', slotLabel(r.slot)),
        el('div', 'n', null, [el('b', null, r.subject), el('small', null, [r.room, r.floor, r.faculty].filter(Boolean).join(' · '))]),
        tag ? el('span', 'tag', tag) : null]));
    });
  }).catch(function (e) { box.appendChild(el('div', 'err', e.message)); });
}

// ---- teacher directory ----
function renderDir() {
  var box = $('dir'), q = $('dirSearch').value.trim().toLowerCase(); box.innerHTML = '';
  var rows = teachers.filter(function (t) { return !q || (t.name + ' ' + (t.courses || '')).toLowerCase().indexOf(q) >= 0; });
  if (!rows.length) { box.appendChild(el('div', 'empty', teachers.length ? 'No teacher matches that search.' : 'No teachers added yet.')); return; }
  rows.forEach(function (t) {
    var where = t.teaching_room
      ? el('span', 'pill o', 'Teaching in ' + t.teaching_room + ', ' + t.teaching_floor)
      : el('small', null, t.free_place ? 'When free: ' + (t.free_place === 'office_desk' ? 'Office desk' : 'Classroom') + (t.free_location ? ' · ' + t.free_location : '') : 'Location not shared yet');
    box.appendChild(el('div', 'item', null, [
      el('div', 'n', null, [el('b', null, t.name), el('small', null, t.courses || t.email)]), where]));
  });
}
$('dirSearch').oninput = renderDir;

// ---- login: email, then 6-digit code ----
var step = 1;
var STEP1 = 'Students: use your SPIT email (name@spit.ac.in). Teacher and admin accounts are created by the admin. We email you a 6-digit code.';
function resetLogin() {
  step = 1; $('otpWrap').hidden = true; $('lEmail').disabled = false; $('lErr').textContent = ''; $('lOtp').value = '';
  $('doLogin').textContent = 'Send code'; $('lStep').textContent = STEP1;
}
$('loginBtn').onclick = function () { resetLogin(); $('dlg').showModal(); };
$('cancelLogin').onclick = function () { $('dlg').close(); };
$('dlg').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('doLogin').click(); } });
$('doLogin').onclick = function () {
  var btn = $('doLogin'), er = $('lErr'), email = $('lEmail').value.trim().toLowerCase();
  er.textContent = ''; btn.disabled = true;
  var p = step === 1
    ? api('/auth/request-otp', 'POST', { email: email }).then(function () {
        step = 2; $('otpWrap').hidden = false; $('lEmail').disabled = true; btn.textContent = 'Log in';
        $('lStep').textContent = 'If this email can log in, a code is on its way. It lasts 5 minutes.'; $('lOtp').focus();
      })
    : api('/auth/verify-otp', 'POST', { email: email, otp: $('lOtp').value.trim() }).then(function () {
        $('dlg').close(); return init().then(function () { toast('Logged in'); });
      });
  p.catch(function (e) { er.textContent = e.message; }).then(function () { btn.disabled = false; });
};
$('logoutBtn').onclick = function () {
  api('/auth/logout', 'POST').catch(function () {}).then(function () {
    user = null; selRoom = null; openFloor = null; renderAuth(); toast('Logged out');
  });
};

$('saveStudent').onclick = function () {
  api('/me/profile', 'PUT', { semester: $('sSem').value, course: $('sCourse').value, batch: $('sBatch').value })
    .then(function () {
      profile = { semester: Number($('sSem').value), course: $('sCourse').value, batch: $('sBatch').value };
      toast('Class details saved'); loadMyDay();
    }).catch(function (e) { toast(e.message); });
};
$('saveTeacher').onclick = function () {
  api('/me/profile', 'PUT', { name: $('tName').value, courses: $('tCourses').value, free_place: $('tPlace').value, free_location: $('tWhere').value })
    .then(function () { user.name = $('tName').value.trim(); toast('Details saved'); return loadTeachers(); })
    .catch(function (e) { toast(e.message); });
};

// keep the building view live; skip while a room is open so typing is not lost
setInterval(function () {
  if (user && !document.hidden && selRoom === null) loadBuilding().then(renderTower).catch(function () {});
}, 30000);
init();
