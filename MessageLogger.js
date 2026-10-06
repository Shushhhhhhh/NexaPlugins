// Message Logger: keeps deleted messages on screen instead of letting them
// vanish, and keeps a trail of a message's earlier text when it is edited.
// Everything stays on this device; nothing is sent anywhere.
//
// This builds on NexaPDK (the Nexa Plugin Development Kit): enable that plugin
// too. NexaPDK does the unsupported plumbing — wrapping the message store,
// the context menu and the selection bar — and hands it over as plain
// functions, so this plugin only has to say what to do with them. See
// docs/plugins.md to add it.

export default {
  name: "Message Logger",
  description: "Keeps deleted messages on screen and logs edits, all on this device. Needs NexaPDK.",
  version: "2.3.1",
  author: "Shush",

  settings: [
    { key: "tint", type: "color", label: "Tint", description: "The colour deleted messages are washed with", default: "#ff3b4e" },
    { key: "mine", type: "toggle", label: "Also keep my own deleted messages", default: true },
    { key: "edits", type: "toggle", label: "Log edits (show earlier text under a message)", default: true },
    { key: "cap", type: "number", label: "How many to keep per channel", description: "Oldest drop off past this", min: 20, max: 2000, step: 20, default: 500 },
  ],

  start(api) {
    // NexaPDK may load after this plugin, so wait for it if it is not here yet.
    const boot = (pdk) => this._boot(api, pdk);
    const present = globalThis.NexaPDK;
    if (present) { boot(present); return; }
    const onReady = () => { window.removeEventListener("nexapdk:ready", onReady); const p = globalThis.NexaPDK; if (p) boot(p); };
    window.addEventListener("nexapdk:ready", onReady);
    this._readyOff = () => window.removeEventListener("nexapdk:ready", onReady);
    api.toast("Message Logger needs NexaPDK — enable it too.", "info");
  },

  _boot(api, pdk) {
    const offs = [];            // NexaPDK registrations to undo on stop
    const me = () => (api.me && api.me.id) || null;
    const cap = () => Math.max(20, Number(api.settings.get("cap")) || 500);

    // --- what is kept, and its styling by data-id ----------------------------
    const keptIds = [];
    const keptSet = new Set();
    const keptCopies = new Map();   // id -> the kept store message
    const keptChannel = new Map();  // id -> the channel it was re-inserted into
    const edits = new Map();        // id -> [older texts], oldest first
    const editChannel = new Map();  // id -> channelId, for an edited message
    const purge = new Map();        // id -> time it was marked to delete-for-good
    let removeCss = null;

    const cssEscape = (id) => String(id).replace(/["\\]/g, "\\$&");
    const restyle = () => {
      if (removeCss) { removeCss(); removeCss = null; }
      if (keptIds.length === 0) return;
      const tint = String(api.settings.get("tint") || "#ff3b4e");
      const sel = keptIds.map((id) => `[data-id="${cssEscape(id)}"]`).join(",\n");
      removeCss = api.css.add(
        `${sel} {\n` +
        `  --d-tint: ${tint};\n` +
        `  background: color-mix(in srgb, var(--d-tint) 9%, transparent) !important;\n` +
        `  box-shadow: inset 2px 0 0 0 var(--d-tint);\n` +
        `}`,
      );
    };
    const trackId = (id) => {
      if (keptSet.has(id)) return;
      keptSet.add(id);
      keptIds.push(id);
      while (keptIds.length > cap()) {
        const old = keptIds.shift();
        keptSet.delete(old);
        keptCopies.delete(old);
      }
    };

    // --- on-device logs (for /deleted and /edits) ----------------------------
    const logKey = (channelId) => `del:${channelId}`;
    const editKey = (channelId) => `edit:${channelId}`;
    const remember = (channelId, msg) => {
      try {
        const log = api.storage.get(logKey(channelId)) || [];
        log.push({ id: msg.id, authorId: msg.author_id, content: (msg.payload && msg.payload.t) || "", at: msg.created_at || Date.now() });
        while (log.length > cap()) log.shift();
        api.storage.set(logKey(channelId), log);
      } catch { /* storage off or full */ }
    };
    const rememberEdit = (channelId, id, was) => {
      try {
        const log = api.storage.get(editKey(channelId)) || [];
        log.push({ id, was, at: Date.now() });
        while (log.length > cap()) log.shift();
        api.storage.set(editKey(channelId), log);
      } catch { /* ignore */ }
    };
    const dropTracking = (channelId, id) => {
      keptCopies.delete(id);
      keptChannel.delete(id);
      keptSet.delete(id);
      const i = keptIds.indexOf(id);
      if (i >= 0) keptIds.splice(i, 1);
      edits.delete(id);
      editChannel.delete(id);
      pdk.clearMessageDecoration(id, "edit-trail");
      try {
        api.storage.set(logKey(channelId), (api.storage.get(logKey(channelId)) || []).filter((e) => e.id !== id));
        api.storage.set(editKey(channelId), (api.storage.get(editKey(channelId)) || []).filter((e) => e.id !== id));
      } catch { /* ignore */ }
    };

    // Put a deleted message back, tinted. `full` is the real message as it was.
    const keepDeleted = (channelId, full) => {
      if (full.author_id === me() && !api.settings.get("mine")) return;
      if (!keptCopies.has(full.id)) {
        keptCopies.set(full.id, { ...full });   // kept as it was; the red highlight marks it
        remember(channelId, full);
      }
      keptChannel.set(full.id, channelId);       // remove from exactly where we re-inserted it
      pdk.insert(channelId, keptCopies.get(full.id));
      trackId(full.id);
      restyle();
    };

    // Take a kept message off this client for good (no re-keep: remove is raw).
    const forget = (id) => {
      // Remove it from every channel that still holds it. removeMany is a no-op
      // when handed a channel the message is not in, and a kept message can sit
      // under a channel key that is not its own channel_id (threads, follows),
      // so scanning is what reliably takes it off the client.
      const channels = (pdk.stores.messages.getState().channels) || {};
      let where = keptChannel.get(id) || null;
      for (const cid of Object.keys(channels)) {
        const byId = channels[cid] && channels[cid].byId;
        if (byId && byId[id]) { pdk.remove(cid, id); where = where || cid; }
      }
      dropTracking(where, id);
      restyle();
    };

    // Drop only a (live) message's edit history: the trail and its log, leaving
    // the message itself in place.
    const clearEditHistory = (id) => {
      const channelId = editChannel.get(id);
      edits.delete(id);
      editChannel.delete(id);
      pdk.clearMessageDecoration(id, "edit-trail");
      if (channelId) {
        try { api.storage.set(editKey(channelId), (api.storage.get(editKey(channelId)) || []).filter((e) => e.id !== id)); } catch { /* ignore */ }
      }
    };

    const isPurging = (id) => {
      const at = purge.get(id);
      if (at === undefined) return false;
      if (Date.now() - at > 120000) { purge.delete(id); return false; }
      return true;
    };

    // --- deletes: keep them, unless marked to go for good --------------------
    offs.push(pdk.onDelete(({ channelId, ids, messages }) => {
      ids.forEach((id, i) => {
        if (isPurging(id)) { purge.delete(id); dropTracking(channelId, id); return; }
        const full = messages[i];
        if (full) keepDeleted(channelId, full);
      });
      restyle();
    }));

    // --- edit logging --------------------------------------------------------
    // NexaPDK hands over real text changes with clean old/new text. The trail
    // is drawn as DOM above the message (so the message's own text is never
    // touched and copying it stays clean): earlier versions oldest-first as
    // grey lines, then a thin rule, then the current text below.
    api.css.add(
      ".msglog-trail { margin: 1px 0 2px; }\n" +
      ".msglog-old { color: var(--text-muted); font-size: 0.8125em; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; }\n" +
      ".msglog-sep { border-top: 1px solid var(--border-strong); margin: 3px 0; }",
    );
    const showTrail = (id) => {
      const past = edits.get(id) || [];
      if (past.length === 0) { pdk.clearMessageDecoration(id, "edit-trail"); return; }
      const box = document.createElement("div");
      box.className = "msglog-trail";
      for (const w of past) {
        const line = document.createElement("div");
        line.className = "msglog-old";
        line.textContent = w || "(empty)";      // textContent: the old text is shown, never run as markup
        box.appendChild(line);
      }
      const sep = document.createElement("div");
      sep.className = "msglog-sep";
      box.appendChild(sep);
      pdk.decorateMessage(id, "edit-trail", box, { position: "before" });
    };
    offs.push(pdk.onEdit(({ channelId, id, before }) => {
      if (!api.settings.get("edits")) return;
      const list = edits.get(id) || [];
      list.push(before);                   // oldest-first: pushed in the order edits happen
      while (list.length > 20) list.shift();
      edits.set(id, list);
      editChannel.set(id, channelId);
      rememberEdit(channelId, id, before);
      showTrail(id);
    }));

    api.settings.onChange(restyle);

    // --- context menu: "Delete Message History" ------------------------------
    // Deleted message: replaces "Delete Message" (removes the kept copy here).
    // Edited (not deleted): sits beside "Delete Message" and clears the trail.
    offs.push(pdk.contextMenu((ctx) => {
      const id = ctx.messageId;
      if (!id) return;
      const deleted = keptSet.has(id);
      const edited = (edits.get(id) || []).length > 0;
      const di = ctx.items.findIndex((it) => it && it.id === "delete");
      if (deleted) {
        // Already deleted on the server: "Delete Message" has nothing to do, so
        // replace it with "Delete Message History", which removes the message
        // from this client. No bin icon: the red highlight already marks it.
        const base = di >= 0 ? ctx.items[di] : { danger: true };
        const item = { ...base, id: "msglog-del-history", label: "Delete Message History", icon: undefined, submenu: undefined, keys: undefined, onSelect: () => forget(id) };
        if (di >= 0) ctx.items[di] = item;
        else { if (ctx.items.length) ctx.items[ctx.items.length - 1] = { ...ctx.items[ctx.items.length - 1], separatorAfter: true }; ctx.items.push(item); }
      } else if (edited) {
        // Not deleted: keep "Delete Message", and add "Delete Message History",
        // which clears only the edit trail and leaves the message in place.
        const item = { id: "msglog-del-history", label: "Delete Message History", danger: true, onSelect: () => clearEditHistory(id) };
        if (di >= 0) ctx.items.splice(di + 1, 0, item);
        else { if (ctx.items.length) ctx.items[ctx.items.length - 1] = { ...ctx.items[ctx.items.length - 1], separatorAfter: true }; ctx.items.push(item); }
      }
    }));

    // --- selection bar: a second button when a deleted message is picked -----
    // Marks the picked messages, then runs the app's own delete (its confirm +
    // server delete). Nothing is cleared until that goes through, so cancelling
    // the prompt leaves history untouched; on accept, onDelete above sees the
    // mark and removes them for good instead of keeping them.
    offs.push(pdk.selectionButton({
      key: "purge",
      label: "Delete Messages & Remove from History",
      when: (ids) => ids.some((id) => keptSet.has(id)),
      onClick: (ids) => {
        if (!ids.length) return;
        const now = Date.now();
        ids.forEach((id) => purge.set(id, now));
        const del = document.querySelector('[data-testid="selection-bar"] [data-testid="delete-selected"]');
        if (del && !del.disabled) del.click();
      },
    }));

    // --- review commands (print to you; send nothing) ------------------------
    api.commands.register({
      name: "deleted",
      description: "Lists the deleted messages kept for this channel",
      run: (_a, ctx) => {
        const log = api.storage.get(logKey(ctx.channelId)) || [];
        api.toast(log.length ? `${log.length} deleted here. See the console.` : "Nothing deleted kept here.", "info");
        if (log.length) console.table(log.map((e) => ({ at: new Date(e.at).toLocaleString(), author: e.authorId, text: e.content })));
        return null;
      },
    });
    api.commands.register({
      name: "edits",
      description: "Lists the logged edits for this channel",
      run: (_a, ctx) => {
        const log = api.storage.get(editKey(ctx.channelId)) || [];
        api.toast(log.length ? `${log.length} edit(s) logged here. See the console.` : "No edits logged here.", "info");
        if (log.length) console.table(log.map((e) => ({ at: new Date(e.at).toLocaleString(), id: e.id, was: e.was })));
        return null;
      },
    });

    this._offs = offs;
    // edit trails are decorations NexaPDK holds, so clear them ourselves when
    // we stop (NexaPDK may keep running for other plugins).
    this._clearDecos = () => { for (const id of [...edits.keys()]) pdk.clearMessageDecoration(id, "edit-trail"); };
  },

  stop() {
    if (this._readyOff) { this._readyOff(); this._readyOff = null; }
    if (this._clearDecos) { try { this._clearDecos(); } catch { /* ignore */ } this._clearDecos = null; }
    if (this._offs) { for (const off of this._offs) { try { off(); } catch { /* ignore */ } } this._offs = null; }
    // css, events and commands are taken away for us
  },
};
