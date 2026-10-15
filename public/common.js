var $ = function (id) { return document.getElementById(id); };
// On a 401 the access token has expired: get a new one with the refresh cookie once, then retry.
// A 401 always comes before the request does anything, so retrying a POST is safe.
var refreshing = null, sessionGone = false, wasLoggedIn = false;
function refreshOnce() {
  refreshing = refreshing || fetch('/api/auth/refresh', { method: 'POST' })
    .then(function (x) {
      // 409: another tab refreshed a moment ago; its new cookies are already in the browser
      if (x.status === 409) return new Promise(function (ok) { setTimeout(function () { ok(true); }, 300); });
      return x.ok;
    }, function () { return false; })
    .then(function (ok) { refreshing = null; return ok; });
  return refreshing;
}
// The session ended while the page was open: say so once and reload into the logged-out view.
function sessionEnded() {
  if (sessionGone) return;
  sessionGone = true;
  if (!wasLoggedIn) return;
  toast('Your session has ended. Please log in again.');
  setTimeout(function () { location.reload(); }, 2500);
}
function api(path, method, body, retried) {
  var authCall = path.indexOf('/auth/') === 0;
  return fetch('/api' + path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    if (r.status === 401 && !authCall && !retried && !sessionGone) {
      return refreshOnce().then(function (ok) {
        if (ok) return api(path, method, body, true);
        sessionEnded();
        var e = new Error('Please log in.'); e.status = 401; throw e;
      });
    }
    if (r.ok && !authCall) wasLoggedIn = true;
    if (r.ok && path === '/auth/verify-otp') sessionGone = false;
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (!r.ok) { var e = new Error(d.error || 'Something went wrong.'); e.status = r.status; throw e; }
      return d;
    });
  });
}
function toast(m) {
  var t = $('toast'); t.textContent = m; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 2600);
}
// el('div', 'cls', 'text', [children]): builds elements with textContent, never innerHTML for user data
function el(tag, cls, text, kids) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  (kids || []).forEach(function (k) { if (k) e.appendChild(k); });
  return e;
}
function fillSelect(sel, items, placeholder) {
  sel.innerHTML = '';
  if (placeholder) sel.appendChild(el('option', null, placeholder)).value = '';
  items.forEach(function (it) {
    var o = el('option', null, it.label != null ? it.label : it); o.value = it.value != null ? it.value : it; sel.appendChild(o);
  });
}

// Sample lists until the official ones arrive (see session notes, section 11)
var COURSES = ['MCA', 'Computer Engineering', 'Information Technology', 'Electronics & Telecom', 'Data Science', 'AI & ML'];
var BATCHES = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'];
var SEMESTERS = [1, 2, 3, 4, 5, 6, 7, 8].map(function (i) { return { value: i, label: 'Semester ' + i }; });
var DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
var SLOTS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17]; // one-hour timetable slots, 8 AM to 6 PM
var ROLES = { student: 'Student', teacher: 'Teacher', timetable_manager: 'Timetable manager', admin: 'Admin', superadmin: 'Super admin' };
var TYPES = { classroom: 'Classroom', lab: 'Lab' };
function hh(h) { return (h < 10 ? '0' : '') + h + ':00'; }
// '14:30' -> '2:30 PM' (all times are India time, sent by the server)
function t12(t) {
  var h = Number(t.slice(0, 2)), m = t.slice(3, 5);
  return (h % 12 || 12) + ':' + m + (h < 12 ? ' AM' : ' PM');
}
function slotLabel(h) { return t12(hh(h)) + '–' + t12(hh(h + 1)); }
// Booking times: 08:00 to 18:00 in 15-minute steps
var TIMES = (function () {
  var out = [], pad = function (n) { return (n < 10 ? '0' : '') + n; };
  for (var m = 8 * 60; m <= 18 * 60; m += 15) out.push(pad(m / 60 | 0) + ':' + pad(m % 60));
  return out;
})();
function isAdmin(u) { return !!u && (u.role === 'admin' || u.role === 'superadmin'); }
function isManager(u) { return !!u && (u.role === 'timetable_manager' || isAdmin(u)); }

function logoutTo(url) {
  api('/auth/logout', 'POST').catch(function () {}).then(function () { location.href = url || '/'; });
}
