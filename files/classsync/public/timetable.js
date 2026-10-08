var me = null, entries = [], cell = null;
var WEEK = [1, 2, 3, 4, 5, 6]; // Monday to Saturday

fillSelect($('pCourse'), COURSES);
fillSelect($('pSem'), SEMESTERS);
fillSelect($('pBatch'), BATCHES);
try { // reopen on the batch used last time
  var last = JSON.parse(localStorage.getItem('cs_tt_batch') || 'null');
  if (last) { $('pCourse').value = last.course; $('pSem').value = last.semester; $('pBatch').value = last.batch; }
} catch (e) {}

function batch() { return { course: $('pCourse').value, semester: Number($('pSem').value), batch: $('pBatch').value }; }
function loadGrid() {
  var b = batch();
  try { localStorage.setItem('cs_tt_batch', JSON.stringify(b)); } catch (e) {}
  $('gridTitle').textContent = b.course + ' · Semester ' + b.semester + ' · Batch ' + b.batch;
  return api('/timetable?course=' + encodeURIComponent(b.course) + '&semester=' + b.semester + '&batch=' + encodeURIComponent(b.batch))
    .then(function (rows) { entries = rows; renderGrid(); })
    .catch(function (e) { toast(e.message); });
}
['pCourse', 'pSem', 'pBatch'].forEach(function (id) { $(id).onchange = loadGrid; });

function renderGrid() {
  var g = $('grid'); g.innerHTML = '';
  $('gridHint').textContent = entries.length + ' class' + (entries.length === 1 ? '' : 'es') + ' a week.';
  var head = el('tr', null, null, [el('th', null, 'Time')]);
  WEEK.forEach(function (d) { head.appendChild(el('th', null, DAYS[d])); });
  g.appendChild(el('thead', null, null, [head]));
  var body = el('tbody');
  SLOTS.forEach(function (s) {
    var tr = el('tr', null, null, [el('th', null, slotLabel(s))]);
    WEEK.forEach(function (d) {
      var e = entries.filter(function (x) { return x.day === d && x.slot === s; })[0];
      var b = el('button', e ? 'has' : '', null, e
        ? [el('b', null, e.subject), el('small', null, e.room + ' · ' + e.floor), e.faculty ? el('small', null, e.faculty) : null]
        : [el('small', null, '+ Add')]);
      b.setAttribute('aria-label', DAYS[d] + ' ' + slotLabel(s) + (e ? ': ' + e.subject + ' in ' + e.room : ': empty'));
      b.onclick = function () { openSlot(d, s, e); };
      tr.appendChild(el('td', null, null, [b]));
    });
    body.appendChild(tr);
  });
  g.appendChild(body);
}

function openSlot(day, slot, e) {
  cell = { day: day, slot: slot, entry: e };
  $('sTitle').textContent = DAYS[day] + ', ' + slotLabel(slot);
  $('sSubject').value = e ? e.subject : ''; $('sFaculty').value = e ? e.faculty || '' : '';
  $('sRoom').value = e ? e.room_id : '';
  $('sDel').hidden = !e; $('sErr').textContent = '';
  $('sdlg').showModal(); $('sSubject').focus();
}
$('sCancel').onclick = function () { $('sdlg').close(); };
$('sSave').onclick = function () {
  var b = batch();
  b.day = cell.day; b.slot = cell.slot; b.subject = $('sSubject').value; b.faculty = $('sFaculty').value; b.room_id = Number($('sRoom').value);
  $('sErr').textContent = '';
  api('/timetable', 'PUT', b).then(function () { $('sdlg').close(); toast('Saved'); return loadGrid(); })
    .catch(function (e) { $('sErr').textContent = e.message; });
};
$('sDel').onclick = function () {
  api('/timetable/' + cell.entry.id, 'DELETE').then(function () { $('sdlg').close(); toast('Class removed'); return loadGrid(); })
    .catch(function (e) { $('sErr').textContent = e.message; });
};
$('sdlg').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); $('sSave').click(); }
});
$('logoutBtn').onclick = function () { logoutTo('/'); };

// Room picker grouped by floor, and teacher names as suggestions
function loadRooms() {
  return api('/building').then(function (d) {
    var sel = $('sRoom'); sel.innerHTML = '';
    sel.appendChild(el('option', null, d.floors.length ? 'Select a room' : 'No rooms yet: ask an admin to add them')).value = '';
    d.floors.forEach(function (f) {
      var grp = el('optgroup'); grp.label = f.name;
      f.rooms.forEach(function (r) {
        var o = el('option', null, r.name + (r.type === 'lab' ? ' (Lab)' : '')); o.value = r.id; grp.appendChild(o);
      });
      if (f.rooms.length) sel.appendChild(grp);
    });
  });
}
function loadTeacherNames() {
  return api('/teachers').then(function (rows) {
    var dl = $('teacherNames'); dl.innerHTML = '';
    rows.forEach(function (t) { var o = el('option'); o.value = t.name; dl.appendChild(o); });
  });
}

api('/me').then(function (d) {
  me = d.user;
  if (!isManager(me)) throw new Error('no');
  $('whoami').textContent = ROLES[me.role] + ' · ' + me.email;
  $('adminLink').hidden = !isAdmin(me);
  $('pickPanel').hidden = false; $('gridPanel').hidden = false;
  return Promise.all([loadRooms(), loadTeacherNames(), loadGrid()]);
}).catch(function (e) {
  if (me && isManager(me)) { toast(e.message); return; }
  $('denied').hidden = false; $('logoutBtn').hidden = true;
});
