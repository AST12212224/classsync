var FLOORS = [8, 7, 6, 5, 4, 3, 2, 1, 0], NAMES = ['Ground', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
var ROLES = { student: 'Student', teacher: 'Teacher', timetable_manager: 'Timetable manager', admin: 'Admin', superadmin: 'Super admin' };
var user = null, profile = {}, status = {}, openFloor = null, selRoom = null;

for (var i = 1; i <= 8; i++) { var o = document.createElement('option'); o.textContent = 'Semester ' + i; o.value = i; $('sSem').appendChild(o); }

function init() {
  return api('/me').then(function (d) { user = d.user; profile = d.profile || {}; })
    .catch(function () { user = null; })
    .then(function () { return user ? loadStatus().catch(function () {}) : 0; })
    .then(renderAuth);
}
function loadStatus() {
  return api('/status').then(function (rows) {
    status = {};
    rows.forEach(function (r) { status[r.floor + '-' + r.room_no] = { fac: r.faculty, from: r.from_time, to: r.to_time }; });
  });
}

function renderAuth() {
  var on = !!user, role = on ? user.role : '';
  $('loginBtn').hidden = on; $('logoutBtn').hidden = !on;
  $('adminLink').hidden = !(role === 'admin' || role === 'superadmin');
  $('whoami').textContent = on ? ROLES[role] + ' \u00b7 ' + user.email : '';
  $('gate').hidden = on; $('buildingPanel').hidden = !on;
  $('studentPanel').hidden = role !== 'student'; $('teacherPanel').hidden = role !== 'teacher';
  if (role === 'student') {
    $('sSem').value = profile.semester || ''; $('sCourse').value = profile.course || ''; $('sBatch').value = profile.batch || '';
  } else if (role === 'teacher') {
    $('tName').value = user.name || ''; $('tCourses').value = profile.courses || '';
    $('tPlace').value = profile.free_place || ''; $('tWhere').value = profile.free_location || '';
  }
  renderTower();
}

function renderTower() {
  var t = $('tower'); t.innerHTML = '';
  if (!user) return;
  FLOORS.forEach(function (f) {
    var used = 0; for (var r = 1; r <= 20; r++) if (status[f + '-' + r]) used++;
    var d = document.createElement('div'); d.className = 'floor' + (openFloor === f ? ' open' : '');
    var b = document.createElement('button'); b.className = 'fbtn'; b.setAttribute('aria-expanded', openFloor === f);
    b.innerHTML = '<span class="fnum">' + f + '</span><span class="fname"><b>' + (f === 0 ? 'Ground floor' : NAMES[f] + ' floor') + '</b><span>' + (20 - used) + ' free \u00b7 ' + used + ' occupied</span></span><span class="bar"><div style="width:' + (used * 5) + '%"></div></span><span class="chev">&#9656;</span>';
    b.onclick = function () { openFloor = openFloor === f ? null : f; selRoom = null; renderTower(); };
    d.appendChild(b);
    if (openFloor === f) {
      var w = document.createElement('div'); w.className = 'rooms';
      var g = document.createElement('div'); g.className = 'grid';
      for (var r2 = 1; r2 <= 20; r2++) (function (r) {
        var s = status[f + '-' + r], x = document.createElement('button');
        x.className = 'room' + (s ? ' occ' : '') + (selRoom === r ? ' sel' : '');
        x.textContent = r; x.setAttribute('aria-label', 'Room ' + r + (s ? ' occupied' : ' free'));
        x.onclick = function () { selRoom = r; renderTower(); };
        g.appendChild(x);
      })(r2);
      w.appendChild(g);
      if (selRoom) w.appendChild(detail(f, selRoom));
      d.appendChild(w);
    }
    t.appendChild(d);
  });
}

function detail(f, r) {
  var s = status[f + '-' + r], d = document.createElement('div'); d.className = 'detail';
  var h = document.createElement('h3'); h.textContent = 'Floor ' + f + ', Room ' + r; d.appendChild(h);
  if (['teacher', 'admin', 'superadmin'].indexOf(user.role) < 0) {
    var p = document.createElement('p'); p.style.margin = '0';
    p.textContent = s ? 'Occupied by ' + s.fac + ', ' + s.from + ' to ' + s.to + '.' : 'Free right now.';
    d.appendChild(p); return d;
  }
  var form = document.createElement('div');
  form.innerHTML = '<div class="fields"><label>Status<select id="dSt"><option value="free">Free</option><option value="occupied">Occupied</option></select></label><label>Faculty<input id="dFac" maxlength="80"></label><label>From<input id="dFrom" type="time" min="08:00" max="17:00"></label><label>To<input id="dTo" type="time" min="08:00" max="17:00"></label></div><div class="row"><button class="pri" id="dSave">Update room</button></div><div class="err" id="dErr"></div>';
  d.appendChild(form);
  var q = function (id) { return form.querySelector('#' + id); };
  q('dSt').value = s ? 'occupied' : 'free'; q('dFac').value = s ? s.fac : (user.name || '');
  q('dFrom').value = s ? s.from : ''; q('dTo').value = s ? s.to : '';
  q('dSave').onclick = function () {
    q('dErr').textContent = '';
    api('/rooms/' + f + '/' + r, 'PUT', { status: q('dSt').value, faculty: q('dFac').value, from: q('dFrom').value, to: q('dTo').value })
      .then(loadStatus).then(function () { toast('Room ' + r + ' updated'); renderTower(); })
      .catch(function (e) { q('dErr').textContent = e.message; });
  };
  return d;
}

// ---- login: email, then 6-digit code ----
var step = 1;
function resetLogin() {
  step = 1; $('otpWrap').hidden = true; $('lEmail').disabled = false; $('lErr').textContent = ''; $('lOtp').value = '';
  $('doLogin').textContent = 'Send code';
  $('lStep').textContent = 'We will email you a 6-digit code. Teacher and admin accounts are created by the admin.';
}
$('loginBtn').onclick = function () { resetLogin(); $('dlg').showModal(); };
$('cancelLogin').onclick = function () { $('dlg').close(); };
$('dlg').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('doLogin').click(); });
$('doLogin').onclick = function () {
  var btn = $('doLogin'), er = $('lErr'), email = $('lEmail').value.trim().toLowerCase();
  er.textContent = ''; btn.disabled = true;
  var p = step === 1
    ? api('/auth/request-otp', 'POST', { email: email }).then(function () {
        step = 2; $('otpWrap').hidden = false; $('lEmail').disabled = true; btn.textContent = 'Log in';
        $('lStep').textContent = 'If this email can log in, a code is on its way. It lasts 5 minutes.'; $('lOtp').focus();
      })
    : api('/auth/verify-otp', 'POST', { email: email || $('lEmail').value, otp: $('lOtp').value.trim() }).then(function () {
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
    .then(function () { toast('Class details saved'); }).catch(function (e) { toast(e.message); });
};
$('saveTeacher').onclick = function () {
  api('/me/profile', 'PUT', { name: $('tName').value, courses: $('tCourses').value, free_place: $('tPlace').value, free_location: $('tWhere').value })
    .then(function () { user.name = $('tName').value.trim(); toast('Details saved'); }).catch(function (e) { toast(e.message); });
};

// keep the building view live; skip while a room form is open so typing is not lost
setInterval(function () {
  if (user && !document.hidden && selRoom === null) loadStatus().then(renderTower).catch(function () {});
}, 30000);
init();
