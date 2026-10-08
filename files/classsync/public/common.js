var $ = function (id) { return document.getElementById(id); };
function api(path, method, body) {
  return fetch('/api' + path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (!r.ok) { var e = new Error(d.error || 'Something went wrong.'); e.status = r.status; throw e; }
      return d;
    });
  });
}
function toast(m) {
  var t = $('toast'); t.textContent = m; t.classList.add('show');
  setTimeout(function () { t.classList.remove('show'); }, 2400);
}
