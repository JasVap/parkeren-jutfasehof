// Parkeren Jutfasehof: buren delen hun parkeerplek als ze weg zijn.
// Gegevens in Firebase Firestore, inloggen met e-mail en wachtwoord plus een buurtcode.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, setPersistence, browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, onSnapshot, query, where, addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, runTransaction, FieldPath, deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import * as cfg from "./config.js";
const firebaseConfig = cfg.firebaseConfig;

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const fs = getFirestore(fbApp);
setPersistence(auth, browserLocalPersistence).catch(() => {});

const STREET = "Peizerdiep";
const APP = "Parkeren Jutfasehof";
const APP_URL = location.origin + location.pathname.replace(/index\.html$/, "");
const HOUSES = ["15","17","19","21","23","25","27","32","34","36","38"];
const SPOTS = ["P08","P09","P10","P11","P12","P13","P14","P15","P16","P17","P18","P19"];
const DAYS = [[1,"ma"],[2,"di"],[3,"wo"],[4,"do"],[5,"vr"],[6,"za"],[0,"zo"]];
const MIN = 60e3, H = 60 * MIN, D = 24 * H, Q = 15 * MIN;
const APP_VERSION = "3";

const st = {
  user: null, member: null, house: null, live: false, unsubs: [],
  spots: {}, phones: {}, releases: [], recurring: [], claims: [], requests: [],
  moment: null, tab: "overzicht", onlyCharger: false, momentOpen: false,
  sheet: null, authMode: "login", relTabKey: null,
};

/* ---------- hulpjes ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const now = () => Date.now();
const pad = (n) => String(n).padStart(2, "0");
const T = () => st.moment ?? now();
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
function sod(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function at(base, dayOff, h, m = 0) { const d = new Date(sod(base)); d.setDate(d.getDate() + dayOff); d.setHours(h, m, 0, 0); return d.getTime(); }
const ceilQ = (ms) => Math.ceil(ms / Q) * Q;
const floorQ = (ms) => Math.floor(ms / Q) * Q;
const fDay = new Intl.DateTimeFormat("nl-NL", { weekday: "short", day: "numeric", month: "short" });
const fLong = new Intl.DateTimeFormat("nl-NL", { weekday: "long", day: "numeric", month: "long" });
const fShortDate = new Intl.DateTimeFormat("nl-NL", { day: "numeric", month: "short" });
const DOW = ["zo","ma","di","wo","do","vr","za"];
const hm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const clean = (s) => s.replace(/\./g, "");
const dayDiff = (ms) => Math.round((sod(ms) - sod(now())) / D);
function dayWord(ms) {
  const diff = dayDiff(ms);
  return diff === 0 ? "vandaag" : diff === 1 ? "morgen" : diff === -1 ? "gisteren" : clean(fDay.format(ms));
}
const when = (ms) => `${dayWord(ms)} ${hm(ms)}`;
function range(a, b) {
  const left = a <= now() && b > now() ? "nu" : when(a);
  return sod(a) === sod(b) ? `${left} tot ${hm(b)}` : `${left} tot ${when(b)}`;
}
// Kort voor op de kaart: "16:00", "zo 16:00" of "1 nov".
function shortWhen(ms) {
  const diff = dayDiff(ms);
  if (diff === 0) return hm(ms);
  if (diff > 0 && diff < 7) return `${DOW[new Date(ms).getDay()]} ${hm(ms)}`;
  return clean(fShortDate.format(ms));
}
// "2 dagen en 11 uur", "45 minuten", "1 dag"
function fmtDur(ms) {
  if (!(ms > 0)) return "";
  const totalMin = Math.round(ms / MIN);
  const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
  const parts = [];
  if (d) parts.push(`${d} ${d === 1 ? "dag" : "dagen"}`);
  if (h) parts.push(`${h} uur`);
  if (m && !d) parts.push(`${m} ${m === 1 ? "minuut" : "minuten"}`);
  return parts.length > 1 ? parts.slice(0, -1).join(", ") + " en " + parts.at(-1) : parts[0] || "";
}
const ownerOf = (p) => st.spots[p]?.house || null;
const spotsOf = (h) => SPOTS.filter(p => ownerOf(p) === h);
const hasCharger = (p) => !!st.spots[p]?.charger;
// Plekken heten naar het huisnummer. Heeft een woning er twee, dan "27a" en "27b".
function spotName(p) { const h = ownerOf(p); if (!h) return null; const list = spotsOf(h); return list.length > 1 ? h + "abcdefgh"[list.indexOf(p)] : h; }
const spotNr = (p) => spotName(p) ? `nr ${spotName(p)}` : "plek zonder adres";
const plekVan = (p) => spotName(p) ? `de plek van nr ${spotName(p)}` : "een plek zonder adres";
const mineLabel = (p) => spotsOf(st.house).length > 1 ? `Plek ${spotName(p)}` : "Mijn plek";
const boltPill = `<span class="pill charge"><svg width="9" height="14" viewBox="0 0 12 20" aria-hidden="true" style="vertical-align:-2px"><path class="bolt" d="M8 0L0 11h5l-2 9 9-12H7z"/></svg> laadpaal</span>`;
const clockIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3500); }
function showErr(el, m) { if (!el) return; el.textContent = m || ""; el.hidden = !m; }

/* WhatsApp */
function normPhone(v) {
  let d = String(v || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "31" + d.slice(1);
  return /^\d{10,15}$/.test(d) ? d : null;
}
const waShare = (text) => `https://wa.me/?text=${encodeURIComponent(text)}`;
const waIcon = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.8-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.1.6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .2-1.2c-.1-.1-.3-.2-.5-.3z"/></svg>`;
function waBtn(href, label) { return href ? `<a class="btn wa" href="${esc(href)}" target="_blank" rel="noopener">${waIcon}${esc(label)}</a>` : ""; }
// Per woning kunnen meerdere bewoners een naam en nummer opgeven (houses/{nr}.contacts.{uid}).
// Een los "phone"-veld uit de eerste versie telt mee tot het is verwijderd.
function contactsOf(h) {
  const rec = st.phones[h] || {}, out = [];
  for (const [uid, c] of Object.entries(rec.contacts || {})) { const ph = normPhone(c?.phone); if (ph) out.push({ uid, name: c.name || "", phone: ph }); }
  const legacy = normPhone(rec.phone);
  if (legacy && !out.some(c => c.phone === legacy)) out.push({ uid: null, name: "", phone: legacy });
  return out;
}
function waBtns(h, text) {
  return contactsOf(h).map(c => waBtn(`https://wa.me/${c.phone}?text=${encodeURIComponent(text)}`, c.name ? `App ${c.name}` : `App nr ${h}`)).join("");
}

/* ---------- draaischijven ---------- */
// Drie schijven: dag (met weekdag), uur, minuten per kwartier.
const ROW = 42;
function dayLabel(dayMs) {
  const diff = dayDiff(dayMs), wd = DOW[new Date(dayMs).getDay()];
  if (diff === 0) return "vandaag";
  if (diff === 1) return `morgen · ${wd}`;
  return clean(fDay.format(dayMs));
}
class Wheels {
  // opts: get() -> ms, set(ms), min() -> ms|null, max() -> ms|null
  constructor(host, opts) { this.host = host; this.o = opts; this.build(); }
  bounds() {
    const min = this.o.min ? this.o.min() : null, max = this.o.max ? this.o.max() : null;
    return { min: min == null ? null : min, max: max == null ? null : max };
  }
  build() {
    const { min, max } = this.bounds();
    const v = this.o.get();
    const first = sod(Math.min(min ?? v, v)), last = max != null ? sod(Math.max(max, v)) : at(first, 120, 0);
    this.days = [];
    for (let d = first, i = 0; d <= last && i < 400; d = at(d, 1, 0), i++) this.days.push(d);
    this.hours = Array.from({ length: 24 }, (_, i) => i);
    this.mins = [0, 15, 30, 45];
    const col = (key, items, fmt) => `<div class="wheel" data-w="${key}" tabindex="0" role="listbox" aria-label="${key === "d" ? "Dag" : key === "h" ? "Uur" : "Minuten"}">${items.map((x, i) => `<div data-i="${i}" role="option">${fmt(x)}</div>`).join("")}</div>`;
    this.host.innerHTML = `<div class="wheels"><div class="band" aria-hidden="true"></div>${col("d", this.days, dayLabel)}${col("h", this.hours, pad)}${col("m", this.mins, pad)}</div>`;
    this.cols = [...this.host.querySelectorAll(".wheel")];
    this.cols.forEach(c => {
      c.addEventListener("scroll", () => { if (this.lock) return; clearTimeout(c._t); c._t = setTimeout(() => this.commit(), 110); }, { passive: true });
      c.addEventListener("click", (e) => { const it = e.target.closest("[data-i]"); if (it) c.scrollTo({ top: Number(it.dataset.i) * ROW, behavior: "smooth" }); });
      c.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        c.scrollTo({ top: (Math.round(c.scrollTop / ROW) + (e.key === "ArrowDown" ? 1 : -1)) * ROW, behavior: "smooth" });
      });
    });
    requestAnimationFrame(() => this.sync(v));
  }
  idx(v) {
    const d = new Date(v);
    const di = Math.max(0, this.days.findIndex(x => x === sod(v)));
    return [di, d.getHours(), Math.min(3, Math.floor(d.getMinutes() / 15))];
  }
  sync(v) {
    const ids = this.idx(v);
    this.lock = true;
    this.cols.forEach((c, k) => { c.scrollTop = ids[k] * ROW; });
    this.mark(v);
    clearTimeout(this._u); this._u = setTimeout(() => { this.lock = false; }, 80);
  }
  mark(v) {
    const ids = this.idx(v), { min, max } = this.bounds(), day = sod(v);
    this.cols.forEach((c, k) => [...c.children].forEach((el, i) => {
      el.classList.toggle("on", i === ids[k]);
      el.setAttribute("aria-selected", i === ids[k]);
      let off = false;
      if (k === 1) {
        const hStart = at(day, 0, i), hEnd = hStart + H;
        if (min != null && hEnd <= min) off = true;
        if (max != null && hStart > max) off = true;
      }
      el.classList.toggle("off", off);
    }));
  }
  commit() {
    const [ci, hi, mi] = this.cols.map(c => Math.round(c.scrollTop / ROW));
    const di = Math.max(0, Math.min(this.days.length - 1, ci));
    const h = this.hours[Math.max(0, Math.min(23, hi))], m = this.mins[Math.max(0, Math.min(3, mi))];
    let v = at(this.days[di], 0, h, m);
    const { min, max } = this.bounds();
    if (min != null && v < min) v = ceilQ(min) > (max ?? Infinity) ? min : ceilQ(min);
    if (max != null && v > max) v = max;
    this.o.set(v);
    const shown = this.idx(v), cur = [di, hi, mi];
    if (shown.some((x, k) => x !== cur[k])) this.sync(v); else this.mark(v);
  }
}

// Eén tijdveld: knop met dag en tijd, tik opent de draaischijven eronder.
function timeField(host, { label, get, set, min, max }) {
  const idp = "tf" + rid();
  host.innerHTML = `<div class="field"><span class="lbl" id="${idp}l">${esc(label)}</span>
    <button type="button" class="tfbtn" aria-expanded="false" aria-labelledby="${idp}l ${idp}v"><span id="${idp}v"></span></button></div>
    <div class="tfw" hidden></div>`;
  const btn = host.querySelector(".tfbtn"), box = host.querySelector(".tfw");
  const paint = () => { const v = get(); btn.querySelector("span").innerHTML = `<span class="d">${esc(dayWord(v))}</span><span class="t">${hm(v)}</span>`; };
  let wheels = null;
  btn.addEventListener("click", () => {
    const open = box.hidden;
    box.hidden = !open; btn.setAttribute("aria-expanded", open);
    if (open) wheels = new Wheels(box, { get, set: (v) => { set(v); paint(); }, min, max });
  });
  paint();
  return { paint, refresh: () => { paint(); if (wheels && !box.hidden) wheels.sync(get()); } };
}

// Van en tot naast elkaar, één set schijven eronder. De eindtijd schuift mee met dezelfde duur.
function rangeField(host, o) {
  const s = { f: o.from, u: o.until, fromNow: !!o.fromNow, active: null };
  const idp = "rf" + rid();
  host.innerHTML = `<div class="range">
      <div class="field"><span class="lbl" id="${idp}a">Vanaf</span><button type="button" class="tfbtn" data-k="f" aria-expanded="false" aria-labelledby="${idp}a ${idp}av"><span id="${idp}av"></span></button></div>
      <div class="field"><span class="lbl" id="${idp}b">Tot</span><button type="button" class="tfbtn" data-k="u" aria-expanded="false" aria-labelledby="${idp}b ${idp}bv"><span id="${idp}bv"></span></button></div>
    </div>
    <div class="tfw" hidden><div class="chips nowrow" hidden><button type="button" class="chip" data-now>Vanaf nu</button></div><div class="wh"></div></div>
    <div class="dur" aria-live="polite"></div>
    ${o.quick ? `<div class="scroller quick" role="group" aria-label="Snel kiezen voor tot"></div>` : ""}`;
  const box = host.querySelector(".tfw"), wh = host.querySelector(".wh"), nowRow = host.querySelector(".nowrow");
  const btnF = host.querySelector('[data-k="f"]'), btnU = host.querySelector('[data-k="u"]');
  const minF = () => o.minFrom ? o.minFrom() : (o.fromNow ? floorQ(now()) : null);
  const maxU = () => o.maxUntil ? o.maxUntil() : null;
  let wheels = null;
  const f = () => s.fromNow ? now() : s.f;
  const paint = () => {
    btnF.querySelector("span").innerHTML = s.fromNow ? `<span class="d">Nu</span><span class="t">${esc(when(now()))}</span>` : `<span class="d">${esc(dayWord(s.f))}</span><span class="t">${hm(s.f)}</span>`;
    btnU.querySelector("span").innerHTML = `<span class="d">${esc(dayWord(s.u))}</span><span class="t">${hm(s.u)}</span>`;
    btnF.setAttribute("aria-expanded", s.active === "f"); btnU.setAttribute("aria-expanded", s.active === "u");
    const dur = fmtDur(s.u - f());
    host.querySelector(".dur").innerHTML = dur ? `${clockIcon}<span>${esc(o.durLabel || "Duur")}: <strong>${esc(dur)}</strong></span>` : "";
    const q = host.querySelector(".quick");
    if (q) q.innerHTML = quickUntil(f()).filter(([, v]) => v > f() && (maxU() == null || v <= maxU())).map(([l, v, sfx]) =>
      `<button type="button" class="chip" data-q="${v}" aria-pressed="${Math.abs(s.u - v) < MIN}">${esc(l)}${sfx ? `<span class="tag">· ${esc(sfx)}</span>` : ""}</button>`).join("");
    o.onChange && o.onChange();
  };
  const setF = (v) => {
    const dur = s.u - f();
    s.fromNow = false; s.f = v;
    let u = v + (dur > 0 ? dur : 3 * H);
    if (maxU() != null && u > maxU()) u = maxU();
    if (u <= v) u = v + Q;
    s.u = u; paint();
  };
  const setU = (v) => { s.u = Math.max(v, f() + Q); if (maxU() != null && s.u > maxU()) s.u = maxU(); paint(); };
  const open = (k) => {
    if (s.active === k) { s.active = null; box.hidden = true; paint(); return; }
    s.active = k; box.hidden = false; nowRow.hidden = !(k === "f" && o.fromNow);
    wheels = new Wheels(wh, k === "f"
      ? { get: f, set: setF, min: minF, max: () => (maxU() != null ? maxU() - Q : null) }
      : { get: () => s.u, set: setU, min: () => f() + Q, max: maxU });
    paint();
  };
  btnF.addEventListener("click", () => open("f"));
  btnU.addEventListener("click", () => open("u"));
  host.addEventListener("click", (e) => {
    const q = e.target.closest("[data-q]");
    if (q) { setU(Number(q.dataset.q)); if (wheels && s.active === "u") wheels.sync(s.u); }
    if (e.target.closest("[data-now]")) { const dur = s.u - f(); s.fromNow = true; s.u = Math.max(now() + Q, now() + dur); paint(); if (wheels) wheels.sync(f()); }
  });
  paint();
  return {
    get: () => ({ from: f(), until: s.u, fromNow: s.fromNow }),
    set: (from, until) => { s.fromNow = false; s.f = from; s.u = until; paint(); },
    paint,
  };
}
// Snelknoppen voor "tot", rekenend vanaf de start, met de dag waarop je uitkomt.
function quickUntil(f) {
  const dow = new Date(f).getDay();
  let tonight = at(f, 0, 23); if (tonight <= f) tonight = at(f, 1, 23);
  let sun = at(f, (7 - dow) % 7, 20); if (sun <= f) sun = at(f, 7, 20);
  const dayOf = (v) => `${DOW[new Date(v).getDay()]} ${clean(fShortDate.format(v))}`;
  return [
    ["3 uur", f + 3 * H, hm(f + 3 * H)],
    [sod(tonight) === sod(f) ? "Vanavond 23:00" : "Morgenavond 23:00", tonight, ""],
    ["Morgen 08:00", at(f, 1, 8), DOW[new Date(at(f, 1, 8)).getDay()]],
    ["Zondag 20:00", sun, clean(fShortDate.format(sun))],
    ["2 dagen", f + 2 * D, dayOf(f + 2 * D)],
    ["1 week", f + 7 * D, dayOf(f + 7 * D)],
  ];
}

/* ---------- beschikbaarheid ---------- */
function windows() {
  const out = [];
  for (const r of st.releases) if (r.until > r.from) out.push({ key: `${r.spot}_${r.from}`, spot: r.spot, start: r.from, end: r.until, house: r.house, note: r.note || "", src: "once", ref: r.id });
  const today = sod(now());
  for (const r of st.recurring) {
    const [fh, fm] = (r.fromTime || "08:00").split(":").map(Number);
    const [uh, um] = (r.untilTime || "18:00").split(":").map(Number);
    for (let i = -1; i <= 21; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      if (!(r.days || []).includes(d.getDay())) continue;
      const start = at(d.getTime(), 0, fh, fm);
      let end = at(d.getTime(), 0, uh, um); if (end <= start) end = at(d.getTime(), 1, uh, um);
      if (r.since && start < r.since) continue;
      const ov = r.overrides && r.overrides[String(start)];
      if (typeof ov === "number") end = ov;
      if (end > start) out.push({ key: `${r.spot}_${start}`, spot: r.spot, start, end, house: r.house, note: r.note || "", src: "rec", ref: r.id });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.spot.localeCompare(b.spot));
}
const liveClaims = () => st.claims.filter(c => c.house && c.until > c.from);
function claimsIn(w) { return liveClaims().filter(c => c.spot === w.spot && c.from < w.end && c.until > w.start).sort((a, b) => a.from - b.from); }
function statusAt(p, t, wins) {
  const w = wins.find(w => w.spot === p && w.start <= t && w.end > t);
  if (!w) return ownerOf(p) ? { cls: "own", text: "eigenaar" } : { cls: "unknown", text: "geen adres" };
  const cs = claimsIn(w);
  const c = cs.find(c => c.from <= t && c.until > t);
  if (c) return { cls: "claimed", text: `→ nr ${c.house}`, w, c };
  const next = cs.find(c => c.from > t);
  const freeUntil = next ? next.from : w.end;
  return { cls: "free", text: `tot ${shortWhen(freeUntil)}`, w, freeUntil };
}
// Is plek p vrij en ongeclaimd gedurende de hele periode [a, b)?
function freeDuring(p, a, b, wins) {
  const w = wins.find(w => w.spot === p && w.start <= a && w.end >= b);
  if (!w) return null;
  return claimsIn(w).some(c => c.from < b && c.until > a) ? null : w;
}

/* ---------- plattegrond ---------- */
const GEO = {};
["P19","P18","P17","P16","P15"].forEach((p, i) => GEO[p] = { x: 20, y: 160 + i * 80 });
["P08","P09","P10","P11","P12","P13","P14"].forEach((p, i) => GEO[p] = { x: 260, y: 20 + i * 80 });
function renderMap(wins, target = "#map", mode = "status") {
  const t = T();
  let svg = "";
  for (const p of SPOTS) {
    const g = GEO[p], o = ownerOf(p);
    const mine = st.house && o === st.house;
    let s = statusAt(p, t, wins);
    if (mode === "link") s = mine ? { cls: "linkmine", text: "jouw plek" } : o ? { cls: "own", text: "" } : { cls: "unknown", text: "tik = mijn plek" };
    const big = spotName(p) || "?";
    svg += `<g class="spot ${s.cls}${mine && mode !== "link" ? " mine" : ""}" data-action="${mode === "link" ? "linktap" : "spot"}" data-spot="${p}" tabindex="0" role="button" aria-label="${esc(spotNr(p))}: ${esc(s.cls === "free" ? "vrij " + s.text : s.text)}">
      <rect x="${g.x + 3}" y="${g.y + 3}" width="94" height="74" rx="5"/>
      <text class="pnum" x="${g.x + 50}" y="${g.y + 40}" text-anchor="middle">${esc(big)}</text>
      <text class="pstate" x="${g.x + 50}" y="${g.y + 62}" text-anchor="middle">${esc(s.text)}</text>
      ${hasCharger(p) ? `<circle class="boltbg" cx="${g.x + 82}" cy="${g.y + 18}" r="11"/><path class="bolt" transform="translate(${g.x + 76} ${g.y + 9}) scale(.9)" d="M8 0L0 11h5l-2 9 9-12H7z"/>` : ""}</g>`;
  }
  const box = $(target); if (!box) return;
  box.innerHTML = `<svg viewBox="-95 -45 570 690" role="img" aria-label="Plattegrond parkeerterrein">
    <g transform="rotate(22 190 300)">
      <rect x="125" y="-20" width="130" height="640" fill="var(--paving)"/>
      <rect x="0" y="150" width="18" height="420" fill="var(--verge)"/>
      <rect x="362" y="10" width="18" height="580" fill="var(--verge)"/>
      <line x1="190" y1="10" x2="190" y2="590" stroke="var(--muted)" stroke-opacity=".35" stroke-width="2" stroke-dasharray="14 12"/>
      <rect x="22" y="40" width="96" height="100" rx="3" fill="var(--surface)" stroke="var(--line)" stroke-width="1.5"/>
      <text x="70" y="96" text-anchor="middle" font-family="var(--display)" font-size="17" fill="var(--muted)">trafo</text>
      ${svg}
    </g></svg>`;
}

/* ---------- overzicht ---------- */
function momentOptions() {
  const n = now(), o = [["Nu", null]];
  const tonight = at(n, 0, 19); if (tonight > n) o.push(["Vanavond 19:00", tonight]);
  o.push(["Morgen 09:00", at(n, 1, 9)], ["Morgen 19:00", at(n, 1, 19)]);
  const dow = new Date(n).getDay();
  const sat = at(n, ((6 - dow + 7) % 7) || 7, 12); o.push([`${clean(fDay.format(sat))} 12:00`, sat]);
  return o;
}
let momentTF = null;
function renderMoment() {
  const sel = st.moment, opts = momentOptions();
  const custom = sel != null && !opts.some(([, v]) => v === sel);
  $("#momentChips").innerHTML = opts.map(([l, v]) => `<button type="button" class="chip" data-action="moment" data-v="${v ?? ""}" aria-pressed="${sel === v}">${esc(l)}</button>`).join("")
    + `<button type="button" class="chip" data-action="momentcustom" aria-expanded="${st.momentOpen}" aria-pressed="${custom}">${custom ? esc(when(sel)) : "Ander moment"}</button>`;
  $("#momentPicker").hidden = !st.momentOpen;
  if (st.momentOpen && !momentTF) {
    momentTF = timeField($("#momentPicker"), { label: "Kies een moment", get: () => st.moment ?? ceilQ(now()), set: (v) => { st.moment = v; render(); }, min: () => floorQ(now()) });
    $("#momentPicker .tfbtn").click();
  } else if (momentTF) momentTF.paint();
  if (!st.momentOpen && momentTF) { momentTF = null; $("#momentPicker").innerHTML = ""; }
  $("#momentEyebrow").textContent = sel == null ? `Nu · ${clean(fDay.format(now()))} ${hm(now())}` : fLong.format(sel);
  $("#momentTitle").textContent = sel == null ? "Op dit moment" : `${dayWord(sel)} om ${hm(sel)}`;
}
function renderOptions(wins) {
  const t = T();
  let free = []; const taken = [];
  for (const p of SPOTS) { const s = statusAt(p, t, wins); if (s.cls === "free") free.push([p, s]); else if (s.cls === "claimed") taken.push([p, s]); }
  $("#freeCount").textContent = free.length;
  $("#freeLabel").textContent = free.length === 1 ? "plek vrij" : "plekken vrij";
  const anyCharger = SPOTS.some(hasCharger);
  $("#chargeStat").hidden = !anyCharger;
  $("#chargeCount").textContent = free.filter(([p]) => hasCharger(p)).length;
  const oc = $("#onlyCharger"); oc.hidden = !anyCharger; oc.setAttribute("aria-pressed", st.onlyCharger && anyCharger);
  $("#optTitle").textContent = st.moment == null ? "Nu vrij" : `Vrij ${dayWord(t)} om ${hm(t)}`;
  $("#releaseBtn").hidden = !(st.house && spotsOf(st.house).length);
  if (st.onlyCharger && anyCharger) {
    const all = free.length; free = free.filter(([p]) => hasCharger(p));
    if (!free.length && all) { $("#options").innerHTML = `<div class="empty">Er ${all === 1 ? "is 1 plek" : `zijn ${all} plekken`} vrij, maar geen met laadpaal. <button class="btn sm ghost" data-action="onlycharger">Toon alle vrije plekken</button></div>`; return; }
  }
  let html = "";
  if (!free.length) {
    const next = wins.map(w => ({ w, s: statusAt(w.spot, Math.max(w.start, t), wins) })).find(x => x.w.start > t && x.s.cls === "free");
    html = `<div class="empty"><span>Op dit moment is er geen plek vrij.</span>
      ${next ? `<span>Eerstvolgende: <strong>${esc(plekVan(next.w.spot))}</strong> vanaf ${esc(when(next.w.start))}. <a href="#" data-action="moment" data-v="${next.w.start}">Bekijk</a></span>` : ""}
      <button class="btn sm ghost" data-action="goto" data-tab="verzoeken">Vraag om een plek</button></div>`;
  } else {
    html = free.map(([p, s]) => {
      const mine = st.house && s.w.house === st.house;
      const canClaim = !mine && st.house && s.freeUntil > now();
      return `<div class="card is-free optcard"><div class="optmain">
          <div class="big">vrij tot ${esc(when(s.freeUntil))}</div>
          <div class="sub">${mine ? "jouw plek" : `plek van ${esc(spotNr(p))}`}${hasCharger(p) ? ` ${boltPill}` : ""}${s.w.src === "rec" ? ` <span class="pill neutral">wekelijks</span>` : ""}</div>
          ${s.w.note ? `<div class="note">${esc(s.w.note)}</div>` : ""}</div>
        ${canClaim ? `<button class="btn green sm" data-action="claimsheet" data-key="${s.w.key}">Claim</button>` : ""}</div>`;
    }).join("");
  }
  if (taken.length) {
    html += `<details><summary>${taken.length} geclaimd door buren</summary><div class="list" style="margin-top:8px">${taken.map(([p, s]) =>
      `<div class="card is-claimed"><div class="head"><span class="pid">${esc(spotNr(p))}</span><span class="pill claimed">bezet door nr ${esc(s.c.house)}</span></div><div class="when">${esc(range(s.c.from, s.c.until))}</div></div>`).join("")}</div></details>`;
  }
  $("#options").innerHTML = html;
}
function renderNotices(wins) {
  const n = now(), out = [];
  if (st.house) {
    for (const c of st.claims) {
      if (c.house !== st.house) continue;
      if (c.earlyReturn && c.earlyReturn > n - 2 * H) {
        const gone = !(c.until > c.from);
        out.push(`<div class="notice warn"><strong>Nr ${esc(c.owner)} komt eerder terug</strong><span>${gone ? `Je claim op ${esc(plekVan(c.spot))} vervalt.` : `Zet je auto op ${esc(plekVan(c.spot))} weg voor ${esc(when(c.earlyReturn))}.`}</span>
          <div class="row" style="margin-top:6px"><button class="btn sm ghost" data-action="ack" data-id="${c.id}" data-spot="${c.spot}">Begrepen</button></div></div>`);
      } else if (c.until > c.from && c.from <= n && c.until > n) {
        const soon = c.until - n <= H;
        out.push(`<div class="notice ${soon ? "amber" : "green"}"><strong>${soon ? `Je claim op ${esc(plekVan(c.spot))} loopt bijna af` : `Je staat op ${esc(plekVan(c.spot))}`}</strong><span>Tot ${esc(when(c.until))}.</span>
          <div class="row" style="margin-top:6px"><button class="btn sm ghost" data-action="unclaim" data-id="${c.id}" data-spot="${c.spot}">Ik ben weg</button></div></div>`);
      }
    }
    for (const c of liveClaims()) {
      if (c.owner === st.house && c.from <= n && c.until > n) out.push(`<div class="notice"><strong>Nr ${esc(c.house)} staat op ${spotsOf(st.house).length > 1 ? `jouw plek ${esc(spotName(c.spot))}` : "jouw plek"}</strong><span>Tot ${esc(when(c.until))}. Eerder terug? Zie Mijn.</span></div>`);
    }
  }
  // Verzoeken waarbij jouw plek precies vrij is: direct aanbieden.
  const my = st.house ? spotsOf(st.house) : [];
  const open = st.requests.filter(r => !r.offeredSpot && r.until > n && r.house !== st.house);
  let generic = 0;
  for (const r of open) {
    const p = my.find(p => freeDuring(p, Math.max(r.from, n), r.until, wins));
    if (p) out.push(`<div class="notice reqcard"><div><strong>Nr ${esc(r.house)} zoekt ${esc(range(r.from, r.until))} een plek.</strong> ${my.length > 1 ? `Jouw plek ${esc(spotName(p))}` : "Jouw plek"} is dan vrij.${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}</div>
      <button class="btn green sm" data-action="offer" data-id="${r.id}" data-spot="${p}">Bied aan</button></div>`);
    else generic++;
  }
  if (generic) out.push(`<div class="notice"><strong>${generic} ${generic === 1 ? "buur zoekt" : "buren zoeken"} een plek</strong><span><a href="#verzoeken" data-action="goto" data-tab="verzoeken">Bekijk verzoeken</a></span></div>`);
  $("#notices").innerHTML = out.join("");
  const b = $("#reqBadge"); b.hidden = !open.length; b.textContent = open.length;
}
function renderBanner() {
  const b = [];
  if (!st.house) b.push(`<div class="notice green"><strong>Welkom</strong><span>Kies je huisnummer en je plek bij <a href="#mijn" data-action="goto" data-tab="mijn">Mijn</a>.</span></div>`);
  else if (!spotsOf(st.house).length) b.push(`<div class="notice green"><span>Koppel je parkeerplek bij <a href="#mijn" data-action="goto" data-tab="mijn">Mijn</a>, dan kun je hem vrijgeven.</span></div>`);
  $("#banner").innerHTML = b.join("");
  $("#whoami").textContent = st.house ? `nr ${st.house}` : "Kies je adres";
}

/* ---------- vrijgeven (formulier, in het tabblad en in een paneel) ---------- */
function mountReleaseForm(host, opts = {}) {
  const my = st.house ? spotsOf(st.house) : [];
  if (!my.length) {
    host.innerHTML = `<div class="notice green"><span>Koppel eerst je huisnummer en plek bij <a href="#mijn" data-action="goto" data-tab="mijn">Mijn</a>.</span></div>`;
    return;
  }
  const sel = new Set(opts.spot && my.includes(opts.spot) ? [opts.spot] : [my[0]]);
  const days = new Set([1, 2, 3, 4, 5]);
  let mode = "once";
  const idp = "rel" + rid();
  host.innerHTML = `<form class="flat" novalidate>
      ${my.length > 1 ? `<div class="field"><span class="lbl">Welke plek</span><div class="chips" data-r="spots"></div></div>` : ""}
      <div class="field"><span class="lbl">Hoe vaak</span><div class="chips" data-r="mode"></div></div>
      <div data-r="once"></div>
      <div data-r="rec" class="flat" hidden>
        <div class="field"><span class="lbl">Op deze dagen</span><div class="chips" data-r="days"></div></div>
        <div class="two">
          <div class="field"><label for="${idp}rf">Van</label><input type="time" id="${idp}rf" value="08:00" step="900"></div>
          <div class="field"><label for="${idp}ru">Tot</label><input type="time" id="${idp}ru" value="18:00" step="900"></div>
        </div>
        <p class="muted small" style="margin:0">Ligt de eindtijd voor de begintijd, dan loopt het door tot de volgende dag.</p>
      </div>
      <div class="field"><label for="${idp}n">Opmerking (mag leeg)</label><input type="text" id="${idp}n" maxlength="140" placeholder="Bijv. graag recht parkeren"></div>
      <div class="err" data-r="err" hidden></div>
      <button class="btn block" type="submit">Plek vrijgeven</button>
    </form>`;
  const q = (k) => host.querySelector(`[data-r="${k}"]`);
  const rng = rangeField(q("once"), { fromNow: true, from: now(), until: at(now(), 1, 8), quick: true, durLabel: "Vrij voor" });
  const paint = () => {
    if (q("spots")) q("spots").innerHTML = my.map(p => `<button type="button" class="chip" data-sp="${p}" aria-pressed="${sel.has(p)}">${esc(mineLabel(p))}</button>`).join("");
    q("mode").innerHTML = `<button type="button" class="chip" data-mode="once" aria-pressed="${mode === "once"}">Eenmalig</button><button type="button" class="chip" data-mode="rec" aria-pressed="${mode === "rec"}">Elke week</button>`;
    q("once").hidden = mode !== "once"; q("rec").hidden = mode !== "rec";
    q("days").innerHTML = DAYS.map(([d, l]) => `<button type="button" class="chip" data-day="${d}" aria-pressed="${days.has(d)}">${l}</button>`).join("");
  };
  host.addEventListener("click", (e) => {
    const sp = e.target.closest("[data-sp]"), md = e.target.closest("[data-mode]"), dy = e.target.closest("[data-day]");
    if (sp) { sel.has(sp.dataset.sp) ? sel.delete(sp.dataset.sp) : sel.add(sp.dataset.sp); paint(); }
    if (md) { mode = md.dataset.mode; paint(); }
    if (dy) { const d = Number(dy.dataset.day); days.has(d) ? days.delete(d) : days.add(d); paint(); }
  });
  host.querySelector("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = q("err"); showErr(err, "");
    const btn = host.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await submitRelease({ spots: [...sel], mode, range: rng.get(), days: [...days], ft: $(`#${idp}rf`).value, ut: $(`#${idp}ru`).value, note: $(`#${idp}n`).value.trim().slice(0, 140) }, (m) => showErr(err, m));
    } finally { btn.disabled = false; }
  });
  paint();
}
function releaseSheet(spot) {
  openSheet("Mijn plek vrijgeven", `<div id="relSheet"></div>`);
  mountReleaseForm($("#relSheet"), { spot });
}

/* ---------- verzoeken ---------- */
let reqRange = null;
function renderRequests(wins) {
  const n = now();
  const list = st.requests.filter(r => r.until > n).sort((a, b) => a.from - b.from);
  if (!list.length) { $("#requests").innerHTML = `<div class="empty">Er staan geen verzoeken open.</div>`; return; }
  const my = st.house ? spotsOf(st.house) : [];
  $("#requests").innerHTML = list.map(r => {
    let act = "";
    if (r.offeredSpot) act = `<span class="pill free">Geregeld: plek van nr ${esc(r.offeredBy)}</span>`;
    else if (r.house === st.house) act = `<div class="row"><a class="btn wa sm" href="${esc(waShare(`Hoi buren! Heeft iemand ${range(r.from, r.until)} een parkeerplek vrij? ${r.note ? "(" + r.note + ") " : ""}Aanbieden kan in ${APP}: ${APP_URL}`))}" target="_blank" rel="noopener">${waIcon}Deel in buurtgroep</a><button class="btn ghost sm" data-action="delreq" data-id="${r.id}">Intrekken</button></div>`;
    else if (st.house && my.length) act = `<div class="row">${my.map(p => {
      const ok = canOffer(p, r);
      return `<button class="btn green sm" data-action="offer" data-id="${r.id}" data-spot="${p}" ${ok ? "" : "disabled"}>Bied ${my.length > 1 ? esc(spotName(p)) : "je plek"} aan</button>`; }).join("")}</div>`;
    return `<div class="card ${r.offeredSpot ? "is-free" : ""}"><div class="head"><span class="pid">nr ${esc(r.house)}</span><span class="muted">zoekt een plek</span></div>
      <div class="when">${esc(range(r.from, r.until))}</div>${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}${act}</div>`;
  }).join("");
}
// Aanbieden kan als de plek in die periode niet door een ander geclaimd is.
function canOffer(p, r) {
  return !liveClaims().some(c => c.spot === p && c.from < r.until && c.until > r.from);
}

/* ---------- mijn ---------- */
function renderMine(wins) {
  $("#houseChips").innerHTML = HOUSES.map(h => `<button type="button" class="chip" data-action="house" data-h="${h}" aria-pressed="${st.house === h}">${STREET} ${h}</button>`).join("");
  $("#valHouse").textContent = st.house ? `${STREET} ${st.house}` : "kies je adres";
  if (!st.house) $("#setHouse").open = true;
  $("#accountLine").textContent = st.user ? `Ingelogd als ${st.user.email}` : "";
  const my = st.house ? spotsOf(st.house) : [];
  $("#valSpot").textContent = !st.house ? "" : my.length ? (my.length > 1 ? `${my.length} plekken` : "gekoppeld") : "nog niet gekoppeld";
  if (st.house && !my.length && !renderMine.openedSpot) { $("#setSpot").open = true; renderMine.openedSpot = true; }
  $("#valCharger").textContent = !my.length ? "" : my.some(hasCharger) ? "ja" : "nee";
  $("#setCharger").hidden = !my.length;
  const rec = st.house ? (st.phones[st.house] || {}) : {}, me = (rec.contacts || {})[st.user?.uid];
  $("#valPhone").textContent = me ? `${me.name} · ${me.phone}` : "niet ingevuld";
  $("#phonePanel").hidden = !st.house;
  if (!st.house) {
    $("#spotSetup").innerHTML = "";
    $("#mine").innerHTML = `<div class="empty">Kies eerst je adres bij Instellingen.</div>`;
    return;
  }
  if (!document.activeElement?.matches?.("#phone,#cname")) { $("#phone").value = me?.phone || ""; $("#cname").value = me?.name || ""; }
  $("#delPhone").hidden = !me;
  const others = contactsOf(st.house).filter(c => c.uid !== st.user.uid);
  const legacy = others.find(c => !c.uid);
  $("#housemates").innerHTML = (others.length ? `<div class="note">Ook bereikbaar voor nr ${esc(st.house)}: ${others.map(c => c.name ? esc(c.name) : `nummer zonder naam (${esc(rec.phone || "")})`).join(", ")}.</div>` : "")
    + (legacy && !me ? `<div class="notice"><span>Is ${esc(rec.phone)} jouw nummer? Vul je voornaam in en tik op Opslaan, dan staat het er met je naam.</span><div class="row" style="margin-top:6px"><button class="btn sm ghost" data-action="uselegacy">Ja, dit is mijn nummer</button></div></div>` : "")
    + (legacy && me ? `<div class="row"><button class="btn ghost sm" data-action="dellegacy">Nummer zonder naam verwijderen</button></div>` : "");
  if (!$("#linkMap")) $("#spotSetup").innerHTML = `<p class="muted small" style="margin:0">Tik op de kaart op je eigen plek. Nog een keer tikken maakt hem weer los.</p><div class="mapbox" id="linkMap"></div>`;
  renderMap(wins, "#linkMap", "link");
  $("#chargerToggles").innerHTML = my.map(p => `<label class="toggle" for="ch_${p}"><span><strong>${esc(mineLabel(p))}</strong> heeft een openbare laadpaal die buren mogen gebruiken</span><input type="checkbox" id="ch_${p}" data-action="togglecharger" data-spot="${p}" ${hasCharger(p) ? "checked" : ""}></label>`).join("");

  const n = now();
  const mineW = wins.filter(w => w.house === st.house && w.end > n).slice(0, 12);
  const myClaims = liveClaims().filter(c => c.house === st.house && c.until > n).sort((a, b) => a.from - b.from);
  const recs = st.recurring.filter(r => r.house === st.house);
  let html = `<div class="dayhead">${my.length > 1 ? "Mijn plekken" : "Mijn plek"}</div>`;
  html += mineW.length ? mineW.map(w => {
    const cs = claimsIn(w);
    return `<div class="card ${cs.length ? "is-claimed" : "is-free"}">
      <div class="big">${w.start > n ? `Vrij ${esc(range(w.start, w.end))}` : `Vrij tot ${esc(when(w.end))}`}</div>
      <div class="row" style="gap:6px">${my.length > 1 ? `<span class="pill neutral">${esc(mineLabel(w.spot))}</span>` : ""}${w.src === "rec" ? `<span class="pill neutral">wekelijks</span>` : ""}
      ${cs.map(c => `<span class="pill claimed">nr ${esc(c.house)} · ${esc(range(c.from, c.until))}</span>`).join("")}${cs.length ? "" : `<span class="pill free">nog niet geclaimd</span>`}</div>
      <div class="row"><button class="btn ghost sm" data-action="earlysheet" data-key="${w.key}">${w.start > n ? "Wijzigen of intrekken" : "Eerder terug"}</button></div></div>`;
  }).join("") : `<div class="empty">Je plek staat nu niet vrijgegeven. <button class="btn sm" data-action="releasesheet">Mijn plek vrijgeven</button></div>`;
  if (recs.length) {
    html += `<div class="dayhead">Wekelijks</div>` + recs.map(r => `<div class="card"><div class="head"><span class="pid">${esc(mineLabel(r.spot))}</span><span class="pill neutral">wekelijks</span></div>
      <div class="when">${DAYS.filter(([d]) => (r.days || []).includes(d)).map(([, l]) => l).join(" ")} · ${esc(r.fromTime)} tot ${esc(r.untilTime)}</div>
      <div class="row"><button class="btn danger sm" data-action="stoprec" data-ref="${r.id}">Stop herhaling</button></div></div>`).join("");
  }
  html += `<div class="dayhead">Mijn claims</div>`;
  html += myClaims.length ? myClaims.map(c => `<div class="card is-claimed"><div class="big">Plek van ${esc(spotNr(c.spot))}</div>
    <div class="when">${esc(range(c.from, c.until))}</div>
    <div class="row"><button class="btn ghost sm" data-action="unclaim" data-id="${c.id}" data-spot="${c.spot}">${c.from <= n ? "Ik ben weg" : "Intrekken"}</button>${waBtns(c.owner, `Hoi! Ik (${STREET} ${st.house}) sta ${range(c.from, c.until)} op jouw parkeerplek. Groet!`)}</div></div>`).join("") : `<div class="empty">Je hebt geen plek van een buur geclaimd.</div>`;
  $("#mine").innerHTML = html;
}

function render() {
  if (!st.member) return;
  const wins = windows();
  renderBanner(); renderNotices(wins); renderMoment(); renderMap(wins); renderOptions(wins);
  renderRequests(wins); renderMine(wins);
  const key = `${st.house}|${st.house ? spotsOf(st.house).join(",") : ""}`;
  if (key !== st.relTabKey) { st.relTabKey = key; mountReleaseForm($("#relTab")); }
}

/* ---------- uitschuifpaneel ---------- */
function openSheet(title, body) {
  st.sheet = true;
  $("#sheetRoot").innerHTML = `<div class="scrim" data-action="closesheet"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div>
      <div class="shead"><h2>${esc(title)}</h2><button class="x" data-action="closesheet" aria-label="Sluiten">×</button></div>
      <div class="flat" id="sheetBody">${body}</div></div>`;
  document.body.style.overflow = "hidden";
}
function sheetBody(html) { const b = $("#sheetBody"); if (b) b.innerHTML = html; }
function closeSheet() { st.sheet = null; $("#sheetRoot").innerHTML = ""; document.body.style.overflow = ""; }

function spotSheet(p) {
  const wins = windows(), t = T(), s = statusAt(p, t, wins), own = ownerOf(p);
  const up = wins.filter(w => w.spot === p && w.end > now()).slice(0, 6);
  const head = s.cls === "free" ? `<span class="pill free">vrij tot ${esc(when(s.freeUntil))}</span>` : s.cls === "claimed" ? `<span class="pill claimed">bezet door nr ${esc(s.c.house)} tot ${esc(when(s.c.until))}</span>` : s.cls === "own" ? `<span class="pill neutral">eigenaar gebruikt hem</span>` : `<span class="pill neutral">nog niet gekoppeld</span>`;
  const mine = st.house && own === st.house;
  openSheet(own ? `Plek van nr ${spotName(p)}` : "Plek zonder adres", `<div class="row"><span class="muted">${own ? `${STREET} ${esc(own)}` : "Nog niet aan een woning gekoppeld"}</span>${head}${hasCharger(p) ? boltPill : ""}</div>
    ${!own && st.house ? `<button class="btn block" data-action="linkspot" data-spot="${p}">Dit is mijn plek</button>` : ""}
    ${s.cls === "free" && !mine && st.house ? `<button class="btn green block" data-action="claimsheet" data-key="${s.w.key}">Claim deze plek</button>` : ""}
    ${mine ? `<button class="btn block" data-action="releasesheet" data-spot="${p}">${clockIcon}Plek vrijgeven</button>` : ""}
    <div class="dayhead">Gepland vrij</div>
    ${up.length ? `<div class="list">${up.map(w => { const cs = claimsIn(w);
      return `<div class="card ${cs.length ? "is-claimed" : "is-free"}"><div class="when">${esc(range(w.start, w.end))}</div>
      ${cs.map(c => `<span class="pill claimed">nr ${esc(c.house)} ${esc(range(c.from, c.until))}</span>`).join(" ")}
      ${w.note ? `<div class="note">${esc(w.note)}</div>` : ""}
      ${mine ? `<button class="btn ghost sm" data-action="earlysheet" data-key="${w.key}">${w.start > now() ? "Wijzigen of intrekken" : "Eerder terug"}</button>` : ""}
      ${!mine && st.house ? `<button class="btn green sm" data-action="claimsheet" data-key="${w.key}">Claim in deze periode</button>` : ""}</div>`; }).join("")}</div>`
      : `<div class="empty">Geen vrijgaven gepland.</div>`}`);
}
let claimRange = null;
function claimSheet(key) {
  const w = windows().find(x => x.key === key); if (!w) return;
  const t = Math.max(T(), now());
  const from = Math.min(Math.max(w.start, t), w.end);
  const cs = claimsIn(w);
  const next = cs.find(c => c.from >= from);
  const until = next ? next.from : w.end;
  openSheet(`Claim ${plekVan(w.spot)}`, `
    <div class="muted">Vrijgegeven ${esc(range(w.start, w.end))}</div>
    ${hasCharger(w.spot) ? `<div>${boltPill}</div>` : ""}
    ${cs.length ? `<div class="note">Al geclaimd: ${cs.map(c => `nr ${esc(c.house)} ${esc(range(c.from, c.until))}`).join(", ")}</div>` : ""}
    <div id="claimRange"></div>
    <div class="err" id="cErr" hidden></div>
    <button class="btn green block" data-action="claim" data-key="${key}">Claim deze plek</button>`);
  claimRange = rangeField($("#claimRange"), { from, until, minFrom: () => Math.max(w.start, floorQ(now())), maxUntil: () => w.end, durLabel: "Duur" });
}
let earlyTF = null, earlyVal = 0;
function earlySheet(key) {
  const w = windows().find(x => x.key === key); if (!w) return;
  const future = w.start > now();
  const cs = claimsIn(w);
  earlyVal = future ? w.end : Math.min(w.end, ceilQ(now() + 30 * MIN));
  openSheet(future ? `${mineLabel(w.spot)} wijzigen` : "Eerder terug", `
    <div class="when">${esc(range(w.start, w.end))}</div>
    ${cs.length ? `<div class="notice amber"><span>Geclaimd door ${cs.map(c => `nr ${esc(c.house)} (${esc(range(c.from, c.until))})`).join(", ")}. Zij zien je wijziging bovenaan in de app.</span></div>` : ""}
    <div id="earlyTF"></div>
    <div class="err" id="eErr" hidden></div>
    <button class="btn block" data-action="early" data-key="${key}">Opslaan</button>
    <button class="btn danger block" data-action="cancelwin" data-key="${key}">${future ? "Helemaal niet vrijgeven" : "Ik ben er nu al"}</button>
    ${w.src === "rec" ? `<p class="muted small" style="margin:0">Dit geldt alleen voor deze keer. De wekelijkse herhaling stop je bij Mijn.</p>` : ""}`);
  earlyTF = timeField($("#earlyTF"), { label: future ? "Vrij tot" : "Ik ben terug om", get: () => earlyVal, set: (v) => { earlyVal = v; }, min: () => Math.max(w.start, floorQ(now())), max: () => w.end });
}

/* ---------- schrijven ---------- */
class UserError extends Error {}
async function guard(fn) {
  try { await fn(); return true; }
  catch (e) {
    console.warn(e);
    if (e instanceof UserError) toast(e.message);
    else if (e && e.code === "permission-denied") toast("Geen toegang. Log opnieuw in.");
    else if (e && e.code === "unavailable") toast("Geen verbinding. Probeer het zo nog eens.");
    else toast("Dat lukte niet. Probeer het zo nog eens.");
    return false;
  }
}
// Claims per plek staan in één document; wijzigen gaat via een transactie, zodat twee buren nooit tegelijk dezelfde tijd claimen.
async function mutateClaims(spot, fn) {
  const ref = doc(fs, "claims", spot);
  return runTransaction(fs, async (tx) => {
    const snap = await tx.get(ref);
    const items = ((snap.exists() && snap.data().items) || []).filter(c => (c.until || 0) > now() - 2 * D || (c.earlyReturn && c.earlyReturn > now() - 2 * D));
    const res = fn(items);
    tx.set(ref, { items, updatedAt: now() });
    return res;
  });
}
async function setHouse(h) {
  if (await guard(() => updateDoc(doc(fs, "members", st.user.uid), { house: h }))) { st.house = h; $("#setHouse").open = false; render(); }
}
async function linkSpot(p) {
  const o = ownerOf(p);
  await guard(async () => {
    if (o === st.house) await setDoc(doc(fs, "spots", p), { house: null, charger: false, updatedAt: now() });
    else if (!o) await setDoc(doc(fs, "spots", p), { house: st.house, charger: hasCharger(p), updatedAt: now() });
  });
}
async function setCharger(p, on) {
  if (ownerOf(p) !== st.house) return;
  if (await guard(() => setDoc(doc(fs, "spots", p), { house: st.house, charger: !!on, updatedAt: now() })))
    toast(on ? "De laadpaal staat nu op de kaart." : "Laadpaal verwijderd.");
}
async function savePhone(del) {
  const err = $("#phoneErr"); showErr(err, "");
  const ref = doc(fs, "houses", st.house);
  if (del) {
    if (await guard(() => updateDoc(ref, new FieldPath("contacts", st.user.uid), deleteField()))) toast("Je nummer is verwijderd.");
    return;
  }
  const name = $("#cname").value.trim().slice(0, 30), v = $("#phone").value.trim();
  if (!name && !v) return showErr(err, "Vul je voornaam en mobiele nummer in.");
  if (!name) return showErr(err, "Vul ook je voornaam in.");
  if (!v) return showErr(err, "Vul ook je mobiele nummer in. Zonder nummer kunnen buren je niet appen.");
  if (!normPhone(v)) return showErr(err, "Dit lijkt geen geldig mobiel nummer. Bijvoorbeeld: 06 12345678.");
  if (await guard(() => setDoc(ref, { contacts: { [st.user.uid]: { name, phone: v, updatedAt: now() } }, updatedAt: now() }, { merge: true }))) toast(`Opgeslagen: ${name}, ${v}.`);
}
async function delLegacy() {
  if (await guard(() => updateDoc(doc(fs, "houses", st.house), { phone: deleteField() }))) toast("Nummer zonder naam verwijderd.");
}
function useLegacy() {
  const rec = st.phones[st.house] || {};
  $("#phone").value = rec.phone || "";
  $("#cname").focus();
  showErr($("#phoneErr"), "Vul je voornaam in en tik op Opslaan.");
}
function linkTap(p) {
  const o = ownerOf(p);
  if (!o) { linkSpot(p); return; }
  if (o === st.house) {
    openSheet("Plek loskoppelen?", `<p style="margin:0">Deze plek hoort nu bij nr ${esc(st.house)}. Wil je hem loskoppelen?</p>
      <button class="btn danger block" data-action="unlinkspot" data-spot="${p}">Loskoppelen</button>
      <button class="btn ghost block" data-action="closesheet">Annuleren</button>`);
    return;
  }
  toast(`Deze plek hoort bij nr ${o}. Klopt dat niet? Vraag nr ${o} om hem los te koppelen.`);
}
// Eenmalige vrijgave opslaan; overlapt of sluit aan op een eerdere vrijgave van dezelfde plek: samenvoegen.
async function upsertRelease(p, from, until, note) {
  const touch = st.releases.filter(r => r.spot === p && r.until > r.from && r.from <= until && r.until >= from).sort((a, b) => a.from - b.from);
  let f = from, u = until;
  for (const r of touch) { f = Math.min(f, r.from); u = Math.max(u, r.until); }
  if (touch.length) {
    const [keep, ...rest] = touch;
    await updateDoc(doc(fs, "releases", keep.id), { from: f, until: u, note: note || keep.note || "" });
    for (const r of rest) await deleteDoc(doc(fs, "releases", r.id));
  } else {
    await addDoc(collection(fs, "releases"), { spot: p, house: st.house, from, until, note, createdAt: now() });
  }
  return { f, u, merged: touch.length > 0 };
}
async function submitRelease({ spots, mode, range: r, days, ft, ut, note }, fail) {
  if (!spots.length) return fail("Kies welke plek je vrijgeeft.");
  if (mode === "once") {
    const from = r.fromNow ? now() : r.from, until = r.until;
    if (until <= from) return fail("De eindtijd moet na de begintijd liggen.");
    if (until <= now()) return fail("Deze periode ligt al in het verleden.");
    if (until - from > 31 * D) return fail("Geef je plek voor maximaal een maand tegelijk vrij.");
    let res = null;
    const ok = await guard(async () => { for (const p of spots) res = await upsertRelease(p, from, until, note); });
    if (ok) afterRelease(`${spots.map(mineLabel).join(" en ")} is ${res.merged ? "nu " : ""}vrij ${range(res.f, res.u)}`, `vrij ${range(res.f, res.u)}`, res.merged);
  } else {
    if (!days.length) return fail("Kies minstens één dag.");
    if (!ft || !ut || ft === ut) return fail("Vul een begin- en eindtijd in die verschillen.");
    const ok = await guard(async () => { for (const p of spots) await addDoc(collection(fs, "recurring"), { spot: p, house: st.house, days, fromTime: ft, untilTime: ut, note, since: sod(now()), overrides: {}, createdAt: now() }); });
    const dd = `elke ${DAYS.filter(([d]) => days.includes(d)).map(([, l]) => l).join(", ")} vrij van ${ft} tot ${ut}`;
    if (ok) afterRelease(`${spots.map(mineLabel).join(" en ")} is ${dd}`, dd);
  }
}
function afterRelease(txt, shareTxt, merged) {
  st.relTabKey = null;
  setTab("overzicht");
  openSheet("Vrijgegeven", `<div class="notice green"><span>${esc(txt)}.${merged ? " Samengevoegd met je eerdere vrijgave." : ""}</span></div>
    <p class="muted" style="margin:0">Wil je het de buren laten weten?</p>
    <a class="btn wa block" href="${esc(waShare(`Hoi buren! De parkeerplek van ${STREET} ${st.house} is ${shareTxt}. Claimen kan in ${APP}: ${APP_URL}`))}" target="_blank" rel="noopener">${waIcon}Deel in buurtgroep</a>
    <button class="btn ghost block" data-action="closesheet">Klaar</button>`);
  render();
}
async function claim(key) {
  const w = windows().find(x => x.key === key); if (!w || !claimRange) return;
  const err = $("#cErr"); const fail = (m) => showErr(err, m);
  const { from, until } = claimRange.get();
  if (until <= from) return fail("De eindtijd moet na de begintijd liggen.");
  if (from < w.start - MIN || until > w.end + MIN) return fail(`Kies een tijd binnen ${range(w.start, w.end)}.`);
  if (until <= now()) return fail("Deze tijd ligt al in het verleden.");
  const f = Math.max(from, w.start), u = Math.min(until, w.end);
  try {
    await mutateClaims(w.spot, (items) => {
      const clash = items.find(c => c.house && c.until > c.from && c.from < u && c.until > f);
      if (clash) throw new UserError(`Nr ${clash.house} heeft deze plek al ${range(clash.from, clash.until)}. Kies een andere tijd.`);
      items.push({ id: rid(), owner: w.house, windowStart: w.start, windowEnd: w.end, house: st.house, from: f, until: u, earlyReturn: null, createdAt: now() });
    });
  } catch (e) { console.warn(e); return fail(e instanceof UserError ? e.message : "Claimen lukte niet. Controleer je verbinding en probeer het opnieuw."); }
  const msg = `Hoi! Ik (${STREET} ${st.house}) heb jouw parkeerplek geclaimd, ${range(f, u)}. Dank je wel!`;
  const btns = waBtns(w.house, msg);
  sheetBody(`<div class="notice green"><strong>De plek van nr ${esc(spotName(w.spot) || w.house)} is voor jou</strong><span>${esc(range(f, u))}.</span></div>
    ${btns ? `<p class="muted" style="margin:0">Laat nr ${esc(w.house)} het weten:</p>${btns}` : `<p class="muted" style="margin:0">Nr ${esc(w.house)} heeft geen WhatsApp-nummer ingevuld, maar ziet je claim in de app.</p>`}
    <button class="btn ghost block" data-action="closesheet">Klaar</button>`);
}
async function unclaim(id, spot) {
  if (await guard(() => mutateClaims(spot, (items) => {
    const i = items.findIndex(c => c.id === id); if (i < 0) return;
    const c = items[i];
    if (c.earlyReturn || c.from > now()) items.splice(i, 1);
    else c.until = Math.max(c.from, now());
  }))) toast("De plek is weer vrij.");
}
async function ack(id, spot) {
  await guard(() => mutateClaims(spot, (items) => { const c = items.find(c => c.id === id); if (c) c.earlyReturn = null; }));
}
async function changeEnd(key, t) {
  const w = windows().find(x => x.key === key); if (!w) return;
  if (isNaN(t)) return showErr($("#eErr"), "Kies een tijd.");
  const end = Math.max(w.start, Math.min(t, w.end));
  const hit = claimsIn(w).filter(c => c.until > end);
  const ok = await guard(async () => {
    if (w.src === "once") await updateDoc(doc(fs, "releases", w.ref), { until: end });
    else await updateDoc(doc(fs, "recurring", w.ref), new FieldPath("overrides", String(w.start)), end);
    if (hit.length) await mutateClaims(w.spot, (items) => {
      for (const c of items) if (hit.some(h => h.id === c.id)) { c.earlyReturn = end; c.until = Math.max(c.from, end); }
    });
  });
  if (!ok) return;
  const msgFor = (c) => `Hoi, ik (${STREET} ${st.house}) kom eerder terug. Wil je mijn parkeerplek ${end <= c.from ? "toch niet gebruiken" : `vrijmaken voor ${when(end)}`}? Sorry en dank je!`;
  sheetBody(`<div class="notice green"><span>${end <= w.start ? `${esc(mineLabel(w.spot))} wordt niet vrijgegeven.` : `${esc(mineLabel(w.spot))} is weer van jou vanaf ${esc(when(end))}.`}</span></div>
    ${hit.map(c => { const b = waBtns(c.house, msgFor(c)); return b ? `<p class="muted" style="margin:0">Waarschuw nr ${esc(c.house)}:</p>${b}` : `<div class="note">Nr ${esc(c.house)} heeft geen WhatsApp-nummer ingevuld. Ze zien het in de app.</div>`; }).join("")}
    <button class="btn ghost block" data-action="closesheet">Klaar</button>`);
}
async function stopRec(id) { if (await guard(() => deleteDoc(doc(fs, "recurring", id)))) toast("Herhaling gestopt."); }
async function submitRequest(ev) {
  ev.preventDefault();
  const err = $("#reqErr"); const fail = (m) => showErr(err, m); fail("");
  if (!st.house) return fail("Kies eerst je adres bij Mijn.");
  const { from, until } = reqRange.get();
  if (until <= from) return fail("De eindtijd moet na de begintijd liggen.");
  if (until <= now()) return fail("Deze periode ligt al in het verleden.");
  const note = $("#reqNote").value.trim().slice(0, 140);
  if (await guard(() => addDoc(collection(fs, "requests"), { house: st.house, from, until, note, offeredBy: null, offeredSpot: null, createdAt: now() }))) {
    $("#reqNote").value = "";
    openSheet("Verzoek geplaatst", `<p style="margin:0">Buren zien je verzoek in de app. Deel het ook in de buurtgroep, dan ziet iedereen het sneller.</p>
      <a class="btn wa block" href="${esc(waShare(`Hoi buren! Heeft iemand ${range(from, until)} een parkeerplek vrij? ${note ? "(" + note + ") " : ""}Aanbieden kan in ${APP}: ${APP_URL}`))}" target="_blank" rel="noopener">${waIcon}Deel in buurtgroep</a>
      <button class="btn ghost block" data-action="closesheet">Klaar</button>`);
  }
}
async function offer(id, p) {
  const r = st.requests.find(x => x.id === id); if (!r) return;
  const from = Math.max(r.from, floorQ(now())), until = r.until;
  const wins = windows();
  const ok = await guard(async () => {
    // Staat de plek al vrij in die periode, dan alleen de claim; anders eerst vrijgeven (samengevoegd met wat er al is).
    if (!wins.some(w => w.spot === p && w.start <= from && w.end >= until)) await upsertRelease(p, from, until, `Voor nr ${r.house}`);
    await mutateClaims(p, (items) => {
      const clash = items.find(c => c.house && c.until > c.from && c.from < until && c.until > from);
      if (clash) throw new UserError(`Nr ${clash.house} heeft je plek in die periode al geclaimd.`);
      items.push({ id: rid(), owner: st.house, windowStart: from, windowEnd: until, house: r.house, from, until, earlyReturn: null, createdAt: now() });
    });
    await updateDoc(doc(fs, "requests", id), { offeredBy: st.house, offeredSpot: p });
  });
  if (ok) openSheet("Aangeboden", `<div class="notice green"><span>Je plek staat klaar voor nr ${esc(r.house)}, ${esc(range(from, until))}.</span></div>
    ${waBtns(r.house, `Hoi! Je kunt ${range(from, until)} op mijn parkeerplek staan. Groet, ${STREET} ${st.house}`)}
    <button class="btn ghost block" data-action="closesheet">Klaar</button>`);
}
async function delReq(id) { if (await guard(() => deleteDoc(doc(fs, "requests", id)))) toast("Verzoek ingetrokken."); }

/* ---------- tabs ---------- */
const TABS = ["overzicht", "vrijgeven", "verzoeken", "mijn", "info"];
function setTab(t) {
  if (!TABS.includes(t)) t = "overzicht";
  st.tab = t;
  document.querySelectorAll("section[data-tab]").forEach(s => s.hidden = s.dataset.tab !== t);
  document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === t));
  try { history.replaceState(null, "", "#" + t); } catch {}
  window.scrollTo({ top: 0 });
}

/* ---------- inloggen en lid worden ---------- */
const AUTH_ERR = {
  "auth/invalid-email": "Dat e-mailadres klopt niet.",
  "auth/missing-password": "Vul een wachtwoord in.",
  "auth/weak-password": "Kies een wachtwoord van minstens 6 tekens.",
  "auth/email-already-in-use": "Er is al een account met dit e-mailadres. Log in.",
  "auth/invalid-credential": "E-mailadres of wachtwoord klopt niet.",
  "auth/wrong-password": "E-mailadres of wachtwoord klopt niet.",
  "auth/user-not-found": "E-mailadres of wachtwoord klopt niet.",
  "auth/too-many-requests": "Te veel pogingen. Wacht even en probeer opnieuw.",
  "auth/network-request-failed": "Geen verbinding met internet.",
};
function showScreen(name) {
  $("#authScreen").hidden = name === "app";
  $("#appScreen").hidden = name !== "app";
  $("#tabs").hidden = name !== "app";
  $("#whoami").hidden = name !== "app";
  if (name !== "app") {
    $("#loginBox").hidden = name !== "login";
    $("#joinBox").hidden = name !== "join";
    $("#loadingBox").hidden = name !== "loading";
  }
}
function renderAuthMode() {
  const signup = st.authMode === "signup";
  $("#authTitle").textContent = signup ? "Account maken" : "Inloggen";
  $("#authSubmit").textContent = signup ? "Account maken" : "Inloggen";
  $("#authSwitch").textContent = signup ? "Ik heb al een account" : "Nieuw hier? Maak een account";
  $("#signupExtra").hidden = !signup;
  $("#authPw").autocomplete = signup ? "new-password" : "current-password";
  $("#forgot").hidden = signup;
}
function authErr(m) { showErr($("#authErr"), m); }
async function submitAuth(ev) {
  ev.preventDefault(); authErr("");
  const email = $("#authEmail").value.trim(), pw = $("#authPw").value;
  const btn = $("#authSubmit"); btn.disabled = true;
  try {
    if (st.authMode === "signup") {
      const code = $("#authCode").value.trim(), house = $("#authHouse").value;
      if (!code) throw { code: "x", message: "Vul de buurtcode in." };
      if (!HOUSES.includes(house)) throw { code: "x", message: "Kies je huisnummer." };
      sessionStorageSet("pz_pending", JSON.stringify({ code, house }));
      await createUserWithEmailAndPassword(auth, email, pw);
    } else {
      await signInWithEmailAndPassword(auth, email, pw);
    }
  } catch (e) {
    authErr(e.code === "x" ? e.message : (AUTH_ERR[e.code] || "Dat lukte niet. Probeer het opnieuw."));
  } finally { btn.disabled = false; }
}
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch {} }
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageDel(k) { try { sessionStorage.removeItem(k); } catch {} }
async function join(code, house) {
  try {
    await setDoc(doc(fs, "members", st.user.uid), { code, house, email: st.user.email || "", createdAt: now() });
    return true;
  } catch (e) {
    console.warn(e);
    return false;
  }
}
async function submitJoin(ev) {
  ev.preventDefault();
  const e = $("#joinErr"); e.hidden = true;
  const code = $("#joinCode").value.trim(), house = $("#joinHouse").value;
  if (!code || !HOUSES.includes(house)) return showErr(e, "Vul de buurtcode in en kies je huisnummer.");
  if (await join(code, house)) await enterApp();
  else showErr(e, "Deze buurtcode klopt niet. Let op hoofdletters, en vraag hem anders na bij een buur.");
}
async function forgot() {
  const email = $("#authEmail").value.trim();
  if (!email) { authErr("Vul eerst je e-mailadres in."); return; }
  try { await sendPasswordResetEmail(auth, email); authErr(""); toast("Als dit adres bekend is, krijg je een mail om je wachtwoord te herstellen."); }
  catch (e) { authErr(AUTH_ERR[e.code] || "Versturen lukte niet."); }
}
async function enterApp() {
  const snap = await getDoc(doc(fs, "members", st.user.uid));
  if (!snap.exists()) { showScreen("join"); return; }
  st.member = snap.data();
  st.house = HOUSES.includes(st.member.house) ? st.member.house : null;
  showScreen("app");
  setTab((location.hash || "").slice(1) || "overzicht");
  if (!reqRange) reqRange = rangeField($("#reqRange"), { from: at(now(), 1, 18), until: at(now(), 1, 23), quick: true, durLabel: "Duur" });
  subscribe();
  render();
}
function subscribe() {
  if (st.live) return;
  st.live = true;
  const cut = now() - D, err = (e) => { console.warn("db", e); if (e.code === "permission-denied") toast("Geen toegang tot de gegevens."); };
  const arr = (k) => (s) => { st[k] = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); };
  const map = (k) => (s) => { const m = {}; s.docs.forEach(d => m[d.id] = d.data()); st[k] = m; render(); };
  st.unsubs = [
    onSnapshot(collection(fs, "spots"), map("spots"), err),
    onSnapshot(collection(fs, "houses"), map("phones"), err),
    onSnapshot(query(collection(fs, "releases"), where("until", ">", cut)), arr("releases"), err),
    onSnapshot(collection(fs, "recurring"), arr("recurring"), err),
    onSnapshot(collection(fs, "claims"), (s) => { st.claims = s.docs.flatMap(d => (d.data().items || []).map(c => ({ ...c, spot: d.id }))); render(); }, err),
    onSnapshot(query(collection(fs, "requests"), where("until", ">", cut)), arr("requests"), err),
  ];
}
function unsubscribeAll() { st.unsubs.forEach(u => { try { u(); } catch {} }); st.unsubs = []; st.live = false; }

onAuthStateChanged(auth, async (user) => {
  st.user = user;
  if (!user) { unsubscribeAll(); st.member = null; st.house = null; st.relTabKey = null; showScreen("login"); renderAuthMode(); return; }
  showScreen("loading");
  try {
    const snap = await getDoc(doc(fs, "members", user.uid));
    if (!snap.exists()) {
      const pending = sessionStorageGet("pz_pending");
      sessionStorageDel("pz_pending");
      if (pending) {
        const { code, house } = JSON.parse(pending);
        if (await join(code, house)) { await enterApp(); return; }
        $("#joinHouse").value = house;
        showErr($("#joinErr"), "Je account is aangemaakt, maar de buurtcode klopt niet. Probeer het opnieuw.");
      }
      showScreen("join");
      return;
    }
    await enterApp();
  } catch (e) {
    console.warn(e);
    showScreen("join");
  }
});

/* ---------- events ---------- */
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]"); if (!el) return;
  const a = el.dataset.action, d = el.dataset;
  if (el.tagName === "A") e.preventDefault();
  switch (a) {
    case "goto": closeSheet(); setTab(d.tab); break;
    case "moment": st.moment = d.v ? Number(d.v) : null; st.momentOpen = false; render(); break;
    case "momentcustom": st.momentOpen = !st.momentOpen; render(); break;
    case "spot": spotSheet(d.spot); break;
    case "claimsheet": claimSheet(d.key); break;
    case "claim": claim(d.key); break;
    case "earlysheet": earlySheet(d.key); break;
    case "early": changeEnd(d.key, earlyVal); break;
    case "cancelwin": { const w = windows().find(x => x.key === d.key); if (w) changeEnd(w.key, w.start > now() ? w.start : floorQ(now())); break; }
    case "unclaim": unclaim(d.id, d.spot); break;
    case "ack": ack(d.id, d.spot); break;
    case "stoprec": stopRec(d.ref); break;
    case "closesheet": closeSheet(); break;
    case "releasesheet": releaseSheet(d.spot); break;
    case "house": setHouse(d.h); break;
    case "linkspot": closeSheet(); linkSpot(d.spot); break;
    case "unlinkspot": closeSheet(); linkSpot(d.spot); break;
    case "linktap": linkTap(d.spot); break;
    case "togglecharger": setCharger(d.spot, el.checked); break;
    case "onlycharger": st.onlyCharger = !st.onlyCharger; render(); break;
    case "savephone": savePhone(false); break;
    case "delphone": savePhone(true); break;
    case "dellegacy": delLegacy(); break;
    case "uselegacy": useLegacy(); break;
    case "offer": offer(d.id, d.spot); break;
    case "delreq": delReq(d.id); break;
    case "authswitch": st.authMode = st.authMode === "login" ? "signup" : "login"; authErr(""); renderAuthMode(); break;
    case "forgot": forgot(); break;
    case "logout": closeSheet(); signOut(auth); break;
    case "reload": location.reload(); break;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && st.sheet) closeSheet();
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("g.spot")) { e.preventDefault(); e.target.dataset.action === "linktap" ? linkTap(e.target.dataset.spot) : spotSheet(e.target.dataset.spot); }
});
document.querySelectorAll("#tabs button").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
$("#reqForm").addEventListener("submit", submitRequest);
$("#authForm").addEventListener("submit", submitAuth);
$("#joinForm").addEventListener("submit", submitJoin);

const houseOpts = `<option value="">Kies…</option>` + HOUSES.map(h => `<option value="${h}">${STREET} ${h}</option>`).join("");
$("#authHouse").innerHTML = houseOpts;
$("#joinHouse").innerHTML = houseOpts;
renderAuthMode();
// Testomgeving? Dan duidelijk in beeld, zodat niemand hem met de echte app verwart.
if (cfg.envLabel) { document.querySelectorAll(".brand .sub").forEach(el => el.textContent = cfg.envLabel); document.documentElement.style.setProperty("--sign", "#b35c00"); }
// Elke minuut opnieuw tekenen (tijden, meldingen), maar niet terwijl iemand iets invult of aan de schijven draait.
setInterval(() => { if (!st.sheet && !document.activeElement?.matches?.("input,select,.wheel,.tfbtn") && !document.querySelector(".tfw:not([hidden])")) render(); }, 60e3);
// Nieuwe versie online gezet? Dan een melding met een knop om te vernieuwen.
async function checkVersion() {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    if (j.v && String(j.v) !== APP_VERSION) $("#updateBar").hidden = false;
  } catch {}
}
checkVersion();
setInterval(checkVersion, 15 * 60e3);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkVersion(); });
