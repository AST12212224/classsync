var me = null, floors = [];

// ---- tabs ----
function showTab(name) {
  $('tabBuilding').setAttribute('aria-selected', name === 'building');
  $('tabStaff').setAttribute('aria-selected', name === 'staff');
  $('viewBuilding').hidden = name !== 'building'; $('viewStaff').hidden = name !== 'staff';
  try { localStorage.setItem('cs_admin_tab', name); } catch (e) {}
}
$('tabBuilding').onclick = function () { showTab('building'); };
$('tabStaff').onclick = function () { showTab('staff'); };

// ---- floors and rooms ----
function loadFloors() {
  return api('/building').then(function (d) { floors = d.floors; renderFloors(); });
}
function renderFloors() {
  var box = $('floors'); box.innerHTML = '';
  if (!floors.length) { box.appendChild(el('div', 'empty', 'No floors yet. Add the first one above.')); return; }
  floors.forEach(function (f) {
    var card = el('div', 'fcard');
    var edit = el('button', 'small', 'Edit floor'); edit.onclick = function () { editFloor(f); };
    var labs = f.rooms.filter(function (r) { return r.type === 'lab'; }).length;
    card.appendChild(el('div', 'top', null, [
      el('h3', null, f.name), el('span', 'tag', 'Floor ' + f.level),
      el('span', 'hint', (f.rooms.length - labs) + ' classrooms · ' + labs + ' labs'), edit]));

    var chips = el('div', 'chips');
    if (!f.rooms.length) chips.appendChild(el('div', 'empty', 'No rooms on this floor yet.'));
    f.rooms.forEach(function (r) {
      var c = el('button', 'chip', null, [el('span', null, r.name), r.type === 'lab' ? el('span', 'tag', 'Lab') : null]);
      c.onclick = function () { editRoom(r, f); };
      chips.appendChild(c);
    });
    card.appendChild(chips);
    card.appendChild(addRoomForm(f));
    box.appendChild(card);
  });
}

function addRoomForm(f) {
  var name = el('input'), type = el('select'), count = el('input'), err = el('div', 'err'), btn = el('button', 'pri', 'Add');
  name.maxLength = 40; name.placeholder = 'e.g. 301 or Lab 1';
  fillSelect(type, [{ value: 'classroom', label: 'Classroom' }, { value: 'lab', label: 'Lab' }]);
  count.type = 'number'; count.min = 1; count.max = 50; count.value = 1;
  btn.onclick = function () {
    err.textContent = '';
    var names = expandNames(name.value.trim(), Number(count.value));
    if (typeof names === 'string') { err.textContent = names; return; }
    btn.disabled = true;
    api('/admin/rooms', 'POST', { floor_id: f.id, type: type.value, names: names })
      .then(function (rows) { toast(rows.length === 1 ? rows[0].name + ' added' : rows.length + ' rooms added'); return loadFloors(); })
      .catch(function (e) { err.textContent = e.message; btn.disabled = false; });
  };
  var form = el('div', 'addroom', null, [
    el('label', null, 'Room name', [name]), el('label', null, 'Type', [type]), el('label', null, 'How many', [count]), btn]);
  return el('div', null, null, [form, err]);
}
// "301" x 3 -> 301, 302, 303. "Lab 1" x 2 -> Lab 1, Lab 2. Returns an error string when it cannot.
function expandNames(name, n) {
  if (!name) return 'Give the room a name.';
  if (!(n >= 1 && n <= 50 && n === Math.floor(n))) return 'Add between 1 and 50 rooms at a time.';
  if (n === 1) return [name];
  var m = name.match(/^(.*?)(\d+)$/);
  if (!m) return 'To add several rooms, end the name with a number, e.g. 301 or Lab 1.';
  var start = Number(m[2]), width = m[2].length, out = [];
  for (var i = 0; i < n; i++) { var num = String(start + i); while (num.length < width) num = '0' + num; out.push(m[1] + num); }
  return out;
}

$('fAdd').onclick = function () {
  $('fErr').textContent = '';
  api('/admin/floors', 'POST', { level: $('fLevel').value, name: $('fName').value })
    .then(function (f) { $('fLevel').value = ''; $('fName').value = ''; toast(f.name + ' added'); return loadFloors(); })
    .catch(function (e) { $('fErr').textContent = e.message; });
};

// ---- edit dialog, shared by floors and rooms ----
var editing = null;
function openEdit(title, fields, save, del, delMsg) {
  $('eTitle').textContent = title; $('eErr').textContent = '';
  var box = $('eFields'); box.innerHTML = '';
  fields.forEach(function (f) { box.appendChild(el('label', null, f[0], [f[1]])); });
  editing = { save: save, del: del, delMsg: delMsg };
  $('edlg').showModal(); fields[0][1].focus();
}
function input(value, type) { var i = el('input'); i.type = type || 'text'; i.value = value; return i; }
function editFloor(f) {
  var level = input(f.level, 'number'), name = input(f.name); name.maxLength = 60;
  openEdit('Edit floor', [['Floor number', level], ['Floor name', name]],
    function () { return api('/admin/floors/' + f.id, 'PUT', { level: level.value, name: name.value }); },
    function () { return api('/admin/floors/' + f.id, 'DELETE'); },
    'Delete ' + f.name + ' and all ' + f.rooms.length + ' rooms on it? Their timetable entries are removed too.');
}
function editRoom(r, f) {
  var name = input(r.name), type = el('select'), floor = el('select'); name.maxLength = 40;
  fillSelect(type, [{ value: 'classroom', label: 'Classroom' }, { value: 'lab', label: 'Lab' }]); type.value = r.type;
  fillSelect(floor, floors.map(function (x) { return { value: x.id, label: x.name }; })); floor.value = f.id;
  openEdit('Edit room', [['Room name', name], ['Type', type], ['Floor', floor]],
    function () { return api('/admin/rooms/' + r.id, 'PUT', { name: name.value, type: type.value, floor_id: Number(floor.value) }); },
    function () { return api('/admin/rooms/' + r.id, 'DELETE'); },
    'Delete ' + r.name + '? Its bookings and timetable entries are removed too.');
}
$('eCancel').onclick = function () { $('edlg').close(); };
$('eSave').onclick = function () {
  $('eErr').textContent = '';
  editing.save().then(function () { $('edlg').close(); toast('Saved'); return loadFloors(); })
    .catch(function (e) { $('eErr').textContent = e.message; });
};
$('eDel').onclick = function () {
  if (!confirm(editing.delMsg)) return;
  editing.del().then(function () { $('edlg').close(); toast('Deleted'); return loadFloors(); })
    .catch(function (e) { $('eErr').textContent = e.message; });
};
$('edlg').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); $('eSave').click(); }
});

// ---- staff ----
function canRemove(row) {
  if (row.id === me.id || row.role === 'superadmin') return false;
  return me.role === 'superadmin' || row.role !== 'admin';
}
function loadList() {
  return api('/admin/users').then(function (rows) {
    var box = $('list'); box.innerHTML = '';
    if (!rows.length) { box.appendChild(el('div', 'empty', 'No staff accounts yet. Add the first one above.')); return; }
    rows.forEach(function (row) {
      var d = el('div', 'item', null, [el('div', 'n', null, [el('b', null, row.name), el('small', null, ROLES[row.role] + ' · ' + row.email)])]);
      if (canRemove(row)) {
        var b = el('button', 'small danger', 'Remove');
        b.onclick = function () {
          if (!confirm('Remove ' + row.name + '? They lose access immediately.')) return;
          api('/admin/users/' + row.id, 'DELETE').then(loadList).then(function () { toast('Account removed'); })
            .catch(function (e) { toast(e.message); });
        };
        d.appendChild(b);
      }
      box.appendChild(d);
    });
  });
}
$('aAdd').onclick = function () {
  $('aErr').textContent = '';
  api('/admin/users', 'POST', { name: $('aName').value, email: $('aEmail').value, role: $('aRole').value })
    .then(function () { $('aName').value = ''; $('aEmail').value = ''; return loadList(); })
    .then(function () { toast('Account added'); })
    .catch(function (e) { $('aErr').textContent = e.message; });
};
$('logoutBtn').onclick = function () { logoutTo('/'); };

api('/me').then(function (d) {
  me = d.user;
  if (!isAdmin(me)) throw new Error('no');
  $('whoami').textContent = ROLES[me.role] + ' · ' + me.email;
  var roles = me.role === 'superadmin' ? ['teacher', 'timetable_manager', 'admin'] : ['teacher', 'timetable_manager'];
  fillSelect($('aRole'), roles.map(function (r) { return { value: r, label: ROLES[r] }; }));
  $('tabs').hidden = false;
  var tab = 'building'; try { tab = localStorage.getItem('cs_admin_tab') || tab; } catch (e) {}
  showTab(tab === 'staff' ? 'staff' : 'building');
  return Promise.all([loadFloors(), loadList()]);
}).catch(function (e) {
  if (me && isAdmin(me)) { toast(e.message); return; }
  $('denied').hidden = false; $('logoutBtn').hidden = true;
});
