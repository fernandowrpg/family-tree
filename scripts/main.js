const ID = "family-tree";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/* ---------- Dados ---------- */
function getData(actor) {
  const d = actor?.getFlag(ID, "data") ?? {};
  return { parents: d.parents ?? [], spouses: d.spouses ?? [], notes: d.notes ?? "" };
}
const childrenOf = id => game.actors.filter(a => getData(a).parents.includes(id));

async function setData(actor, data) {
  return actor.setFlag(ID, "data", { ...getData(actor), ...data });
}

/* ---------- Edição ---------- */
async function editFamily(actor) {
  const d = getData(actor);
  const kids = childrenOf(actor.id).map(a => a.id);
  const others = game.actors.filter(a => a.id !== actor.id).sort((a, b) => a.name.localeCompare(b.name));
  const chip = a => `<span class="ft-chip" data-id="${a.id}"><img src="${esc(a.img)}">${esc(a.name)}<a class="ft-x">&times;</a></span>`;
  const field = (name, label, chosen) => `<fieldset class="ft-field" data-name="${name}"><legend>${label}</legend>
    <div class="ft-chips">${chosen.map(i => game.actors.get(i)).filter(Boolean).map(chip).join("")}</div>
    <select class="ft-add"><option value="">+ Adicionar...</option>${others
      .map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></fieldset>`;
  const content = `<div class="ft-form">
    ${field("parents", "Pais", d.parents)}
    ${field("spouses", "Cônjuges", d.spouses)}
    ${field("children", "Filhos", kids)}
    <label>Notas</label><textarea name="notes" rows="3">${esc(d.notes)}</textarea></div>`;

  const res = await foundry.applications.api.DialogV2.prompt({
    window: { title: `Família: ${actor.name}` },
    position: { width: 420 },
    content,
    render: (ev, dialog) => {
      const root = dialog?.element ?? ev?.target?.element;
      root?.querySelectorAll(".ft-field").forEach(fs => {
        const chips = fs.querySelector(".ft-chips");
        fs.querySelector(".ft-add").addEventListener("change", e => {
          const a = game.actors.get(e.target.value);
          if (a && !chips.querySelector(`[data-id="${a.id}"]`)) chips.insertAdjacentHTML("beforeend", chip(a));
          e.target.value = "";
        });
        chips.addEventListener("click", e => e.target.closest(".ft-x")?.parentElement.remove());
      });
    },
    ok: {
      label: "Salvar",
      callback: (ev, btn) => {
        const f = btn.form;
        const vals = n => [...f.querySelectorAll(`.ft-field[data-name="${n}"] .ft-chip`)].map(c => c.dataset.id);
        return { parents: vals("parents"), spouses: vals("spouses"), children: vals("children"), notes: f.elements.notes.value };
      }
    },
    rejectClose: false
  });
  if (!res) return;

  const { children, ...own } = res;
  await setData(actor, own);

  // Cônjuges são recíprocos
  for (const a of game.actors) {
    if (a.id === actor.id) continue;
    const ad = getData(a);
    const isSp = res.spouses.includes(a.id), hadSp = ad.spouses.includes(actor.id);
    const isKid = children.includes(a.id), hadKid = ad.parents.includes(actor.id);
    const upd = {};
    if (isSp !== hadSp) upd.spouses = isSp ? [...ad.spouses, actor.id] : ad.spouses.filter(i => i !== actor.id);
    if (isKid !== hadKid) upd.parents = isKid ? [...ad.parents, actor.id] : ad.parents.filter(i => i !== actor.id);
    if (Object.keys(upd).length) await setData(a, upd);
  }
}

/* ---------- Layout ---------- */
function buildGraph(rootId) {
  const rel = new Map();
  for (const a of game.actors) {
    const d = getData(a);
    rel.set(a.id, { actor: a, ...d, children: [] });
  }
  for (const [id, n] of rel) {
    n.parents = n.parents.filter(p => rel.has(p));
    n.spouses = n.spouses.filter(s => rel.has(s));
    n.parents.forEach(p => rel.get(p).children.push(id));
  }
  let ids = [...rel.keys()].filter(id => {
    const n = rel.get(id);
    return n.parents.length || n.spouses.length || n.children.length;
  });
  if (rootId && rel.has(rootId)) {
    const seen = new Set([rootId]), q = [rootId];
    while (q.length) {
      const n = rel.get(q.shift());
      for (const x of [...n.parents, ...n.spouses, ...n.children]) if (!seen.has(x)) { seen.add(x); q.push(x); }
    }
    ids = [...seen];
  }
  const set = new Set(ids);

  // Gerações
  const gen = new Map(ids.map(i => [i, 0]));
  for (let k = 0; k < ids.length + 2; k++) {
    let changed = false;
    for (const i of ids) {
      const n = rel.get(i);
      let g = gen.get(i);
      for (const p of n.parents) if (set.has(p)) g = Math.max(g, gen.get(p) + 1);
      for (const s of n.spouses) if (set.has(s)) g = Math.max(g, gen.get(s));
      if (g !== gen.get(i) && g < ids.length) { gen.set(i, g); changed = true; }
    }
    if (!changed) break;
  }

  // Ordem nas linhas
  const rows = [], pos = new Map();
  const maxG = Math.max(-1, ...gen.values());
  for (let g = 0; g <= maxG; g++) {
    const inRow = ids.filter(i => gen.get(i) === g);
    const key = i => {
      const ps = rel.get(i).parents.filter(p => pos.has(p));
      return ps.length ? ps.reduce((s, p) => s + pos.get(p), 0) / ps.length : Infinity;
    };
    inRow.sort((a, b) => key(a) - key(b) || rel.get(a).actor.name.localeCompare(rel.get(b).actor.name));
    const row = [];
    for (const i of inRow) {
      if (row.includes(i)) continue;
      row.push(i);
      for (const s of rel.get(i).spouses) if (inRow.includes(s) && !row.includes(s)) row.push(s);
    }
    row.forEach((i, x) => pos.set(i, x / Math.max(1, row.length - 1)));
    rows.push(row);
  }
  return { rel, rows, set };
}

/* ---------- Janela da árvore ---------- */
class FamilyTreeApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "family-tree-app",
    window: { title: "Árvore Genealógica", resizable: true, icon: "fa-solid fa-sitemap" },
    position: { width: 950, height: 650 }
  };
  rootId = "";

  async _renderHTML() {
    const { rel, rows } = buildGraph(this.rootId);
    this._graph = rel;
    const opts = game.actors.contents.sort((a, b) => a.name.localeCompare(b.name))
      .map(a => `<option value="${a.id}" ${a.id === this.rootId ? "selected" : ""}>${esc(a.name)}</option>`).join("");
    const el = document.createElement("div");
    el.style.cssText = "display:flex;flex-direction:column;height:100%";
    el.innerHTML = `<div class="ft-bar"><label>Focar em:</label><select class="ft-root"><option value="">Todos</option>${opts}</select>
      ${game.user.isGM ? `<span class="hint">Arraste um ator aqui para editá-lo. Clique direito num nó para editar.</span>` : ""}</div>
      <div class="ft-canvas"><svg></svg>${rows.length ? rows.map(r => `<div class="ft-row">${r.map(i => {
        const a = rel.get(i).actor;
        return `<div class="ft-node" data-id="${i}"><img src="${esc(a.img)}"><span>${esc(a.name)}</span></div>`;
      }).join("")}</div>`).join("") : `<p>Nenhuma relação definida ainda. Use o menu de contexto de um ator ("Editar família").</p>`}
      <div class="ft-tip"></div></div>`;
    return el;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    const canvas = result.querySelector(".ft-canvas"), tip = result.querySelector(".ft-tip");
    result.querySelector(".ft-root").addEventListener("change", ev => { this.rootId = ev.target.value; this.render(); });

    canvas.addEventListener("dragover", ev => ev.preventDefault());
    canvas.addEventListener("drop", async ev => {
      if (!game.user.isGM) return;
      try {
        const data = JSON.parse(ev.dataTransfer.getData("text/plain"));
        if (data.type !== "Actor") return;
        const a = await fromUuid(data.uuid);
        if (a) { await editFamily(a); this.rootId ||= a.id; this.render(); }
      } catch {}
    });

    for (const node of canvas.querySelectorAll(".ft-node")) {
      const n = this._graph.get(node.dataset.id);
      node.addEventListener("click", () => n.actor.sheet.render(true));
      node.addEventListener("contextmenu", async ev => {
        ev.preventDefault();
        if (game.user.isGM) { await editFamily(n.actor); this.render(); }
      });
      node.addEventListener("mouseenter", () => {
        tip.innerHTML = this._tooltip(n);
        tip.style.display = "block";
        tip.style.left = `${node.offsetLeft + node.offsetWidth + 8}px`;
        tip.style.top = `${node.offsetTop}px`;
      });
      node.addEventListener("mouseleave", () => tip.style.display = "none");
    }
    requestAnimationFrame(() => this._drawLines(canvas));
  }

  _tooltip(n) {
    const names = ids => ids.map(i => esc(this._graph.get(i)?.actor.name)).join(", ") || "—";
    const a = n.actor;
    return `<img src="${esc(a.img)}"><b>${esc(a.name)}</b><br><i>${esc(a.type)}</i>
      <div style="clear:both"></div>
      <div><strong>Pais:</strong> ${names(n.parents)}</div>
      <div><strong>Cônjuges:</strong> ${names(n.spouses)}</div>
      <div><strong>Filhos:</strong> ${names(n.children)}</div>
      ${n.notes ? `<div><strong>Notas:</strong> ${esc(n.notes)}</div>` : ""}`;
  }

  _drawLines(canvas) {
    const svg = canvas.querySelector("svg");
    svg.setAttribute("width", canvas.scrollWidth);
    svg.setAttribute("height", canvas.scrollHeight);
    const box = {};
    for (const el of canvas.querySelectorAll(".ft-node")) {
      box[el.dataset.id] = { x: el.offsetLeft + el.offsetWidth / 2, t: el.offsetTop, b: el.offsetTop + el.offsetHeight,
        l: el.offsetLeft, r: el.offsetLeft + el.offsetWidth, m: el.offsetTop + el.offsetHeight / 2 };
    }
    let paths = "";
    const done = new Set();
    for (const [id, c] of Object.entries(box)) {
      const n = this._graph.get(id);
      const ps = n.parents.filter(p => box[p]);
      if (ps.length) {
        const sx = ps.reduce((s, p) => s + box[p].x, 0) / ps.length;
        const sy = Math.max(...ps.map(p => box[p].b));
        const my = c.t - 30;
        paths += `<path d="M${sx} ${sy} V${my} H${c.x} V${c.t}"/>`;
      }
      for (const s of n.spouses) {
        const k = [id, s].sort().join();
        if (!box[s] || done.has(k)) continue;
        done.add(k);
        const [L, R] = c.x < box[s].x ? [c, box[s]] : [box[s], c];
        paths += `<path class="spouse" d="M${L.r} ${L.m} L${R.l} ${R.m}"/>`;
      }
    }
    svg.innerHTML = paths;
  }
}

let app;
const openTree = rootId => {
  app ??= new FamilyTreeApp();
  if (rootId !== undefined) app.rootId = rootId;
  app.render({ force: true });
};

/* ---------- Hooks ---------- */
Hooks.once("ready", () => {
  game.modules.get(ID).api = { openTree, editFamily, getData };
});

Hooks.on("updateActor", (a, ch) => { if (app?.rendered && ch.flags?.[ID] !== undefined) app.render(); });

Hooks.on("renderActorDirectory", (dir, html) => {
  html = html instanceof HTMLElement ? html : html[0];
  if (html.querySelector(".ft-open")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ft-open";
  btn.innerHTML = `<i class="fa-solid fa-sitemap"></i> Árvore Genealógica`;
  btn.addEventListener("click", () => openTree());
  (html.querySelector(".header-actions") ?? html.querySelector(".directory-header") ?? html).append(btn);
});

const entryId = li => {
  const el = li instanceof HTMLElement ? li : li?.[0];
  return el?.dataset.entryId ?? el?.dataset.documentId;
};
function addContext(_app, options) {
  if (options.some(o => o.name === "Editar família")) return;
  options.push(
    { name: "Editar família", label: "Editar família", icon: '<i class="fa-solid fa-people-roof"></i>',
      condition: () => game.user.isGM,
      callback: li => { const a = game.actors.get(entryId(li)); if (a) editFamily(a); } },
    { name: "Ver árvore genealógica", label: "Ver árvore genealógica", icon: '<i class="fa-solid fa-sitemap"></i>',
      callback: li => openTree(entryId(li)) }
  );
}
Hooks.on("getActorContextOptions", addContext);
Hooks.on("getActorDirectoryEntryContext", addContext);
