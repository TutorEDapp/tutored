/* ==========================================================================
   TutorED hosted back end: connects the site to Supabase.
   It offers the same small db / user / assets interface the test version used,
   so the pages and dashboards work unchanged. Only public values live here.
   ========================================================================== */
(function () {
  "use strict";
  const CFG = window.TUTORED_CONFIG || {};
  if (!window.supabase || !CFG.supabaseUrl || !CFG.publishableKey) return;
  // Coming back from an email confirmation link? Note it before the address bar is cleaned up.
  const hash0 = location.hash || "";
  // type=invite (admin invited them) or type=recovery (forgot password): they must choose a password next.
  const linkType = ((hash0.match(/[#&]type=([a-z_]+)/) || [])[1]) || "";
  window.TutorEDAuthReturn = { ok: /access_token=/.test(hash0), error: /error(_code|_description)?=/.test(hash0), setPassword: linkType === "invite" || linkType === "recovery", type: linkType };
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.publishableKey);
  const SITE = location.origin + location.pathname;
  const BUCKET = CFG.storageBucket || "tutor-docs";
  const copy = (o) => JSON.parse(JSON.stringify(o));

  function nice(e, fallback) {
    const msg = (e && e.message) || "";
    const code = e && e.code;
    if (code === "23505") return new Error("Someone just booked that time. Pick another one.");
    if (code === "42501" || /row-level security|permission denied/i.test(msg)) return new Error("You don't have permission to do that. Log in again and retry.");
    if (/already registered|already been registered/i.test(msg)) return new Error("That email already has an account. Log in instead.");
    if (/email not confirmed/i.test(msg)) return new Error("Confirm your email first. Enter the code we emailed you.");
    if (/token has expired|otp.*(expired|invalid)|invalid.*(otp|token)/i.test(msg)) return new Error("That code is wrong or has expired. Check it, or send a new one.");
    if (/only request this after (\d+) seconds/i.test(msg)) return new Error("Please wait " + msg.match(/after (\d+) seconds/i)[1] + " seconds before asking for another code.");
    if (/invalid login credentials/i.test(msg)) return new Error("That email and password don't match. Check them and try again.");
    if (/password should be/i.test(msg)) return new Error("Choose a longer password (at least 6 characters).");
    if (/rate limit|too many/i.test(msg)) return new Error("Too many attempts. Wait a minute and try again.");
    if (/failed to fetch|network/i.test(msg)) return new Error("Can't reach the server. Check your connection and try again.");
    return new Error(msg || fallback || "Something went wrong. Please try again.");
  }

  /* ---------- identity ---------- */
  let session = null;
  const sessionReady = sb.auth.getSession().then(({ data }) => { session = (data && data.session) || null; }).catch(() => {});
  const uid = () => (session && session.user && session.user.id) || null;
  sb.auth.onAuthStateChange((_evt, s) => { session = s || null; setTimeout(pokeAll, 0); });

  /* ---------- live data ---------- */
  const listeners = {}; // collection -> Set of refresh functions
  const channels = {};
  function poke(col) { (listeners[col] ? Array.from(listeners[col]) : []).forEach((fn) => { try { fn(); } catch (e) {} }); }
  function pokeAll() { Object.keys(listeners).forEach(poke); }
  function listen(col, fn) {
    if (!listeners[col]) listeners[col] = new Set();
    listeners[col].add(fn);
    if (!channels[col]) {
      try {
        channels[col] = sb.channel("docs-" + col)
          .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "collection=eq." + col }, () => poke(col))
          .subscribe();
      } catch (e) { channels[col] = true; }
    }
    return () => listeners[col].delete(fn);
  }
  // Safety net in case a live update is missed.
  setInterval(() => { if (!document.hidden) pokeAll(); }, 30000);

  const snapDoc = (id, data) => ({ id, exists: data != null, data: () => (data == null ? undefined : copy(data)), metadata: { fromCache: false, hasPendingWrites: false } });

  async function fetchRows(col) {
    await sessionReady;
    if (!uid()) return [];
    const { data, error } = await sb.from("docs").select("id,data").eq("collection", col).limit(1000);
    if (error) throw nice(error);
    const rows = (data || []).map((r) => ({ id: r.id, data: r.data || {} }));
    if (col === "bookings") {
      // Add times other students have booked (no names), so they can't be double-booked.
      try {
        const { data: taken } = await sb.rpc("taken_slots");
        const have = new Set(rows.filter((r) => r.data.status === "confirmed").map((r) => r.data.tutorId + "|" + r.data.start));
        (taken || []).forEach((t, i) => {
          if (!have.has(t.tutor_id + "|" + t.start)) rows.push({ id: "taken-" + i, data: { tutorId: t.tutor_id, start: t.start, minutes: t.minutes, status: "confirmed", taken: true } });
        });
      } catch (e) {}
    }
    return rows;
  }

  function splitPath(path) { const i = path.indexOf("/"); return [path.slice(0, i), path.slice(i + 1)]; }

  function docRef(path) {
    const [col, id] = splitPath(path);
    const read = async () => {
      await sessionReady;
      if (!uid()) return snapDoc(id, null);
      const { data, error } = await sb.from("docs").select("data").eq("collection", col).eq("id", id).maybeSingle();
      if (error) throw nice(error);
      return snapDoc(id, data ? data.data || {} : null);
    };
    return {
      id, path,
      get: read,
      async set(d) {
        const { error } = await sb.from("docs").upsert({ collection: col, id, data: copy(d) }, { onConflict: "collection,id" });
        if (error) throw nice(error);
        poke(col);
      },
      async update(patch) {
        const cur = await read();
        if (!cur.exists) throw new Error("That record no longer exists.");
        const next = cur.data();
        const merge = (a, b) => { for (const k in b) { if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) merge(a[k], b[k]); else a[k] = b[k]; } };
        merge(next, copy(patch));
        const { data, error } = await sb.from("docs").update({ data: next }).eq("collection", col).eq("id", id).select("id");
        if (error) throw nice(error);
        if (!data || !data.length) throw new Error("You don't have permission to change that.");
        poke(col);
      },
      async delete() {
        const { error } = await sb.from("docs").delete().eq("collection", col).eq("id", id);
        if (error) throw nice(error);
        poke(col);
      },
      onSnapshot(next, onErr) {
        let alive = true;
        const run = () => read().then((s) => { if (alive) next(s); }).catch((e) => { if (alive && onErr) onErr(e); });
        const off = listen(col, run);
        run();
        return () => { alive = false; off(); };
      },
    };
  }

  function query(col, filters, order, lim) {
    const run = async () => {
      let docs = (await fetchRows(col)).map((r) => snapDoc(r.id, r.data));
      for (const [f, op, v] of filters) docs = docs.filter((d) => (op === "in" ? v.includes(d.data()[f]) : d.data()[f] === v));
      if (order) docs.sort((a, b) => String(a.data()[order[0]] ?? "").localeCompare(String(b.data()[order[0]] ?? "")) * (order[1] === "desc" ? -1 : 1));
      docs = docs.slice(0, lim);
      return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false }, docChanges: () => [] };
    };
    const newId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
    return {
      path: col,
      where: (a, b, c) => query(col, filters.concat([[a, b, c]]), order, lim),
      orderBy: (a, d) => query(col, filters, [a, d || "asc"], lim),
      limit: (l) => query(col, filters, order, l),
      get: run,
      onSnapshot(next, onErr) {
        let alive = true;
        const go = () => run().then((s) => { if (alive) next(s); }).catch((e) => { if (alive && onErr) onErr(e); });
        const off = listen(col, go);
        go();
        return () => { alive = false; off(); };
      },
      doc: (id) => docRef(col + "/" + (id || newId())),
      async add(d) { const r = docRef(col + "/" + newId()); await r.set(d); return r; },
    };
  }

  const db = { doc: docRef, collection: (p) => query(p, [], null, 1000) };

  const user = {
    async id() { await sessionReady; return uid(); },
    async canEdit() {
      await sessionReady;
      if (!uid()) return false;
      try { const { data } = await sb.rpc("is_admin"); return !!data; } catch (e) { return false; }
    },
    async isOwner() { return this.canEdit(); },
    async me() { await sessionReady; const u = session && session.user; return u ? { id: u.id, name: u.email, email: u.email } : {}; },
    async profiles() { return {}; },
  };

  const assets = {
    async upload(file, opts) {
      await sessionReady;
      if (!uid()) throw new Error("Log in before uploading files.");
      const safe = String(file.name || "file").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
      const path = uid() + "/" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8) + "-" + safe;
      const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: (opts && opts.type) || file.type, upsert: false });
      if (error) throw nice(error, "The file couldn't be uploaded.");
      return { id: path, contentType: (opts && opts.type) || file.type, sizeBytes: file.size };
    },
    async delete(id) { const { error } = await sb.storage.from(BUCKET).remove([id]); if (error) throw nice(error); return { deleted: true }; },
    // Private files: a short-lived link, only for the owner and admins.
    async url(id) {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(id, 600);
      if (error) throw nice(error, "That file couldn't be opened.");
      return data.signedUrl;
    },
  };

  window.TutorEDAuth = {
    async signUp(email, password, profile) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: profile || {}, emailRedirectTo: SITE } });
      if (error) throw nice(error);
      // Supabase hides whether an address is taken: an existing account comes back with no identities.
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw new Error("That email already has an account. Log in instead.");
      session = data.session || null;
      return { confirm: !session };
    },
    // Checks the code from the confirmation email and logs the person in.
    async verify(email, code) {
      let res = await sb.auth.verifyOtp({ email, token: code, type: "email" });
      if (res.error) { const again = await sb.auth.verifyOtp({ email, token: code, type: "signup" }); if (!again.error) res = again; }
      if (res.error) throw nice(res.error);
      session = (res.data && res.data.session) || null;
      if (!session) throw new Error("That code didn't work. Send a new one and try again.");
    },
    async resend(email) {
      const { error } = await sb.auth.resend({ type: "signup", email, options: { emailRedirectTo: SITE } });
      if (error) throw nice(error);
    },
    // What the person typed at sign-up (kept with their login until the profile is saved).
    profile() { return (session && session.user && session.user.user_metadata) || null; },
    // True when new accounts must confirm their email before logging in.
    async needsConfirm() {
      try { const r = await fetch(CFG.supabaseUrl + "/auth/v1/settings", { headers: { apikey: CFG.publishableKey } }); const j = await r.json(); return j.mailer_autoconfirm === false; }
      catch (e) { return false; }
    },
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw nice(error);
      session = data.session || null;
    },
    async signOut() { try { await sb.auth.signOut(); } catch (e) {} session = null; pokeAll(); },
    // Sets a new password for whoever is signed in (after an invite or reset link, or from the dashboard).
    async setPassword(password) {
      await sessionReady;
      if (!uid()) throw new Error("This link has expired or was already used. Ask for a new one, then try again.");
      const { error } = await sb.auth.updateUser({ password });
      if (error) {
        if (/different from the old/i.test(error.message || "")) throw new Error("That's your current password. Choose a new one.");
        throw nice(error);
      }
    },
    // Emails a link that signs the person in so they can choose a new password.
    async sendReset(email) {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: SITE });
      if (error) throw nice(error);
    },
  };
  sb.auth.onAuthStateChange((evt) => { if (evt === "PASSWORD_RECOVERY") window.TutorEDAuthReturn.setPassword = true; });

  // Creates or cancels the Google Meet lesson for a booking (runs on the server).
  window.TutorEDLesson = async function (bookingId, action) {
    const { data, error } = await sb.functions.invoke(CFG.lessonFunction || "lesson-link", { body: { bookingId, action: action || "create" } });
    if (error) {
      let msg = error.message;
      try { const body = await error.context.json(); if (body && body.error) msg = body.error; } catch (e) {}
      throw new Error(msg || "The lesson link couldn't be created.");
    }
    if (data && data.error) throw new Error(data.error);
    poke("bookings");
    return data || {};
  };

  /* ---------- Chat between students and tutors ----------
     Table chat_messages: one row per message. Supabase security rules let each
     person see only their own conversations (admins see all). */
  const chatFns = new Set();
  let chatChannel = null;
  function chatPoke() { Array.from(chatFns).forEach((fn) => { try { fn(); } catch (e) {} }); }
  window.TutorEDChat = {
    async me() { await sessionReady; return uid(); },
    async list() {
      await sessionReady;
      const me = uid();
      if (!me) return [];
      const { data, error } = await sb.from("chat_messages")
        .select("id,student_id,tutor_id,sender_id,student_name,tutor_name,body,created_at,read_at")
        .or("student_id.eq." + me + ",tutor_id.eq." + me)
        .order("created_at", { ascending: true }).limit(2000);
      if (error) throw nice(error, "Couldn't load your messages.");
      return data || [];
    },
    async send(m) {
      await sessionReady;
      const me = uid();
      if (!me) throw new Error("Log in again to send messages.");
      const body = String(m.body || "").trim().slice(0, 2000);
      if (!body) throw new Error("Type a message first.");
      const { error } = await sb.from("chat_messages").insert({
        student_id: m.studentId, tutor_id: m.tutorId, sender_id: me,
        student_name: m.studentName || null, tutor_name: m.tutorName || null, body,
      });
      if (error) throw nice(error, "Your message wasn't sent. Try again.");
      chatPoke();
    },
    // Marks every message the other person sent in this conversation as read.
    async markRead(studentId, tutorId) {
      await sessionReady;
      const me = uid();
      if (!me) return;
      await sb.from("chat_messages").update({ read_at: new Date().toISOString() })
        .eq("student_id", studentId).eq("tutor_id", tutorId).neq("sender_id", me).is("read_at", null);
    },
    // Calls fn whenever a message arrives or changes. Returns a function to stop.
    subscribe(fn) {
      chatFns.add(fn);
      if (!chatChannel) {
        try {
          chatChannel = sb.channel("chat-messages")
            .on("postgres_changes", { event: "*", schema: "public", table: "chat_messages" }, chatPoke)
            .subscribe();
        } catch (e) { chatChannel = true; }
      }
      return () => chatFns.delete(fn);
    },
  };
  // Safety net in case a live update is missed.
  setInterval(() => { if (!document.hidden && chatFns.size) chatPoke(); }, 15000);

  /* ---------- Study materials (files published by admins) ---------- */
  const STUDY = CFG.studyBucket || "study-files";
  window.TutorEDFiles = {
    async upload(file) {
      await sessionReady;
      if (!uid()) throw new Error("Log in before uploading files.");
      const safe = String(file.name || "file.pdf").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
      const path = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8) + "-" + safe;
      const { error } = await sb.storage.from(STUDY).upload(path, file, { contentType: file.type || "application/pdf", upsert: false });
      if (error) throw error;
      return { path, size: file.size, name: file.name };
    },
    // A private link that works for one hour. Only signed-in people can get one.
    async url(path) {
      const { data, error } = await sb.storage.from(STUDY).createSignedUrl(path, 3600);
      if (error) throw nice(error, "That file couldn't be opened.");
      return data.signedUrl;
    },
    async remove(path) { const { error } = await sb.storage.from(STUDY).remove([path]); if (error) throw nice(error); },
  };

  /* ---------- Tutor profile photos (public, shown on tutor cards) ---------- */
  window.TutorEDAvatar = {
    // Stores the photo and returns its web address. The old photo, if any, is removed.
    async upload(blob, oldUrl) {
      await sessionReady;
      if (!uid()) throw new Error("Log in before uploading a photo.");
      const path = uid() + "/photo-" + Date.now().toString(36) + ".jpg";
      const { error } = await sb.storage.from("avatars").upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (error) throw nice(error, "The photo couldn't be uploaded.");
      const mark = "/object/public/avatars/";
      const at = String(oldUrl || "").indexOf(mark);
      if (at >= 0) { try { await sb.storage.from("avatars").remove([decodeURIComponent(oldUrl.slice(at + mark.length))]); } catch (e) {} }
      return sb.storage.from("avatars").getPublicUrl(path).data.publicUrl;
    },
  };

  /* ---------- Homework and documents between a tutor and a student ----------
     Files live under <tutor id>/<student id>/ so only those two people (and admins) can open them. */
  window.TutorEDClassFiles = {
    async upload(file, tutorId, studentId, prefix) {
      await sessionReady;
      if (!uid()) throw new Error("Log in before uploading files.");
      const safe = String(file.name || "file").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
      const path = tutorId + "/" + studentId + "/" + (prefix || "file") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8) + "-" + safe;
      const { error } = await sb.storage.from("class-files").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (error) throw nice(error, "The file couldn't be uploaded.");
      return { path, name: file.name || "file", size: file.size };
    },
    // A private link that works for one hour.
    async url(path) {
      const { data, error } = await sb.storage.from("class-files").createSignedUrl(path, 3600);
      if (error) throw nice(error, "That file couldn't be opened.");
      return data.signedUrl;
    },
    async remove(paths) { const { error } = await sb.storage.from("class-files").remove(paths); if (error) throw nice(error); },
  };

  // Admin-only helpers: list admin accounts and fully delete an account (profile, bookings, login).
  window.TutorEDAdmin = {
    async admins() { const { data, error } = await sb.rpc("admin_list"); if (error) throw nice(error); return data || []; },
    async deleteUser(id) { const { error } = await sb.rpc("admin_delete_user", { target: id }); if (error) throw new Error(error.message || "The account couldn't be deleted."); pokeAll(); },
  };

  window.TutorEDHosted = true;
  window.claude = { use: async (name) => ({ db, user, assets })[name] || null };
})();
