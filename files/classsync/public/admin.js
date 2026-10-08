var ROLES = { teacher: 'Teacher', timetable_manager: 'Timetable manager', admin: 'Admin', superadmin: 'Super admin' };
var me = null;

function canRemove(row) {
  if (row.id === me.id || row.role === 'superadmin') return false;
  return me.role === 'superadmin' || row.role !== 'admin';
}

function loadList() {
  return api('/admin/users').then(function (rows) {
    var box = $('list'); box.innerHTML = '';
    if (!rows.length) { box.textContent = 'No staff accounts yet. Add the first one above.'; return; }
    rows.forEach(function (row) {
      var d = document.createElement('div'); d.className = 'u';
      var n = document.createElement('div'); n.className = 'n';
      var name = document.createElement('b'); name.textContent = row.name;
      var sub = document.createElement('small'); sub.textContent = ROLES[row.role] + ' \u00b7 ' + row.email;
      n.appendChild(name); n.appendChild(sub); d.appendChild(n);
      if (canRemove(row)) {
        var b = document.createElement('button'); b.textContent = 'Remove';
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
$('logoutBtn').onclick = function () {
  api('/auth/logout', 'POST').catch(function () {}).then(function () { location.href = '/'; });
};

api('/me').then(function (d) {
  me = d.user;
  if (me.role !== 'admin' && me.role !== 'superadmin') throw new Error('no');
  var roles = me.role === 'superadmin' ? ['teacher', 'timetable_manager', 'admin'] : ['teacher', 'timetable_manager'];
  roles.forEach(function (r) { var o = document.createElement('option'); o.value = r; o.textContent = ROLES[r]; $('aRole').appendChild(o); });
  $('addPanel').hidden = false; $('listPanel').hidden = false;
  return loadList();
}).catch(function () { $('denied').hidden = false; $('logoutBtn').hidden = true; });
