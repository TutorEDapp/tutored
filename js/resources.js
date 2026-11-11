/* ==========================================================================
   TutorED study materials: admins publish past papers, textbooks and notes;
   students open them from Study packs. Files live in the private Supabase
   bucket "study-files". Records live in the "resources" collection.
   ========================================================================== */
(function () {
  "use strict";
  var items = [];
  var fns = [];
  var started = false;
  var TYPE_LABEL = { papers: "Past paper", textbooks: "Textbook", notes: "Study notes" };
  var MAX_BYTES = 50 * 1024 * 1024;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function nice(e) {
    var m = (e && e.message) || "";
    if (/maximum allowed size|too large|payload/i.test(m)) return "That file is too big. The limit is 50 MB. Compress the PDF or split it into parts.";
    if (/mime type|not supported|invalid_mime/i.test(m)) return "Only PDF files can be published.";
    if (/row-level security|permission|not authorized|unauthorized/i.test(m)) return "Only admins can publish study materials. Log in with an admin account.";
    return m || "Something went wrong. Please try again.";
  }
  function sizeText(n) {
    if (!n) return "";
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  }
  function byNewest(a, b) { return String(b.createdAt || "").localeCompare(String(a.createdAt || "")); }

  function notify() {
    var pub = items.filter(function (p) { return p.published !== false; });
    fns.forEach(function (fn) { try { fn(pub); } catch (e) {} });
    renderAdmin();
  }
  function start() {
    if (started || !window.claude || !window.claude.use) return;
    started = true;
    window.claude.use("db").then(function (db) {
      if (!db) return;
      db.collection("resources").onSnapshot(function (snap) {
        items = snap.docs.map(function (d) {
          var x = d.data() || {};
          x.id = d.id;
          x.price = 0;
          x.desc = x.desc || "";
          return x;
        }).sort(byNewest);
        notify();
      }, function () {});
    });
  }

  window.TutorEDResources = {
    // Calls fn with the published materials now and whenever they change.
    onChange: function (fn) {
      fns.push(fn); start();
      // Call back on the next tick, once the page's own scripts have finished loading.
      setTimeout(function () { try { fn(items.filter(function (p) { return p.published !== false; })); } catch (e) {} }, 0);
    },
    // Opens a material in a new tab through a short-lived private link.
    open: function (p) {
      var win = window.open("", "_blank");
      return window.TutorEDFiles.url(p.file).then(function (url) {
        if (win) win.location = url; else window.location.href = url;
      }).catch(function (e) { if (win) win.close(); throw new Error(nice(e)); });
    },
  };

  /* ---------- Admin: Study materials tab ---------- */
  function $(s) { return document.querySelector(s); }
  function say(text, err) {
    var m = $("#res-msg");
    if (!m) return;
    m.textContent = text || "";
    m.classList.toggle("err", !!err);
  }
  function renderAdmin() {
    var list = $("#res-list");
    if (!list) return;
    var counts = document.querySelectorAll("[data-count='materials']");
    for (var i = 0; i < counts.length; i++) counts[i].textContent = items.length;
    if (!items.length) {
      list.innerHTML = '<p class="empty">Nothing published yet. Add your first past paper or textbook above.</p>';
      return;
    }
    var rows = items.map(function (p) {
      var hidden = p.published === false;
      var meta = [p.level, p.subject, p.year].filter(Boolean).join(" · ");
      return '<tr>' +
        '<td><strong>' + esc(p.title) + '</strong><br><span class="muted">' + esc(p.fileName || "") + (p.size ? " · " + sizeText(p.size) : "") + '</span></td>' +
        '<td><span class="tag tag--' + esc(p.type) + '">' + esc(TYPE_LABEL[p.type] || p.type) + '</span><br><span class="muted">' + esc(meta) + '</span></td>' +
        '<td>' + (hidden ? '<span class="pill pill--pending">Hidden</span>' : '<span class="pill pill--approved">Published</span>') + '</td>' +
        '<td><div class="btn-row">' +
          '<button class="btn btn--sm btn--outline" type="button" data-res-open="' + esc(p.id) + '">Open</button>' +
          '<button class="btn btn--sm btn--ghost" type="button" data-res-toggle="' + esc(p.id) + '">' + (hidden ? "Publish" : "Hide") + '</button>' +
          '<button class="btn btn--sm btn--ghost danger-text" type="button" data-res-delete="' + esc(p.id) + '">Delete</button>' +
        '</div>' +
        '<div class="confirm" data-res-confirm="' + esc(p.id) + '" hidden><p><strong>Delete this file for good?</strong> Students will no longer see it. This can\'t be undone.</p>' +
          '<div class="btn-row"><button class="btn btn--danger btn--sm" type="button" data-res-delete-yes="' + esc(p.id) + '">Delete</button>' +
          '<button class="btn btn--outline btn--sm" type="button" data-res-delete-no="' + esc(p.id) + '">Keep it</button></div></div></td>' +
        '</tr>';
    }).join("");
    list.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Title and file</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function publish(form) {
    var v = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; };
    var fileEl = document.getElementById("res-file");
    var file = fileEl && fileEl.files && fileEl.files[0];
    var title = v("res-title"), subject = v("res-subject");
    if (!title) return Promise.reject(new Error("Give it a title."));
    if (!subject) return Promise.reject(new Error("Choose or type a subject."));
    if (!file) return Promise.reject(new Error("Choose the PDF file to publish."));
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return Promise.reject(new Error("Only PDF files can be published."));
    if (file.size > MAX_BYTES) return Promise.reject(new Error("That file is " + sizeText(file.size) + ". The limit is 50 MB. Compress the PDF or split it into parts."));
    if (!window.TutorEDFiles) return Promise.reject(new Error("File publishing works on the live site only."));
    say("Uploading " + file.name + " (" + sizeText(file.size) + "). Large files can take a few minutes. Keep this page open.");
    var up;
    return window.TutorEDFiles.upload(file).then(function (r) {
      up = r;
      return window.claude.use("db");
    }).then(function (db) {
      var year = v("res-year");
      var data = {
        title: title, type: v("res-type") || "papers", subject: subject, level: v("res-level") || "O/L",
        desc: v("res-desc"), file: up.path, fileName: file.name, size: file.size,
        published: true, createdAt: new Date().toISOString(),
      };
      if (year) data.year = year;
      return db.collection("resources").doc().set(data).catch(function (e) {
        // The record failed, so don't leave an orphan file behind.
        return window.TutorEDFiles.remove(up.path).catch(function () {}).then(function () { throw e; });
      });
    }).then(function () {
      form.reset();
      return "Published. Students can now open “" + title + "” from Study packs.";
    });
  }

  function byId(id) { for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i]; return null; }

  function wire() {
    start();
    var form = $("#res-form");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var btn = form.querySelector("button[type=submit]");
        btn.disabled = true;
        publish(form).then(function (msg) { say(msg); }).catch(function (err) { say(nice(err), true); }).then(function () { btn.disabled = false; });
      });
    }
    var list = $("#res-list");
    if (!list) return;
    list.addEventListener("click", function (e) {
      var t = e.target.closest("button");
      if (!t) return;
      var d = t.dataset, p;
      if (d.resOpen) { p = byId(d.resOpen); if (p) window.TutorEDResources.open(p).catch(function (err) { say(err.message, true); }); return; }
      if (d.resDelete) { var c = list.querySelector('[data-res-confirm="' + d.resDelete + '"]'); if (c) c.hidden = false; return; }
      if (d.resDeleteNo) { var c2 = list.querySelector('[data-res-confirm="' + d.resDeleteNo + '"]'); if (c2) c2.hidden = true; return; }
      if (d.resToggle) {
        p = byId(d.resToggle); if (!p) return;
        t.disabled = true;
        window.claude.use("db").then(function (db) { return db.doc("resources/" + p.id).update({ published: p.published === false }); })
          .then(function () { say(p.published === false ? "Published again." : "Hidden from students. The file is kept."); })
          .catch(function (err) { say(nice(err), true); t.disabled = false; });
        return;
      }
      if (d.resDeleteYes) {
        p = byId(d.resDeleteYes); if (!p) return;
        t.disabled = true;
        (p.file ? window.TutorEDFiles.remove(p.file).catch(function () {}) : Promise.resolve())
          .then(function () { return window.claude.use("db"); })
          .then(function (db) { return db.doc("resources/" + p.id).delete(); })
          .then(function () { say("Deleted."); })
          .catch(function (err) { say(nice(err), true); t.disabled = false; });
      }
    });
    renderAdmin();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
})();
