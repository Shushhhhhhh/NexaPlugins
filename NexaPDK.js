// NexaPDK — the Nexa Plugin Development Kit, a library plugin.
//
// Plugins cannot import one another (each runs from its own blob: module), so
// this one publishes a toolkit on `globalThis.NexaPDK` that other plugins read.
// It wraps the app's unsupported surfaces once — the message store, the
// context menu, the hover toolbar and the selection bar — and turns them into
// ordinary functions, so a plugin can hook deletes and edits, add or change
// context-menu items, add or hide toolbar buttons, and add a selection-bar
// button without each reinventing the DOM and store plumbing.
//
// Enable this before the plugins that use it. In a consumer plugin:
//
//   start(api) {
//     const kit = globalThis.NexaPDK;
//     if (!kit) { api.toast("Enable NexaPDK first.", "error"); return; }
//     const off = kit.onDelete(({ channelId, messages }) => {
//       for (const m of messages) if (m) kit.insert(channelId, m); // keep it
//     });
//     this._off = off;             // call in stop()
//   }
//
// Everything a consumer registers returns an unsubscribe function; call it in
// the consumer's stop(). When NexaPDK itself stops, every wrap and listener
// is put back and `globalThis.NexaPDK` is removed.
//
// All of this leans on app internals that the official API does not promise;
// it can break on an app update. It is for your own device.

export default {
  name: "NexaPDK (Nexa Plugin Development Kit)",
  description: "A toolkit other plugins build on: message hooks (delete/edit), message decorations, context menu, toolbar and selection-bar helpers.",
  version: "1.2.1",
  author: "Shush",

  start(api) {
    const stores = api.unsupported.stores;
    const messagesStore = stores && stores.messages;
    const uiStore = stores && stores.ui;
    if (!messagesStore || typeof messagesStore.getState !== "function") {
      api.toast("NexaPDK: this build's stores moved; the library needs an update.", "error");
      return;
    }

    const disposers = [];         // run on stop, newest first
    const onDispose = (fn) => { disposers.push(fn); };

    // ---- small helpers ------------------------------------------------------
    const subList = () => {
      const set = new Set();
      return {
        add: (fn) => { set.add(fn); return () => set.delete(fn); },
        each: (run) => { for (const fn of [...set]) { try { run(fn); } catch (e) { console.warn("NexaPDK handler failed", e); } } },
        get size() { return set.size; },
      };
    };
    const rafThrottle = (fn) => {
      let scheduled = 0;
      return () => { if (scheduled) return; scheduled = requestAnimationFrame(() => { scheduled = 0; fn(); }); };
    };
    const messageRowOf = (el) => (el && el.closest ? el.closest("[data-id][data-row]") : null);

    // ---- messages -----------------------------------------------------------
    const ms = () => messagesStore.getState();
    const origInsert = ms().insert;
    const origUpdate = ms().update;
    const origRemoveMany = ms().removeMany;

    const getMessage = (channelId, id) => ((ms().channels[channelId] || {}).byId || {})[id];
    const insert = (channelId, msg) => origInsert.call(ms(), channelId, Array.isArray(msg) ? msg : [msg]);
    const updateRaw = (channelId, msg) => origUpdate.call(ms(), channelId, msg);
    const removeRaw = (channelId, ids) => origRemoveMany.call(ms(), channelId, Array.isArray(ids) ? ids : [ids]);

    const deleteSubs = subList();
    const updateSubs = subList();

    // Wrap removeMany: it is the one path every delete (single, bulk, local,
    // remote) goes through. Handlers get the full messages as they were, just
    // before removal, and may re-add them with kit.insert.
    if (typeof origRemoveMany === "function") {
      messagesStore.setState({
        removeMany: (channelId, ids) => {
          const list = Array.isArray(ids) ? ids : [ids];
          let messages = [];
          if (deleteSubs.size) {
            const byId = (ms().channels[channelId] || {}).byId || {};
            messages = list.map((id) => byId[id]);
          }
          origRemoveMany.call(ms(), channelId, list);
          if (deleteSubs.size) deleteSubs.each((fn) => fn({ channelId, ids: list, messages }));
        },
      });
      onDispose(() => messagesStore.setState({ removeMany: origRemoveMany }));
    }

    // Wrap update: handlers get { before, after } when a message is replaced
    // (an edit, a late link preview, …). kit.update writes without firing this.
    if (typeof origUpdate === "function") {
      messagesStore.setState({
        update: (channelId, msg) => {
          const before = updateSubs.size ? getMessage(channelId, msg.id) : undefined;
          origUpdate.call(ms(), channelId, msg);
          if (updateSubs.size) updateSubs.each((fn) => fn({ channelId, id: msg.id, before, after: msg }));
        },
      });
      onDispose(() => messagesStore.setState({ update: origUpdate }));
    }

    // onEdit: a genuine text change, with the clean old and new text. Built on
    // the supported message events (so the texts are what was shown, not any
    // display the store was rewritten to carry), and only fires when the text
    // actually changed and the earlier text was seen on this device.
    const editSubs = subList();
    const seenText = new Map();
    api.events.on("messageCreate", (m) => { if (m.decrypted) seenText.set(m.id, m.content || ""); });
    api.events.on("messageUpdate", (m) => {
      if (!m.decrypted) return;
      const after = m.content || "";
      const before = seenText.get(m.id);
      seenText.set(m.id, after);
      if (before === undefined || before === after || !editSubs.size) return;
      editSubs.each((fn) => fn({ channelId: m.channelId, id: m.id, before, after, message: m }));
    });

    // ---- context menu -------------------------------------------------------
    // The menu state carries no source, so the row under the pointer is caught
    // from the DOM: a right click fires contextmenu, the three-dots button a
    // plain pointerdown. Modifiers get { items, messageId, element }.
    const menuSubs = subList();
    let lastTarget = null;
    let origOpenMenu = null;
    if (uiStore && typeof uiStore.getState === "function" && typeof uiStore.getState().openContextMenu === "function") {
      const onPoint = (e) => {
        const row = messageRowOf(e.target);
        lastTarget = row ? { id: row.getAttribute("data-id"), element: row, at: Date.now() } : null;
      };
      document.addEventListener("contextmenu", onPoint, true);
      document.addEventListener("pointerdown", onPoint, true);
      onDispose(() => { document.removeEventListener("contextmenu", onPoint, true); document.removeEventListener("pointerdown", onPoint, true); });

      origOpenMenu = uiStore.getState().openContextMenu;
      uiStore.setState({
        openContextMenu: (m) => {
          if (menuSubs.size && m && Array.isArray(m.items)) {
            const fresh = lastTarget && Date.now() - lastTarget.at < 1500 ? lastTarget : null;
            const ctx = { items: m.items.slice(), messageId: fresh ? fresh.id : null, element: fresh ? fresh.element : null };
            menuSubs.each((fn) => { const r = fn(ctx); if (Array.isArray(r)) ctx.items = r; });
            m = { ...m, items: ctx.items };
          }
          origOpenMenu(m);
        },
      });
      onDispose(() => uiStore.setState({ openContextMenu: origOpenMenu }));
    }

    // ---- DOM watcher for toolbars and the selection bar ---------------------
    const toolbarSubs = subList();     // fn(ctx) when a message toolbar appears
    const selectionDefs = new Set();   // { key, label, when(ids), onClick(ids), danger }

    const pickedIds = () => Array.from(document.querySelectorAll("[data-row][data-picked]")).map((el) => el.getAttribute("data-id")).filter(Boolean);

    const styleFrom = (btn) => (btn ? btn.className : "");

    const applyToolbars = () => {
      if (!toolbarSubs.size) return;
      for (const bar of document.querySelectorAll('[role="toolbar"]')) {
        const row = messageRowOf(bar);
        if (!row) continue;
        const messageId = row.getAttribute("data-id");
        const ctx = {
          bar, row, messageId,
          // Add a button that looks like the others. `key` keeps it unique per
          // toolbar, so re-renders do not pile up copies.
          addButton: ({ key, title, icon, text, danger, onClick }) => {
            const mark = `nk-${key || title || "btn"}`;
            if (bar.querySelector(`[data-nexapdk="${CSS.escape(mark)}"]`)) return null;
            const sample = bar.querySelector("button");
            const b = document.createElement("button");
            b.type = "button";
            b.className = styleFrom(sample);
            b.setAttribute("data-nexapdk", mark);
            if (title) { b.setAttribute("aria-label", title); b.setAttribute("title", title); }
            if (icon) b.innerHTML = icon; else b.textContent = text || "";
            if (danger) b.setAttribute("data-nk-danger", "");
            b.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); if (onClick) onClick({ messageId, row, bar, event }); });
            const more = bar.lastElementChild;      // the "more" button is last
            if (more) bar.insertBefore(b, more); else bar.appendChild(b);
            return b;
          },
          // Hide buttons already in the toolbar. `match` is a predicate on the
          // button, or a string matched against its aria-label (case-insensitive).
          hide: (match) => {
            const test = typeof match === "function" ? match : (btn) => (btn.getAttribute("aria-label") || "").toLowerCase().includes(String(match).toLowerCase());
            for (const btn of bar.querySelectorAll("button")) if (test(btn)) btn.style.display = "none";
          },
        };
        toolbarSubs.each((fn) => fn(ctx));
      }
    };

    const selectionButtons = new Map();  // def -> injected element
    const applySelectionBar = () => {
      const bar = document.querySelector('[data-testid="selection-bar"]');
      if (!bar) { for (const [, el] of selectionButtons) el.remove(); selectionButtons.clear(); return; }
      const ids = pickedIds();
      const anchor = bar.querySelector('[data-testid="delete-selected"]') || bar.lastElementChild;
      for (const def of selectionDefs) {
        const show = anchor && (!def.when || def.when(ids));
        let el = selectionButtons.get(def);
        if (show) {
          if (!el) {
            el = document.createElement("button");
            el.type = "button";
            el.className = styleFrom(anchor);
            el.setAttribute("data-nexapdk", `nk-sel-${def.key}`);
            el.textContent = def.label;
            el.addEventListener("click", () => def.onClick(pickedIds()));
            selectionButtons.set(def, el);
          }
          if (anchor.nextElementSibling !== el) anchor.insertAdjacentElement("afterend", el);
        } else if (el) {
          el.remove();
          selectionButtons.delete(def);
        }
      }
    };

    // Message decorations: custom DOM placed just before or after a message's
    // text, kept there across the app's re-renders. The content element is
    // found through the row's aria-labelledby, whose last id is the body's.
    const decorations = new Map();   // id -> Map(key -> { node, position })
    const contentOf = (row) => {
      const labelled = row.getAttribute("aria-labelledby");
      if (labelled) {
        const parts = labelled.trim().split(/\s+/);
        const bodyId = parts[parts.length - 1];
        const el = bodyId && document.getElementById(bodyId);
        if (el && row.contains(el)) return el;
      }
      return row.lastElementChild || row;
    };
    const applyDecorations = () => {
      if (!decorations.size) return;
      for (const [id, byKey] of decorations) {
        const row = document.querySelector(`[data-row][data-id="${CSS.escape(id)}"]`);
        if (!row) continue;
        const content = contentOf(row);
        for (const [, entry] of byKey) {
          // Check the node is actually next to the message text, not merely
          // somewhere in the row: a re-render can leave it stranded at the top,
          // and "in the row" would then never correct it.
          const placed = entry.position === "before"
            ? content.previousElementSibling === entry.node
            : content.nextElementSibling === entry.node;
          if (placed) continue;
          if (entry.node.parentNode) entry.node.remove();
          if (entry.position === "before") content.insertAdjacentElement("beforebegin", entry.node);
          else content.insertAdjacentElement("afterend", entry.node);
        }
      }
    };

    const sweep = rafThrottle(() => { applyToolbars(); applySelectionBar(); applyDecorations(); });
    if (typeof MutationObserver !== "undefined") {
      const obs = new MutationObserver(sweep);
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-picked"] });
      onDispose(() => obs.disconnect());
      sweep();
    }
    const cleanInjected = () => {
      for (const el of document.querySelectorAll("[data-nexapdk]")) el.remove();
    };
    onDispose(cleanInjected);

    // ---- the public toolkit -------------------------------------------------
    const kit = {
      version: "1.2.1",
      stores,
      me: () => api.me,

      // messages
      getMessage,
      insert,                         // add/replace messages in the store
      update: updateRaw,              // write without firing onUpdate
      remove: removeRaw,              // remove without firing onDelete
      removeRaw,
      onDelete: (fn) => deleteSubs.add(fn),   // ({ channelId, ids, messages })
      onUpdate: (fn) => updateSubs.add(fn),   // ({ channelId, id, before, after }) — any store replace
      onEdit: (fn) => editSubs.add(fn),       // ({ channelId, id, before, after, message }) — a real text change

      // Put custom DOM by a message, kept there across re-renders. `node` is an
      // element (null to remove); opts.position is "before" or "after" (default)
      // the message text. Returns a remover.
      decorateMessage: (id, key, node, opts) => {
        let byKey = decorations.get(id);
        if (!byKey) { byKey = new Map(); decorations.set(id, byKey); }
        const prev = byKey.get(key);
        if (prev && prev.node !== node && prev.node.parentNode) prev.node.remove();
        if (node) {
          node.setAttribute("data-nexapdk", `deco-${key}`);
          byKey.set(key, { node, position: (opts && opts.position) || "after" });
        } else {
          byKey.delete(key);
          if (!byKey.size) decorations.delete(id);
        }
        sweep();
        return () => kit.clearMessageDecoration(id, key);
      },
      clearMessageDecoration: (id, key) => {
        const byKey = decorations.get(id);
        if (!byKey) return;
        const entry = byKey.get(key);
        if (entry && entry.node.parentNode) entry.node.remove();
        byKey.delete(key);
        if (!byKey.size) decorations.delete(id);
      },

      // context menu: modifier(ctx) may mutate ctx.items or return a new array
      contextMenu: (modifier) => menuSubs.add(modifier),
      addMessageMenuItem: (builder) =>
        menuSubs.add((ctx) => {
          if (!ctx.messageId) return;
          const item = builder(ctx);
          if (item) { if (ctx.items.length) ctx.items[ctx.items.length - 1] = { ...ctx.items[ctx.items.length - 1], separatorAfter: true }; ctx.items.push(item); }
        }),
      replaceMessageMenuItem: (id, builder) =>
        menuSubs.add((ctx) => {
          if (!ctx.messageId) return;
          const i = ctx.items.findIndex((it) => it && it.id === id);
          const next = builder(i >= 0 ? ctx.items[i] : null, ctx);
          if (!next) return;
          if (i >= 0) ctx.items[i] = next;
          else { if (ctx.items.length) ctx.items[ctx.items.length - 1] = { ...ctx.items[ctx.items.length - 1], separatorAfter: true }; ctx.items.push(next); }
        }),

      // toolbar: render(ctx) with ctx.addButton / ctx.hide (see applyToolbars)
      onToolbar: (render) => { const off = toolbarSubs.add(render); sweep(); return () => { off(); cleanInjected(); sweep(); }; },
      toolbarButton: (opts) => kit.onToolbar((ctx) => { if (!opts.when || opts.when(ctx)) ctx.addButton(opts); }),
      hideToolbarButton: (match) => kit.onToolbar((ctx) => ctx.hide(match)),

      // selection bar
      selectionButton: (def) => {
        const entry = { key: def.key || def.label || String(selectionDefs.size), label: def.label, when: def.when, onClick: def.onClick };
        selectionDefs.add(entry);
        sweep();
        return () => { selectionDefs.delete(entry); const el = selectionButtons.get(entry); if (el) el.remove(); selectionButtons.delete(entry); };
      },

      // low level
      patchStore: (name, method, wrap) => {
        const store = stores[name];
        if (!store || typeof store.getState !== "function") return () => {};
        const orig = store.getState()[method];
        store.setState({ [method]: wrap(orig) });
        return () => store.setState({ [method]: orig });
      },
    };

    Object.freeze(kit);
    globalThis.NexaPDK = kit;
    try { window.dispatchEvent(new CustomEvent("nexapdk:ready")); } catch { /* ignore */ }
    onDispose(() => { if (globalThis.NexaPDK === kit) delete globalThis.NexaPDK; });

    this._dispose = () => { while (disposers.length) { try { disposers.pop()(); } catch (e) { console.warn("NexaPDK dispose", e); } } };
  },

  stop() {
    if (this._dispose) { this._dispose(); this._dispose = null; }
  },
};
