var $ = function (i) {
  return document.getElementById(i);
};
var FLOORS = [8, 7, 6, 5, 4, 3, 2, 1, 0];
var NAMES = ["Ground", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];
var user = null,
  role = "student",
  openFloor = null,
  selRoom = null;
var profile = {};
// demo live status, seeded so the view looks real

var status = {};
(function () {
  var s = 7;
  for (var f = 0; f <= 8; f++)
    for (var r = 1; r <= 20; r++) {
      s = (s * 9301 + 49297) % 233280;
      if (s % 100 < 38)
        status[f + "-" + r] = {
          occ: true,
          fac: "Prof. Rao",
          from: "09:00",
          to: "10:00",
        };
    }
})();

function load() {
  try {
    var d = JSON.parse(localStorage.getItem("classsync") || "{}");
    profile = d.profile || {};
    user = d.user || null;
  } catch (e) {}
}
function persist() {
  try {
    localStorage.setItem(
      "classsync",
      JSON.stringify({ profile: profile, user: user }),
    );
  } catch (e) {}
}
function toast(m) {
  var t = $("toast");
  t.textContent = m;
  t.classList.add("show");
  setTimeout(function () {
    t.classList.remove("show");
  }, 2200);
}
for (var i = 1; i <= 8; i++) {
  var o = document.createElement("option");
  o.textContent = "Semester " + i;
  o.value = i;
  $("sSem").appendChild(o);
}

function renderAuth() {
  var on = !!user;
  $("loginBtn").hidden = on;
  $("logoutBtn").hidden = !on;
  $("whoami").textContent = on
    ? (user.role === "teacher" ? "Teacher" : "Student") + " · " + user.email
    : "";
  $("gate").hidden = on;
  $("studentPanel").hidden = !(on && user.role === "student");
  $("teacherPanel").hidden = !(on && user.role === "teacher");
  if (on) {
    var p = profile[user.email] || {};
    if (user.role === "student") {
      $("sSem").value = p.sem || "";
      $("sCourse").value = p.course || "";
      $("sBatch").value = p.batch || "";
    } else {
      $("tName").value = p.name || "";
      $("tCourses").value = p.courses || "";
      $("tPlace").value = p.place || "";
      $("tWhere").value = p.where || "";
    }
  }
  renderTower();
}

function renderTower() {
  var t = $("tower");
  t.innerHTML = "";
  FLOORS.forEach(function (f) {
    var used = 0;
    for (var r = 1; r <= 20; r++) if (status[f + "-" + r]) used++;
    var d = document.createElement("div");
    d.className = "floor" + (openFloor === f ? " open" : "");
    var b = document.createElement("button");
    b.className = "fbtn";
    b.setAttribute("aria-expanded", openFloor === f);
    b.innerHTML =
      '<span class="fnum">' +
      f +
      '</span><span class="fname"><b>' +
      (f === 0 ? "Ground floor" : NAMES[f] + " floor") +
      "</b><span>" +
      (20 - used) +
      " free · " +
      used +
      ' occupied</span></span><span class="bar"><div style="width:' +
      used * 5 +
      '%"></div></span><span class="chev">&#9656;</span>';
    b.onclick = function () {
      openFloor = openFloor === f ? null : f;
      selRoom = null;
      renderTower();
    };
    d.appendChild(b);
    if (openFloor === f) {
      var w = document.createElement("div");
      w.className = "rooms";
      var g = document.createElement("div");
      g.className = "grid";
      for (var r = 1; r <= 20; r++)
        (function (r) {
          var s = status[f + "-" + r];
          var x = document.createElement("button");
          x.className =
            "room" + (s ? " occ" : "") + (selRoom === r ? " sel" : "");
          x.textContent = r;
          x.setAttribute(
            "aria-label",
            "Room " + r + (s ? " occupied" : " free"),
          );
          x.onclick = function () {
            selRoom = r;
            renderTower();
          };
          g.appendChild(x);
        })(r);
      w.appendChild(g);
      if (selRoom) w.appendChild(detail(f, selRoom));
      d.appendChild(w);
    }
    t.appendChild(d);
  });
}

function detail(f, r) {
  var s = status[f + "-" + r],
    d = document.createElement("div");
  d.className = "detail";
  var title = "Floor " + f + ", Room " + r;
  if (user && user.role === "teacher") {
    var p = profile[user.email] || {};
    d.innerHTML =
      "<h3>" +
      title +
      '</h3><div class="fields"><label>Status<select id="dSt"><option value="free">Free</option><option value="occ">Occupied</option></select></label><label>Faculty<input id="dFac"></label><label>From<input id="dFrom" type="time"></label><label>To<input id="dTo" type="time"></label></div><div class="row"><button class="pri" id="dSave">Update room</button></div><div class="err" id="dErr"></div>';
    setTimeout(function () {
      $("dSt").value = s ? "occ" : "free";
      $("dFac").value = s ? s.fac : p.name || "";
      $("dFrom").value = s ? s.from : "";
      $("dTo").value = s ? s.to : "";
      $("dSave").onclick = function () {
        if ($("dSt").value === "free") {
          delete status[f + "-" + r];
          toast("Room " + r + " marked free");
          renderTower();
          return;
        }
        if (!$("dFac").value || !$("dFrom").value || !$("dTo").value) {
          $("dErr").textContent =
            "Add faculty name and both times to mark this room occupied.";
          return;
        }
        if ($("dTo").value <= $("dFrom").value) {
          $("dErr").textContent = "End time must be after start time.";
          return;
        }
        if (
          s &&
          !(s.fac === $("dFac").value && s.from === $("dFrom").value) &&
          false
        ) {
        }
        status[f + "-" + r] = {
          occ: true,
          fac: $("dFac").value,
          from: $("dFrom").value,
          to: $("dTo").value,
        };
        toast("Room " + r + " marked occupied");
        renderTower();
      };
    });
  } else {
    d.innerHTML =
      "<h3>" +
      title +
      '</h3><p style="margin:0">' +
      (s
        ? "Occupied by " + s.fac + ", " + s.from + " to " + s.to + "."
        : "Free right now.") +
      "</p>" +
      (user
        ? ""
        : '<p class="hint" style="margin:8px 0 0">Log in as a teacher to change room status.</p>');
  }
  return d;
}

// login
var tab = "student";
function setTab(t) {
  tab = t;
  $("tabS").classList.toggle("on", t === "student");
  $("tabT").classList.toggle("on", t === "teacher");
  $("pwWrap").hidden = t === "student";
  $("otpWrap").hidden = t === "teacher";
  $("lErr").textContent = "";
}
$("tabS").onclick = function () {
  setTab("student");
};
$("tabT").onclick = function () {
  setTab("teacher");
};
$("loginBtn").onclick = function () {
  setTab("student");
  $("dlg").showModal();
};
$("cancelLogin").onclick = function () {
  $("dlg").close();
};
$("doLogin").onclick = function () {
  var e = $("lEmail").value.trim();
  if (!/^\S+@\S+\.\S+$/.test(e)) {
    $("lErr").textContent = "Enter a valid email address.";
    return;
  }
  if (tab === "student" && !/^\d{6}$/.test($("lOtp").value)) {
    $("lErr").textContent = "Enter the 6-digit one-time password.";
    return;
  }
  if (tab === "teacher" && $("lPw").value.length < 4) {
    $("lErr").textContent = "Enter the password the admin gave you.";
    return;
  }
  user = { email: e, role: tab };
  persist();
  $("dlg").close();
  $("lPw").value = "";
  $("lOtp").value = "";
  renderAuth();
  toast("Logged in");
};
$("logoutBtn").onclick = function () {
  user = null;
  selRoom = null;
  persist();
  renderAuth();
  toast("Logged out");
};

$("saveStudent").onclick = function () {
  if (!$("sSem").value || !$("sCourse").value || !$("sBatch").value) {
    toast("Choose semester, course and batch");
    return;
  }
  profile[user.email] = {
    sem: $("sSem").value,
    course: $("sCourse").value,
    batch: $("sBatch").value,
  };
  persist();
  toast("Class details saved");
};

$("saveTeacher").onclick = function () {
  if (!$("tName").value.trim()) {
    toast("Add your name");
    return;
  }
  profile[user.email] = {
    name: $("tName").value.trim(),
    courses: $("tCourses").value.trim(),
    place: $("tPlace").value,
    where: $("tWhere").value.trim(),
  };
  persist();
  toast("Details saved");
};

load();
renderAuth();
