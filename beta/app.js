// Parkeren Jutfasehof: buren delen hun parkeerplek als ze weg zijn.
// Gegevens in Firebase Firestore, inloggen met e-mail en wachtwoord plus een buurtcode.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, setPersistence, browserLocalPersistence,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword, deleteUser,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, onSnapshot, query, where, addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, getDocs, runTransaction, FieldPath, deleteField, increment,
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
const APP_VERSION = "7";
const KEEP_DAYS = 30; // oudere vrijgaven, claims en verzoeken worden opgeruimd

const st = {
  user: null, member: null, house: null, live: false, unsubs: [],
  spots: {}, phones: {}, releases: [], recurring: [], claims: [], requests: [], stats: {},
  moment: null, tab: "kaart", onlyCharger: false, momentOpen: false,
  sheet: null, authMode: "login",
  isAdmin: false, ob: null, spotsLoaded: false,
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
const fDate = new Intl.DateTimeFormat("nl-NL", { day: "numeric", month: "short" });
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
// Uren en minuten zijn rond: na 23 komt weer 00. Daarvoor staan ze een aantal keer achter elkaar
// en zetten we na elke draai stil terug naar het middelste blok (dat ziet er precies hetzelfde uit).
const REPS_H = 9, REPS_M = 25;
const mod = (a, n) => ((a % n) + n) % n;
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
    const hours = Array.from({ length: 24 * REPS_H }, (_, i) => i % 24);
    const mins = Array.from({ length: 4 * REPS_M }, (_, i) => (i % 4) * 15);
    const col = (key, items, fmt) => `<div class="wheel" data-w="${key}" tabindex="0" role="listbox" aria-label="${key === "d" ? "Dag" : key === "h" ? "Uur" : "Minuten"}">${items.map((x, i) => `<div data-i="${i}" role="option">${fmt(x)}</div>`).join("")}</div>`;
    this.host.innerHTML = `<div class="wheels"><div class="band" aria-hidden="true"></div>${col("d", this.days, dayLabel)}${col("h", hours, pad)}${col("m", mins, pad)}</div>`;
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
  vals(v) {
    const d = new Date(v);
    return [Math.max(0, this.days.findIndex(x => x === sod(v))), d.getHours(), Math.min(3, Math.floor(d.getMinutes() / 15))];
  }
  idx(v) { const [di, h, m] = this.vals(v); return [di, 24 * Math.floor(REPS_H / 2) + h, 4 * Math.floor(REPS_M / 2) + m]; }
  sync(v) {
    const ids = this.idx(v);
    this.lock = true;
    this.cols.forEach((c, k) => { c.scrollTop = ids[k] * ROW; });
    this.mark(v);
    clearTimeout(this._u); this._u = setTimeout(() => { this.lock = false; }, 80);
  }
  mark(v) {
    const [di, h, m] = this.vals(v), { min, max } = this.bounds(), day = sod(v);
    this.cols.forEach((c, k) => [...c.children].forEach((el, i) => {
      const on = k === 0 ? i === di : k === 1 ? i % 24 === h : i % 4 === m;
      el.classList.toggle("on", on);
      el.setAttribute("aria-selected", on);
      let off = false;
      if (k === 1) {
        const hStart = at(day, 0, i % 24), hEnd = hStart + H;
        if (min != null && hEnd <= min) off = true;
        if (max != null && hStart > max) off = true;
      }
      el.classList.toggle("off", off);
    }));
  }
  commit() {
    const [ci, hi, mi] = this.cols.map(c => Math.round(c.scrollTop / ROW));
    const di = Math.max(0, Math.min(this.days.length - 1, ci));
    let v = at(this.days[di], 0, mod(hi, 24), mod(mi, 4) * 15);
    const { min, max } = this.bounds();
    if (min != null && v < min) v = ceilQ(min) > (max ?? Infinity) ? min : ceilQ(min);
    if (max != null && v > max) v = max;
    this.o.set(v);
    const want = this.idx(v);
    if (want.some((x, k) => x !== [ci, hi, mi][k])) this.sync(v); else this.mark(v);
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

// Is er in deze vrijgave vanaf nu nog tijd over die niemand geclaimd heeft?
function hasFreeTime(w) {
  let t = Math.max(w.start, now());
  for (const c of claimsIn(w)) { if (c.from > t + MIN) return true; t = Math.max(t, c.until); }
  return t < w.end - MIN;
}

/* ---------- agenda ---------- */
// Een afspraak in je eigen agenda als herinnering: via Google Agenda of als .ics-bestand (iPhone, Outlook).
const calItems = new Map();
const calIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;
function calBtn(item, cls = "btn ghost sm") { const k = rid(); calItems.set(k, item); return `<button class="${cls}" data-action="calendar" data-k="${k}">${calIcon}Zet in agenda</button>`; }
const icsDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (t) => String(t).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
function icsFile(it) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Parkeren Jutfasehof//NL", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
    `UID:${rid()}@parkeren-jutfasehof`, `DTSTAMP:${icsDate(now())}`, `DTSTART:${icsDate(it.start)}`, `DTEND:${icsDate(it.end)}`,
    `SUMMARY:${icsText(it.title)}`, `DESCRIPTION:${icsText(it.desc + "\n" + APP_URL)}`,
    "BEGIN:VALARM", `TRIGGER:-PT${it.alarmMin ?? 15}M`, "ACTION:DISPLAY", `DESCRIPTION:${icsText(it.title)}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}
function googleCalUrl(it) {
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(it.title)}&dates=${icsDate(it.start)}/${icsDate(it.end)}&details=${encodeURIComponent(it.desc + "\n" + APP_URL)}`;
}
function calendarSheet(k) {
  const it = calItems.get(k); if (!it) return;
  openSheet("Zet in agenda", `<div class="notice"><strong>${esc(it.title)}</strong><span>${esc(range(it.start, it.end))}</span></div>
    <p class="muted small" style="margin:0">${esc(it.hint || "")} Kies de agenda die je gebruikt:</p>
    <a class="btn block" href="${esc(googleCalUrl(it))}" target="_blank" rel="noopener">Google Agenda</a>
    <button class="btn ghost block" data-action="ics" data-k="${k}">iPhone of Outlook agenda</button>
    <button class="btn ghost block" data-action="closesheet">Klaar</button>`);
}
function downloadIcs(k) {
  const it = calItems.get(k); if (!it) return;
  const url = URL.createObjectURL(new Blob([icsFile(it)], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = "parkeren-jutfasehof.ics";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
// Herinnering voor wie een plek van een buur gebruikt: een kwartier voor de eindtijd de auto wegzetten.
const calForClaim = (c) => ({ title: `Auto wegzetten van ${plekVan(c.spot)}`, start: c.until - 15 * MIN, end: c.until, desc: `Je hebt ${plekVan(c.spot)} geclaimd tot ${when(c.until)}.`, alarmMin: 0, hint: "Je krijgt een kwartier voor de eindtijd een herinnering om je auto weg te zetten." });
// Voor de eigenaar: de periode dat de plek vrijgegeven is.
const calForRelease = (spot, a, b) => ({ title: "Parkeerplek vrijgegeven", start: a, end: b, desc: `${mineLabel(spot)} is vrijgegeven in ${APP}. Tot ${when(b)} kan een buur erop staan.`, alarmMin: 30, hint: "Zo zie je in je agenda wanneer je plek vrijgegeven is." });

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
    if (mode === "show") s = mine ? { cls: "linkmine", text: "jouw plek" } : o ? { cls: "own", text: "" } : { cls: "unknown", text: "" };
    const big = spotName(p) || "?";
    svg += `<g class="spot ${s.cls}${mine && mode !== "link" ? " mine" : ""}" data-action="${mode === "link" ? "linktap" : mode === "show" ? "" : "spot"}" data-spot="${p}" tabindex="0" role="button" aria-label="${esc(spotNr(p))}: ${esc(s.cls === "free" ? "vrij " + s.text : s.text)}">
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

/* ---------- kaart ---------- */
// Standaard "nu"; tik op de balk voor de draaischijven, "Nu" zet het terug.
let momentWheels = null;
const clockSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
const calSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;
function mountMoment() {
  const host = $("#momentBar");
  host.innerHTML = `<div class="momentrow" id="momentRow">
      <button type="button" class="momentbtn" id="momentBtn" aria-expanded="false"><span class="ico"></span><span class="mtxt"></span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
      <button type="button" class="momentnow" id="momentNow" hidden aria-label="Terug naar nu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>Nu</button>
    </div>
    <div class="tfw" id="momentWheels" hidden></div>`;
  $("#momentBtn").addEventListener("click", () => {
    const box = $("#momentWheels"), open = box.hidden;
    box.hidden = !open; $("#momentBtn").setAttribute("aria-expanded", open);
    if (open) momentWheels = new Wheels(box, { get: () => st.moment ?? ceilQ(now()), set: (v) => { st.moment = v; render(); }, min: () => floorQ(now()) });
  });
  $("#momentNow").addEventListener("click", () => setMoment(null));
}
function setMoment(v) {
  st.moment = v == null || v <= now() ? null : v;
  const box = $("#momentWheels"); if (box) { box.hidden = true; $("#momentBtn").setAttribute("aria-expanded", "false"); }
  render();
}
function renderMoment() {
  const sel = st.moment;
  $("#momentRow").classList.toggle("other", sel != null);
  const b = $("#momentBtn");
  b.querySelector(".ico").outerHTML = (sel == null ? clockSvg : calSvg).replace("<svg", '<svg class="ico"');
  b.querySelector(".mtxt").innerHTML = sel == null
    ? `<span class="d">Nu</span><span class="t">${esc(clean(fDay.format(now())))} ${hm(now())} · tik voor een ander moment</span>`
    : `<span class="d">${esc(dayWord(sel))} ${hm(sel)}</span><span class="t">${esc(fLong.format(sel))}</span>`;
  b.setAttribute("aria-label", sel == null ? "Nu. Tik om een ander moment te kiezen" : `${dayWord(sel)} ${hm(sel)}. Tik om een ander moment te kiezen`);
  $("#momentNow").hidden = sel == null;
}
function renderOptions(wins) {
  const t = T();
  let free = []; const taken = [];
  for (const p of SPOTS) { const s = statusAt(p, t, wins); if (s.cls === "free") free.push([p, s]); else if (s.cls === "claimed") taken.push([p, s]); }
  $("#freeCount").textContent = free.length;
  $("#freeLabel").textContent = free.length === 1 ? "plek vrij" : "plekken vrij";
  const anyCharger = SPOTS.some(hasCharger);
  $("#chargeStat").hidden = !anyCharger || !free.length;
  $("#chargeCount").textContent = free.filter(([p]) => hasCharger(p)).length;
  const oc = $("#onlyCharger"); oc.hidden = !anyCharger; oc.setAttribute("aria-pressed", st.onlyCharger && anyCharger);
  $("#optTitle").textContent = st.moment == null ? "Nu vrij" : `Vrij ${dayWord(t)} om ${hm(t)}`;
  const hasSpot = !!(st.house && spotsOf(st.house).length);
  $("#releaseBtn").hidden = !hasSpot;
  $("#actions").classList.toggle("one", !hasSpot);
  if (st.onlyCharger && anyCharger) {
    const all = free.length; free = free.filter(([p]) => hasCharger(p));
    if (!free.length && all) { $("#options").innerHTML = `<div class="empty">Er ${all === 1 ? "is 1 plek" : `zijn ${all} plekken`} vrij, maar geen met laadpaal. <button class="btn sm ghost" data-action="onlycharger">Toon alle vrije plekken</button></div>`; return; }
  }
  let html = "";
  if (!free.length) {
    const next = wins.map(w => ({ w, s: statusAt(w.spot, Math.max(w.start, t), wins) })).find(x => x.w.start > t && x.s.cls === "free");
    html = `<div class="empty"><span>${st.moment == null ? "Op dit moment is er geen plek vrij." : "Op dat moment is er geen plek vrij."}</span>
      ${next ? `<span>Eerstvolgende: <strong>${esc(plekVan(next.w.spot))}</strong> vanaf ${esc(when(next.w.start))}. <a href="#" data-action="moment" data-v="${next.w.start}">Bekijk</a></span>` : ""}</div>`;
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
  const n = now(), urgent = [], forYou = [];
  let badge = 0;
  if (st.house) {
    for (const c of st.claims) {
      if (c.house !== st.house) continue;
      if (c.earlyReturn && c.earlyReturn > n - 2 * H) {
        const gone = !(c.until > c.from);
        const h = `<div class="notice warn"><strong>Nr ${esc(c.owner)} komt eerder terug</strong><span>${gone ? `Je claim op ${esc(plekVan(c.spot))} vervalt.` : `Zet je auto op ${esc(plekVan(c.spot))} weg voor ${esc(when(c.earlyReturn))}.`}</span>
          <div class="row" style="margin-top:6px"><button class="btn sm ghost" data-action="ack" data-id="${c.id}" data-spot="${c.spot}">Begrepen</button></div></div>`;
        urgent.push(h); forYou.push(h); badge++;
      } else if (c.until > c.from && c.from <= n && c.until > n && c.until - n <= H) {
        const h = `<div class="notice amber"><strong>Je claim op ${esc(plekVan(c.spot))} loopt bijna af</strong><span>Tot ${esc(when(c.until))}.</span>
          <div class="row" style="margin-top:6px"><button class="btn sm ghost" data-action="unclaim" data-id="${c.id}" data-spot="${c.spot}">Ik ben weg</button></div></div>`;
        urgent.push(h); forYou.push(h);
      }
    }
    for (const c of liveClaims()) {
      if (c.owner === st.house && c.from <= n && c.until > n) forYou.push(`<div class="notice"><strong>Nr ${esc(c.house)} staat op ${spotsOf(st.house).length > 1 ? `jouw plek ${esc(spotName(c.spot))}` : "jouw plek"}</strong><span>Tot ${esc(when(c.until))}. Eerder terug? Tik bij Van jou op Aanpassen.</span></div>`);
    }
    // Jouw verzoek is door een buur geregeld.
    for (const r of st.requests) {
      if (r.house !== st.house || !r.offeredSpot || r.ackOffered || !(r.until > n)) continue;
      badge++;
      forYou.unshift(`<div class="notice green"><strong>Nr ${esc(r.offeredBy)} heeft je verzoek geregeld</strong><span>Je kunt ${esc(range(Math.max(r.from, n), r.until))} op ${esc(plekVan(r.offeredSpot))} staan.</span>
        <div class="row" style="margin-top:6px">${contactsOf(r.offeredBy).map(c => waBtn(`https://wa.me/${c.phone}?text=${encodeURIComponent(`Hoi! Dank je wel dat ik ${range(r.from, r.until)} op je parkeerplek mag staan. Groet, ${STREET} ${st.house}`)}`, `Bedank ${c.name || "nr " + r.offeredBy}`)).join("")}<button class="btn sm ghost" data-action="ackoffer" data-id="${r.id}">Begrepen</button></div></div>`);
    }
  }
  // Je eigen open verzoek: er is nu een passende plek vrij.
  for (const r of st.requests) {
    if (r.house !== st.house) continue;
    const fit = reqFit(r, wins); if (!fit) continue;
    badge++;
    forYou.unshift(`<div class="notice green"><strong>Er is een plek vrij voor je verzoek</strong><span>${esc(plekVan(fit.w.spot))} is vrij ${esc(range(fit.a, r.until))}.</span><div class="row" style="margin-top:6px">${fitBtn(fit.w, fit.a, r.until, r.id)}</div></div>`);
  }
  // Verzoeken van buren. Is jouw plek dan vrij, dan direct aanbieden.
  const my = st.house ? spotsOf(st.house) : [];
  const open = st.requests.filter(r => !r.offeredSpot && r.until > n && r.house !== st.house).sort((a, b) => a.from - b.from);
  for (const r of open) {
    const p = my.find(p => freeDuring(p, Math.max(r.from, n), r.until, wins));
    const note = r.note ? `<div class="note">${esc(r.note)}</div>` : "";
    if (p) forYou.push(`<div class="notice reqcard"><div><strong>Nr ${esc(r.house)} zoekt een plek</strong><div>${esc(range(r.from, r.until))}. ${my.length > 1 ? `Jouw plek ${esc(spotName(p))}` : "Jouw plek"} is dan vrij.</div>${note}</div>
      <button class="btn green sm" data-action="offer" data-id="${r.id}" data-spot="${p}">Bied aan</button></div>`);
    else forYou.push(`<div class="notice"><strong>Nr ${esc(r.house)} zoekt een plek</strong><span>${esc(range(r.from, r.until))}</span>${note}
      ${my.length ? `<div class="row" style="margin-top:6px">${my.map(q => `<button class="btn ghost sm" data-action="offer" data-id="${r.id}" data-spot="${q}" ${canOffer(q, r) ? "" : "disabled"}>Bied ${my.length > 1 ? "plek " + esc(spotName(q)) : "je plek"} aan</button>`).join("")}</div>` : ""}</div>`);
    if (my.length) badge++;
  }
  $("#urgent").innerHTML = urgent.join("");
  $("#forYou").innerHTML = forYou.length ? forYou.join("") : `<div class="empty">Er is nu niets voor jou.</div>`;
  const bd = $("#actBadge"); bd.hidden = !badge; bd.textContent = badge;
}
function renderBanner() {
  const b = [];
  // Alleen als iemand de rondleiding heeft weggeklikt zonder plek te koppelen.
  if (st.house && st.spotsLoaded && !spotsOf(st.house).length && !st.ob) b.push(`<div class="notice green"><span>Je hebt nog geen parkeerplek gekoppeld. Dat doe je bij <a href="#instellingen" data-action="goto" data-tab="instellingen">Instellingen</a>.</span></div>`);
  if (!navigator.onLine) b.unshift(`<div class="notice warn"><strong>Geen internet</strong><span>Je ziet mogelijk niet de laatste stand. Zodra je weer verbinding hebt, werkt alles weer bij.</span></div>`);
  const m = milestone();
  if (m) b.push(`<div class="notice green"><strong>${m.n} keer gedeeld!</strong><span>Sinds de start van de buurtteller hebben buren al ${m.n} keer elkaars plek gebruikt.${m.hours >= 2 ? ` Samen zo'n ${m.hours} uur niet op straat geparkeerd.` : ""}</span>
    <div class="row" style="margin-top:6px"><button class="btn sm ghost" data-action="mileok" data-v="${m.n}">Leuk, sluiten</button></div></div>`);
  $("#banner").innerHTML = b.join("");
  $("#whoami").textContent = st.house ? `nr ${st.house}` : "";
}

/* ---------- vrijgeven (formulier, in het tabblad en in een paneel) ---------- */
function mountReleaseForm(host, opts = {}) {
  const my = st.house ? spotsOf(st.house) : [];
  if (!my.length) {
    host.innerHTML = `<div class="notice green"><span>Koppel eerst je plek bij <a href="#instellingen" data-action="goto" data-tab="instellingen">Instellingen</a>.</span></div>`;
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
function requestSheet() {
  const from = st.moment ?? ceilQ(now() + 15 * MIN);
  openSheet("Vraag om een plek", `<p class="muted small" style="margin:0">Buren zien je verzoek bij Activiteit en kunnen hun plek aanbieden.</p>
    <form id="reqForm" class="flat" novalidate>
      <div id="reqRange" class="flat"></div>
      <div id="reqFit" class="flat"></div>
      <div class="field"><label for="reqNote">Waarvoor (mag leeg)</label><input type="text" id="reqNote" maxlength="140" placeholder="Bijv. ouders komen eten"></div>
      <div class="err" id="reqErr" hidden></div>
      <button class="btn block" type="submit">Verzoek plaatsen</button>
    </form>`);
  let rr = null;
  rr = rangeField($("#reqRange"), { from, until: from + 3 * H, quick: true, durLabel: "Duur", onChange: () => rr && paintReqFit(rr.get()) });
  paintReqFit(rr.get());
  $("#reqForm").addEventListener("submit", (ev) => submitRequest(ev, rr));
}
// Terwijl je een periode kiest: is er al een plek vrij, of heb je zelf al een plek?
function paintReqFit({ from, until }) {
  const box = $("#reqFit"); if (!box) return;
  const a = Math.max(from, floorQ(now()));
  if (!(until > a)) { box.innerHTML = ""; return; }
  const fits = fitsFor(a, until, windows()).slice(0, 3);
  const mine = myClaimsIn(a, until);
  box.innerHTML = (mine.length ? `<div class="notice amber"><strong>Je hebt al een plek in deze periode</strong><span>${mine.map(c => `${esc(plekVan(c.spot))}, ${esc(range(c.from, c.until))}`).join("; ")}. Plaats alleen een verzoek als je nog een plek nodig hebt.</span></div>` : "")
    + (fits.length ? `<div class="notice green"><strong>Er is al een plek vrij in deze periode</strong><span>Dan hoef je geen verzoek te plaatsen.</span>
      ${fits.map(w => `<div class="fitrow"><span>${esc(plekVan(w.spot))}${hasCharger(w.spot) ? " · laadpaal" : ""}</span>${fitBtn(w, a, until)}</div>`).join("")}</div>` : "");
}
/* ---------- passende plekken ---------- */
// Plekken van anderen die de hele periode [a, b) vrij en ongeclaimd zijn.
function fitsFor(a, b, wins) {
  const out = [];
  for (const p of SPOTS) {
    const o = ownerOf(p); if (!o || o === st.house) continue;
    const w = freeDuring(p, a, b, wins); if (w) out.push(w);
  }
  return out;
}
function myClaimsIn(a, b) { return liveClaims().filter(c => c.house === st.house && c.from < b && c.until > a); }
function fitBtn(w, a, b, reqId) {
  return `<button class="btn green sm" data-action="claimfit" data-key="${w.key}" data-from="${a}" data-until="${b}"${reqId ? ` data-req="${reqId}"` : ""}>Claim voor deze periode</button>`;
}
// Eigen open verzoek waarvoor nu een passende plek vrij is.
function reqFit(r, wins) {
  if (r.offeredSpot || !(r.until > now())) return null;
  const a = Math.max(r.from, floorQ(now()));
  const w = fitsFor(a, r.until, wins)[0];
  return w ? { w, a } : null;
}
// Na een eigen claim: overlapt die met een eigen open verzoek? Vraag wat ermee moet.
function reqQuestionHtml(f, u, skipId) {
  const list = st.requests.filter(r => r.house === st.house && !r.offeredSpot && !r.keep && r.id !== skipId && r.until > now() && r.from < u && r.until > f);
  return list.map(r => {
    const a = Math.max(r.from, now()), full = f <= a && u >= r.until;
    const del = `<button class="btn ${full ? "" : "ghost "}sm" data-action="reqdecide" data-id="${r.id}" data-v="del">Verzoek intrekken</button>`;
    const keep = `<button class="btn ${full ? "ghost " : ""}sm" data-action="reqdecide" data-id="${r.id}" data-v="keep">Verzoek laten staan</button>`;
    return `<div class="notice reqq">${full
      ? `<strong>Je had ook een verzoek voor ${esc(range(r.from, r.until))}</strong><span>Daar heb je nu een plek voor. Trek je het in, dan zien buren het niet meer.</span>`
      : `<strong>Je hebt ook een verzoek voor ${esc(range(r.from, r.until))}</strong><span>Je claim dekt daar een deel van. Laat je het staan, dan blijft het hele verzoek open, bijvoorbeeld voor een tweede auto.</span>`}
      <div class="row" style="margin-top:6px">${full ? del + keep : keep + del}</div></div>`;
  }).join("");
}
async function reqDecide(id, v, el) {
  const box = el.closest(".reqq");
  const ok = await guard(() => v === "del" ? deleteDoc(doc(fs, "requests", id)) : updateDoc(doc(fs, "requests", id), { keep: true }));
  if (ok && box) box.innerHTML = `<span>${v === "del" ? "Je verzoek is ingetrokken." : "Je verzoek blijft staan."}</span>`;
}
/* ---------- buurtteller ---------- */
const monthKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
// Tellers per maand en in totaal; namen worden niet bewaard, alleen huisnummers voor je eigen bijdrage.
function bumpStats({ r = 0, c = 0, min = 0, house = st.house }) {
  if (!house) return;
  const t = now(), mins = Math.max(0, Math.round(min));
  const m = { houses: { [house]: true }, byHouse: { [house]: {} }, updatedAt: t }, tot = { updatedAt: t };
  if (r) { m.releases = increment(r); m.byHouse[house].r = increment(r); tot.releases = increment(r); }
  if (c) { m.claims = increment(c); m.byHouse[house].c = increment(c); m.days = { [String(new Date(t).getDate())]: increment(c) }; tot.claims = increment(c); }
  if (mins) { m.minutes = increment(mins); tot.minutes = increment(mins); }
  setDoc(doc(fs, "stats", monthKey(t)), m, { merge: true }).catch(e => console.warn("stats", e));
  setDoc(doc(fs, "stats", "total"), tot, { merge: true }).catch(e => console.warn("stats", e));
}
function isoWeek(t) {
  const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / D - 3 + ((w1.getDay() + 6) % 7)) / 7);
}
const MILESTONES = [25, 50, 100, 250, 500, 1000];
// Een mijlpaal is twee weken te zien; wie later lid wordt, krijgt geen oude mijlpalen.
function milestone() {
  if (!st.member || !st.stats.total) return null;
  const tot = st.stats.total, n = MILESTONES.filter(x => (tot.claims || 0) >= x).pop();
  if (!n || (st.member.mile || 0) >= n) return null;
  const at = (tot.miles || {})[n];
  if (!at) {
    if (!milestone.saving) { milestone.saving = true; setDoc(doc(fs, "stats", "total"), { miles: { [n]: now() } }, { merge: true }).catch(e => console.warn(e)).finally(() => { milestone.saving = false; }); }
    return null;
  }
  if (now() - at > 14 * D) return null;
  return { n, hours: Math.round((tot.minutes || 0) / 60) };
}
function renderBuurt() {
  const t = now(), m = st.stats[monthKey(t)] || {}, cl = m.claims || 0;
  const a = $("#buurtA");
  a.hidden = !cl;
  a.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg><span>Deze maand <strong>${cl} keer</strong> een plek gedeeld in de buurt</span>`;
  // Balkjes per week van deze maand.
  const d0 = new Date(t), y = d0.getFullYear(), mo = d0.getMonth(), last = new Date(y, mo + 1, 0).getDate();
  const weeks = [];
  for (let d = 1; d <= last; d++) {
    const wk = isoWeek(new Date(y, mo, d).getTime());
    let e = weeks.find(x => x.wk === wk); if (!e) weeks.push(e = { wk, n: 0, now: false });
    e.n += (m.days || {})[String(d)] || 0;
    if (d === d0.getDate()) e.now = true;
  }
  const max = Math.max(1, ...weeks.map(x => x.n));
  const mine = (m.byHouse || {})[st.house] || {};
  const tile = (v, l, cls = "") => `<div class="btile"><b class="${cls}">${v}</b><span>${l}</span></div>`;
  $("#buurtB").innerHTML = `<h2>Buurt deze maand</h2>
    <div class="btiles">${tile(m.releases || 0, "keer vrijgegeven")}${tile(cl, "keer geclaimd", "free")}${tile(Math.round((m.minutes || 0) / 60), "uur gedeeld")}${tile(Object.keys(m.houses || {}).length, "adressen deden mee")}</div>
    <div class="bweeks" aria-label="Claims per week">${weeks.map(x => `<div class="bw"><i class="${x.now ? "now" : ""}" style="height:${Math.round(4 + 30 * x.n / max)}px"></i><span>wk ${x.wk}</span></div>`).join("")}</div>
    <p class="muted small" style="margin:0">${mine.r || mine.c ? `Nr ${esc(st.house)} gaf deze maand ${mine.r || 0} keer vrij en claimde ${mine.c || 0} keer. Dank je!` : "Geef je plek vrij als je weg bent, dan telt die hier mee."}</p>`;
}
function otherRequestsHtml(wins) {
  const n = now();
  const list = st.requests.filter(r => r.until > n && !r.offeredSpot && r.house !== st.house).sort((a, b) => a.from - b.from);
  if (!list.length) return `<div class="empty">Er staan geen verzoeken open.</div>`;
  const my = st.house ? spotsOf(st.house) : [];
  return `<div class="list">${list.map(r => {
    const act = my.length ? `<div class="row">${my.map(p => `<button class="btn green sm" data-action="offer" data-id="${r.id}" data-spot="${p}" ${canOffer(p, r) ? "" : "disabled"}>Bied ${my.length > 1 ? esc(spotName(p)) : "je plek"} aan</button>`).join("")}</div>` : "";
    return `<div class="card"><div class="head"><span class="pid">nr ${esc(r.house)}</span><span class="muted">zoekt een plek</span></div>
      <div class="when">${esc(range(r.from, r.until))}</div>${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}${act}</div>`;
  }).join("")}</div>`;
}
function requestsListSheet() { openSheet("Buren zoeken een plek", otherRequestsHtml(windows())); }
function myRequestsHtml(wins) {
  const n = now();
  const list = st.requests.filter(r => r.house === st.house && r.until > n).sort((a, b) => a.from - b.from);
  if (!list.length) return "";
  return list.map(r => { const fit = reqFit(r, wins); return `<div class="card ${r.offeredSpot ? "is-free" : ""}"><div class="big">${r.offeredSpot ? (r.selfClaim ? "Geregeld" : `Geregeld door nr ${esc(r.offeredBy)}`) : "Nog niet geregeld"}</div>
    <div class="when">${esc(range(r.from, r.until))}</div>${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}
    ${fit ? `<div class="notice green"><strong>Er is nu een plek vrij voor je verzoek</strong><span>${esc(plekVan(fit.w.spot))}</span><div class="row" style="margin-top:6px">${fitBtn(fit.w, fit.a, r.until, r.id)}</div></div>` : ""}
    <div class="row">${r.offeredSpot ? "" : `<a class="btn wa sm" href="${esc(waShare(`Hoi buren! Heeft iemand ${range(r.from, r.until)} een parkeerplek vrij? ${r.note ? "(" + r.note + ") " : ""}Aanbieden kan in ${APP}: ${APP_URL}`))}" target="_blank" rel="noopener">${waIcon}Deel in buurtgroep</a>`}
    <button class="btn ghost sm" data-action="delreq" data-id="${r.id}">Intrekken</button></div></div>`; }).join("");
}
// Aanbieden kan als de plek in die periode niet door een ander geclaimd is.
function canOffer(p, r) {
  return !liveClaims().some(c => c.spot === p && c.from < r.until && c.until > r.from);
}

/* ---------- mijn ---------- */
function renderMine(wins) {
  $("#valHouse").textContent = st.house ? `${STREET} ${st.house}` : "onbekend";
  $("#accountLine").textContent = st.user ? `Ingelogd als ${st.user.email}` : "";
  const my = st.house ? spotsOf(st.house) : [];
  $("#valSpot").textContent = !st.house ? "" : my.length ? (my.length > 1 ? `${my.length} plekken` : "gekoppeld") : "nog niet gekoppeld";
  if (st.house && st.spotsLoaded && !my.length && !renderMine.openedSpot) { $("#setSpot").open = true; renderMine.openedSpot = true; }
  $("#valCharger").textContent = !my.length ? "" : my.some(hasCharger) ? "ja" : "nee";
  $("#setCharger").hidden = !my.length;
  const rec = st.house ? (st.phones[st.house] || {}) : {}, me = (rec.contacts || {})[st.user?.uid];
  $("#valPhone").textContent = me ? `${me.name} · ${me.phone}` : "niet ingevuld";
  $("#phonePanel").hidden = !st.house;
  if (!st.house) {
    $("#spotSetup").innerHTML = "";
    $("#mine").innerHTML = `<div class="empty">Je adres is onbekend. Vraag de beheerder om hulp.</div>`;
    return;
  }
  if (!document.activeElement?.matches?.("#phone,#cname")) { $("#phone").value = me?.phone || ""; $("#cname").value = me?.name || ""; }
  $("#delPhone").hidden = !me;
  const others = contactsOf(st.house).filter(c => c.uid !== st.user.uid);
  const legacy = others.find(c => !c.uid);
  $("#setMates").hidden = !others.length;
  $("#labMates").textContent = `Ook op nr ${st.house}`;
  $("#valMates").textContent = others.map(c => c.name || "nummer zonder naam").join(", ");
  $("#housemates").innerHTML = ""
    + (legacy && !me ? `<div class="notice"><span>Is ${esc(rec.phone)} jouw nummer? Vul je voornaam in en tik op Opslaan, dan staat het er met je naam.</span><div class="row" style="margin-top:6px"><button class="btn sm ghost" data-action="uselegacy">Ja, dit is mijn nummer</button></div></div>` : "")
    + (legacy && me ? `<div class="row"><button class="btn ghost sm" data-action="dellegacy">Nummer zonder naam verwijderen</button></div>` : "");
  if (!$("#linkMap")) $("#spotSetup").innerHTML = `<p class="muted small" style="margin:0">Tik op de kaart op je eigen plek. Nog een keer tikken maakt hem weer los.</p><div class="mapbox" id="linkMap"></div>`;
  renderMap(wins, "#linkMap", "link");
  $("#chargerToggles").innerHTML = my.map(p => `<label class="toggle" for="ch_${p}"><span><strong>${esc(mineLabel(p))}</strong> heeft een openbare laadpaal die buren mogen gebruiken</span><input type="checkbox" id="ch_${p}" data-action="togglecharger" data-spot="${p}" ${hasCharger(p) ? "checked" : ""}></label>`).join("");

  const n = now();
  // Eenmalige vrijgaven allemaal; van de wekelijkse alleen de eerstvolgende dagen of als iemand geclaimd heeft.
  const mineW = wins.filter(w => w.house === st.house && w.end > n && (w.src === "once" || w.start < n + 2 * D || claimsIn(w).length)).slice(0, 8);
  const myClaims = liveClaims().filter(c => c.house === st.house && c.until > n).sort((a, b) => a.from - b.from);
  const recs = st.recurring.filter(r => r.house === st.house);
  const myReqs = st.requests.filter(r => r.house === st.house && r.until > n);
  if (!mineW.length && !recs.length && !myClaims.length && !myReqs.length) {
    $("#mine").innerHTML = `<div class="empty">Er loopt nu niets: geen vrijgave, claims of verzoeken.</div>`;
    return;
  }
  let html = "";
  if (mineW.length) html += `<div class="dayhead">${my.length > 1 ? "Jouw plekken" : "Jouw plek"}</div>` + mineW.map(w => {
    const cs = claimsIn(w);
    return `<div class="card ${cs.length ? "is-claimed" : "is-free"}">
      <div class="big">${w.start > n ? `Vrij ${esc(range(w.start, w.end))}` : `Vrij tot ${esc(when(w.end))}`}</div>
      <div class="row" style="gap:6px">${my.length > 1 ? `<span class="pill neutral">${esc(mineLabel(w.spot))}</span>` : ""}${w.src === "rec" ? `<span class="pill neutral">wekelijks</span>` : ""}
      ${cs.map(c => `<span class="pill claimed">nr ${esc(c.house)} · ${esc(range(c.from, c.until))}</span>`).join("")}${cs.length ? "" : `<span class="pill free">nog niet geclaimd</span>`}</div>
      <div class="row"><button class="btn ghost sm" data-action="earlysheet" data-key="${w.key}">Aanpassen</button>${calBtn(calForRelease(w.spot, w.start, w.end))}</div></div>`;
  }).join("");
  if (recs.length) {
    html += `<div class="dayhead">Wekelijks</div>` + recs.map(r => `<div class="card"><div class="head"><span class="pid">${esc(mineLabel(r.spot))}</span><span class="pill neutral">wekelijks</span></div>
      <div class="when">${DAYS.filter(([d]) => (r.days || []).includes(d)).map(([, l]) => l).join(" ")} · ${esc(r.fromTime)} tot ${esc(r.untilTime)}</div>
      <div class="row"><button class="btn ghost sm" data-action="recsheet" data-id="${r.id}">Aanpassen</button><button class="btn danger sm" data-action="stoprec" data-ref="${r.id}">Stop herhaling</button></div></div>`).join("");
  }
  if (myClaims.length) html += `<div class="dayhead">${myClaims.length > 1 ? "Jouw claims" : "Jouw claim"}</div>` + myClaims.map(c => `<div class="card is-claimed"><div class="big">Plek van ${esc(spotNr(c.spot))}</div>
    <div class="when">${esc(range(c.from, c.until))}</div>
    <div class="row"><button class="btn ghost sm" data-action="unclaim" data-id="${c.id}" data-spot="${c.spot}">${c.from <= n ? "Ik ben weg" : "Intrekken"}</button>${extendInfo(c, wins) ? `<button class="btn ghost sm" data-action="extendsheet" data-id="${c.id}" data-spot="${c.spot}">Verlengen</button>` : ""}${calBtn(calForClaim(c))}${waBtns(c.owner, `Hoi! Ik (${STREET} ${st.house}) sta ${range(c.from, c.until)} op jouw parkeerplek. Groet!`)}</div></div>`).join("");
  if (myReqs.length) html += `<div class="dayhead">${myReqs.length > 1 ? "Jouw verzoeken" : "Jouw verzoek"}</div>` + myRequestsHtml(wins);
  $("#mine").innerHTML = html;
}

function render() {
  if (!st.member) return;
  const wins = windows();
  renderBanner(); renderNotices(wins); renderMoment(); renderMap(wins); renderOptions(wins);
  renderMine(wins); renderBuurt();
  $("#accountId").textContent = st.user ? st.user.uid : "";
  if (st.ob && ["spot", "housemate"].includes(st.ob.steps[st.ob.i])) renderOnboard(); else maybeOnboard();
  renderAdmin();
}

/* ---------- rondleiding ---------- */
// Eerste bewoner van een adres: plek koppelen (verplicht), laadpaal, WhatsApp (optioneel).
// Huisgenoot van een gekoppeld adres: welkom met de plek op de kaart, WhatsApp (optioneel).
// Bestaand lid zonder nummer: alleen één keer de WhatsApp-uitleg.
const TWO_SPOTS = { "27": 2 };
function myContact() { return ((st.phones[st.house] || {}).contacts || {})[st.user.uid]; }
function maybeOnboard() {
  if (!st.member || st.ob || !st.house || !st.spotsLoaded || !st.phonesLoaded) return;
  const hasSpot = spotsOf(st.house).length > 0;
  const needWa = !st.member.waAsked && !myContact();
  let steps;
  // Wie al langer lid is (van voor de rondleiding) en een plek heeft, krijgt geen welkom als huisgenoot.
  const fresh = (st.member.createdAt || 0) > now() - 2 * D;
  if (!st.member.onboarded) steps = !hasSpot ? ["spot", "charger", "wa"] : fresh ? ["housemate", "wa"] : ["wa"];
  else if (needWa) steps = ["wa"];
  else return;
  if (!needWa) steps = steps.filter(x => x !== "wa");
  if (!steps.length) { saveMember({ onboarded: true }); return; }
  st.ob = { steps, i: 0 };
  renderOnboard();
}
async function saveMember(fields) {
  Object.assign(st.member, fields);
  try { await updateDoc(doc(fs, "members", st.user.uid), fields); } catch (e) { console.warn(e); }
}
function renderOnboard() {
  const ob = st.ob; if (!ob) return;
  const step = ob.steps[ob.i], my = spotsOf(st.house);
  const dots = ob.steps.length > 1 ? `<div class="obsteps" aria-label="Stap ${ob.i + 1} van ${ob.steps.length}">${ob.steps.map((_, i) => `<i class="${i <= ob.i ? "on" : ""}"></i>`).join("")}</div>` : "";
  const title = step === "wa" && ob.steps.length === 1 ? "Bereikbaar via WhatsApp?" : "Welkom bij Parkeren Jutfasehof";
  let body = "";
  if (step === "spot") {
    const need = TWO_SPOTS[st.house] || 1;
    body = `${dots}<p style="margin:0">Tik op de kaart op je eigen parkeerplek.${need > 1 ? ` Je woning heeft ${need} plekken: tik ze allebei aan.` : ""}</p>
      <div class="mapbox" id="obMap"></div>
      <button class="btn block" data-action="obnext" ${my.length ? "" : "disabled"}>${my.length ? "Volgende" : "Tik eerst je plek aan"}</button>`;
  } else if (step === "housemate") {
    body = `${dots}<p style="margin:0">Welkom! ${my.length > 1 ? "De plekken" : "De plek"} van nr ${esc(st.house)} ${my.length > 1 ? "zijn" : "is"} al gekoppeld door een huisgenoot. Op de kaart zie je welke.</p>
      <div class="mapbox" id="obMap"></div>
      <button class="btn block" data-action="obnext">Volgende</button>`;
  } else if (step === "charger") {
    body = `${dots}<p style="margin:0">Heeft je plek een <strong>openbare laadpaal</strong> die buren mogen gebruiken?</p>
      <div class="row"><button class="btn" data-action="obcharger" data-v="1">Ja</button><button class="btn ghost" data-action="obcharger" data-v="0">Nee</button></div>`;
  } else {
    body = `${dots}<p style="margin:0"><strong>Wil je bereikbaar zijn via WhatsApp?</strong></p>
      <p class="muted" style="margin:0">Buren kunnen je dan met één tik een bericht sturen, bijvoorbeeld als ze je plek gebruiken of als jij eerder terugkomt. Alleen bewoners in deze app zien je naam en nummer. Woon je met meer mensen, dan vult ieder zijn eigen nummer in. Je kunt het later altijd aanpassen bij Instellingen.</p>
      <div class="two">
        <div class="field"><label for="obName">Voornaam</label><input type="text" id="obName" maxlength="30" autocomplete="given-name"></div>
        <div class="field"><label for="obPhone">Mobiel nummer</label><input type="tel" id="obPhone" inputmode="tel" autocomplete="tel" placeholder="06 12345678"></div>
      </div>
      <div class="err" id="obErr" hidden></div>
      <div class="row"><button class="btn" data-action="obphone">Opslaan</button><button class="btn ghost" data-action="obskipwa">Liever niet</button></div>`;
  }
  if (!st.sheet || !$("#sheetRoot .obsheet")) { openSheet(title, body); $("#sheetRoot .sheet").classList.add("obsheet"); } else sheetBody(body);
  if (step === "spot") renderMap(windows(), "#obMap", "link");
  if (step === "housemate") renderMap(windows(), "#obMap", "show");
}
function obNext() {
  const ob = st.ob; if (!ob) return;
  if (ob.steps[ob.i] === "spot" && !spotsOf(st.house).length) return;
  ob.i++;
  if (ob.i >= ob.steps.length) return obFinish();
  renderOnboard();
}
async function obCharger(on) {
  for (const p of spotsOf(st.house)) await setCharger(p, on, true);
  obNext();
}
async function obPhone() {
  const err = $("#obErr"), name = $("#obName").value.trim().slice(0, 30), v = $("#obPhone").value.trim();
  if (!name) return showErr(err, "Vul je voornaam in, of tik op Liever niet.");
  if (!normPhone(v)) return showErr(err, "Dit lijkt geen geldig mobiel nummer. Bijvoorbeeld: 06 12345678.");
  if (await guard(() => setDoc(doc(fs, "houses", st.house), { contacts: { [st.user.uid]: { name, phone: v, updatedAt: now() } }, updatedAt: now() }, { merge: true }))) { st.ob.waDone = true; obNext(); }
}
function obSkipWa() { st.ob.waDone = true; obNext(); }
// Afronden; ook bij wegklikken. De plek-stap telt alleen als er echt een plek gekoppeld is.
function obFinish() {
  const ob = st.ob; if (!ob) return;
  st.ob = null;
  const fields = {};
  if (spotsOf(st.house).length) fields.onboarded = true;
  if (ob.waDone || ob.steps.includes("wa") && ob.i >= ob.steps.indexOf("wa")) fields.waAsked = true;
  if (Object.keys(fields).length) saveMember(fields);
  closeSheet();
  if (fields.onboarded && ob.i >= ob.steps.length) toast("Klaar! Je kunt nu je plek vrijgeven of om een plek vragen.");
}

/* ---------- beheer (alleen voor beheerders) ---------- */
// Wie in Firestore onder private/admins staat, mag alle leden zien. Dat proberen we stil; lukt het niet, dan geen beheer.
async function checkAdmin() {
  try { const snap = await getDocs(collection(fs, "members")); st.isAdmin = true; st.membersList = snap.docs.map(d => ({ id: d.id, ...d.data() })); }
  catch { st.isAdmin = false; st.membersList = []; }
  $("#adminPanel").hidden = !st.isAdmin;
  if (st.isAdmin) $("#valMembers").textContent = st.membersList.length;
  if (st.isAdmin) { renderAdmin(); autoCleanup(); }
}
function renderAdmin() {
  if (!st.isAdmin) return;
  const ms = (st.membersList || []).slice().sort((a, b) => (a.house || "").localeCompare(b.house || "", "nl", { numeric: true }));
  $("#adminMembers").innerHTML = ms.length ? ms.map(m => `<div class="adminrow"><span><select class="housesel" data-action="adminhouse" data-id="${m.id}" aria-label="Adres van ${esc(m.email || "lid")}">${HOUSES.map(h => `<option value="${h}" ${h === m.house ? "selected" : ""}>nr ${h}</option>`).join("")}</select> ${esc(m.email || "")}</span>
      ${m.id === st.user.uid ? `<span class="pill neutral">jij</span>` : `<button class="btn danger sm" data-action="admindel" data-id="${m.id}">Toegang intrekken</button>`}</div>`).join("") : `<div class="empty">Nog geen leden.</div>`;
  const linked = SPOTS.filter(p => ownerOf(p));
  $("#adminSpots").innerHTML = linked.length ? linked.map(p => `<div class="adminrow"><span>Plek ${esc(spotName(p))}${hasCharger(p) ? " · laadpaal" : ""}</span>
      <button class="btn ghost sm" data-action="adminunlink" data-spot="${p}">Loskoppelen</button></div>`).join("") : `<div class="empty">Nog geen plekken gekoppeld.</div>`;
}
const armed = new Set();
function confirmTap(key, el, label) {
  if (armed.has(key)) { armed.delete(key); return true; }
  armed.add(key); el.textContent = label; setTimeout(() => armed.delete(key), 4000);
  return false;
}
async function adminDelete(id, el) {
  if (!confirmTap("del" + id, el, "Tik nog eens om te bevestigen")) return;
  if (await guard(() => deleteDoc(doc(fs, "members", id)))) { toast("Toegang ingetrokken."); checkAdmin(); }
}
async function adminHouse(id, h) {
  if (!HOUSES.includes(h)) return;
  if (await guard(() => updateDoc(doc(fs, "members", id), { house: h }))) {
    toast(`Adres aangepast naar ${STREET} ${h}.`);
    if (id === st.user.uid) { st.house = h; render(); }
    checkAdmin();
  }
}
async function adminUnlink(p, el) {
  if (!confirmTap("unl" + p, el, "Tik nog eens")) return;
  if (await guard(() => setDoc(doc(fs, "spots", p), { house: null, charger: false, updatedAt: now() }))) toast("Plek losgekoppeld.");
}
async function backup() {
  const names = ["members", "spots", "houses", "releases", "recurring", "claims", "requests"];
  const out = { app: APP, exportedAt: new Date().toISOString(), collections: {} };
  const ok = await guard(async () => {
    for (const n of names) { const snap = await getDocs(collection(fs, n)); out.collections[n] = Object.fromEntries(snap.docs.map(d => [d.id, d.data()])); }
  });
  if (!ok) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `parkeren-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast("Back-up gedownload.");
}
// Ruimt vrijgaven, verzoeken en claims op die langer dan KEEP_DAYS dagen voorbij zijn.
async function cleanup(silent) {
  const cut = now() - KEEP_DAYS * D;
  let n = 0;
  const ok = await guard(async () => {
    for (const col of ["releases", "requests"]) {
      const snap = await getDocs(query(collection(fs, col), where("until", "<", cut)));
      for (const d of snap.docs) { await deleteDoc(d.ref); n++; }
    }
    const cs = await getDocs(collection(fs, "claims"));
    for (const d of cs.docs) {
      const old = (d.data().items || []).filter(c => (c.until || 0) < cut && !(c.earlyReturn > cut)).length;
      if (old) { await mutateClaims(d.id, () => {}); n += old; }
    }
  });
  try { localStorage.setItem("pz_cleanup", String(now())); } catch {}
  if (ok && !silent) toast(n ? `${n} oude ${n === 1 ? "item" : "items"} opgeruimd.` : "Er was niets op te ruimen.");
}
function autoCleanup() {
  let last = 0; try { last = Number(localStorage.getItem("pz_cleanup")) || 0; } catch {}
  if (now() - last > 7 * D) cleanup(true);
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
function closeSheet() {
  if (st.ob) { obFinish(); return; }
  st.sheet = null; $("#sheetRoot").innerHTML = ""; document.body.style.overflow = "";
}

function spotSheet(p) {
  const wins = windows(), t = T(), s = statusAt(p, t, wins), own = ownerOf(p);
  const up = wins.filter(w => w.spot === p && w.end > now()).slice(0, 6);
  const head = s.cls === "free" ? `<span class="pill free">vrij tot ${esc(when(s.freeUntil))}</span>` : s.cls === "claimed" ? `<span class="pill claimed">bezet door nr ${esc(s.c.house)} tot ${esc(when(s.c.until))}</span>` : s.cls === "own" ? `<span class="pill neutral">eigenaar gebruikt hem</span>` : `<span class="pill neutral">nog niet gekoppeld</span>`;
  const mine = st.house && own === st.house;
  openSheet(own ? `Plek van nr ${spotName(p)}` : "Plek zonder adres", `<div class="row"><span class="muted">${own ? `${STREET} ${esc(own)}` : "Nog niet aan een woning gekoppeld"}</span>${head}${hasCharger(p) ? boltPill : ""}</div>
    ${!own && st.house ? `<button class="btn block" data-action="linkspot" data-spot="${p}">Dit is mijn plek</button>` : ""}
    ${mine ? `<button class="btn block" data-action="releasesheet" data-spot="${p}">${clockIcon}Plek vrijgeven</button>` : ""}
    <div class="dayhead">Wanneer vrij</div>
    ${up.length ? `<div class="list">${up.map(w => { const cs = claimsIn(w);
      return `<div class="card ${cs.length ? "is-claimed" : "is-free"}"><div class="when">${esc(range(w.start, w.end))}</div>
      ${cs.map(c => `<span class="pill claimed">nr ${esc(c.house)} ${esc(range(c.from, c.until))}</span>`).join(" ")}
      ${w.note ? `<div class="note">${esc(w.note)}</div>` : ""}
      ${mine ? `<button class="btn ghost sm" data-action="earlysheet" data-key="${w.key}">Aanpassen</button>` : ""}
      ${!mine && st.house && hasFreeTime(w) ? `<button class="btn green sm" data-action="claimsheet" data-key="${w.key}">Claim</button>` : ""}</div>`; }).join("")}</div>`
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
// Eén paneel om je vrijgave aan te passen: eindtijd korter of langer, of stoppen.
function earlySheet(key) {
  const w = windows().find(x => x.key === key); if (!w) return;
  const future = w.start > now();
  const cs = claimsIn(w);
  earlyVal = w.end;
  openSheet(`${mineLabel(w.spot)}: vrijgave aanpassen`, `
    <div class="when">Vrijgegeven ${esc(range(w.start, w.end))}</div>
    ${cs.length ? `<div class="notice amber"><span>Geclaimd door ${cs.map(c => `nr ${esc(c.house)} (${esc(range(c.from, c.until))})`).join(", ")}. Zij zien je wijziging bovenaan in de app.</span></div>` : ""}
    <div id="earlyTF"></div>
    ${w.src === "once" ? `<p class="muted small" style="margin:0">Je kunt de eindtijd eerder of later zetten.</p>` : `<p class="muted small" style="margin:0">Dit geldt alleen voor deze keer. De wekelijkse herhaling stop je bij Activiteit, onder Van jou.</p>`}
    <div class="err" id="eErr" hidden></div>
    <button class="btn block" data-action="early" data-key="${key}">Opslaan</button>
    <button class="btn danger block" data-action="cancelwin" data-key="${key}">${future ? "Toch niet vrijgeven" : "Stoppen, ik ben er nu"}</button>`);
  const maxEnd = w.src === "once" ? w.start + 31 * D : w.end;
  earlyTF = timeField($("#earlyTF"), { label: "Vrij tot", get: () => earlyVal, set: (v) => { earlyVal = v; }, min: () => Math.max(w.start, floorQ(now())), max: () => maxEnd });
  $("#earlyTF .tfbtn").click();
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
async function linkSpot(p) {
  const o = ownerOf(p);
  await guard(async () => {
    if (o === st.house) await setDoc(doc(fs, "spots", p), { house: null, charger: false, updatedAt: now() });
    else if (!o) await setDoc(doc(fs, "spots", p), { house: st.house, charger: hasCharger(p), updatedAt: now() });
  });
}
async function setCharger(p, on, quiet) {
  if (ownerOf(p) !== st.house) return;
  if (await guard(() => setDoc(doc(fs, "spots", p), { house: st.house, charger: !!on, updatedAt: now() })) && !quiet)
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
  if (o === st.house && st.ob) { linkSpot(p); return; } // tijdens de rondleiding gewoon loskoppelen, zonder extra paneel
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
    if (ok) { bumpStats({ r: spots.length }); afterRelease(`${spots.map(mineLabel).join(" en ")} is ${res.merged ? "nu " : ""}vrij ${range(res.f, res.u)}`, res.merged, calForRelease(spots[0], res.f, res.u), spots, { f: res.f, u: res.u }); }
  } else {
    if (!days.length) return fail("Kies minstens één dag.");
    if (!ft || !ut || ft === ut) return fail("Vul een begin- en eindtijd in die verschillen.");
    const ok = await guard(async () => { for (const p of spots) await addDoc(collection(fs, "recurring"), { spot: p, house: st.house, days, fromTime: ft, untilTime: ut, note, since: sod(now()), overrides: {}, createdAt: now() }); });
    const dd = `elke ${DAYS.filter(([d]) => days.includes(d)).map(([, l]) => l).join(", ")} vrij van ${ft} tot ${ut}`;
    if (ok) { bumpStats({ r: spots.length }); afterRelease(`${spots.map(mineLabel).join(" en ")} is ${dd}`, false, null, spots, null); }
  }
}
function afterRelease(txt, merged, cal, spots, span) {
  setTab("kaart");
  openSheet("Vrijgegeven", `<div class="notice green"><span>${esc(txt)}.${merged ? " Samengevoegd met je eerdere vrijgave." : ""}</span></div>
    ${helpHtml(spots || [], span)}
    ${cal ? calBtn(cal, "btn ghost block") : ""}
    <button class="btn ghost block" data-action="closesheet">Klaar</button>`);
  render();
}
// Zoekt een buur in de zojuist vrijgegeven periode een plek? Dan kun je hem die direct geven.
function helpHtml(spots, span) {
  const n = now(), wins = windows(), out = [];
  for (const r of st.requests) {
    if (r.house === st.house || r.offeredSpot || !(r.until > n)) continue;
    const a = Math.max(r.from, floorQ(n));
    const p = spots.find(p => freeDuring(p, a, r.until, wins)
      || (span && a >= span.f && r.until <= span.u && !liveClaims().some(c => c.spot === p && c.from < r.until && c.until > a)));
    if (p) out.push(`<div class="notice reqcard"><div><strong>Nr ${esc(r.house)} zoekt een plek</strong><div>${esc(range(r.from, r.until))}${r.note ? ` · ${esc(r.note)}` : ""}</div></div>
      <button class="btn green sm" data-action="offer" data-id="${r.id}" data-spot="${p}">Geef aan nr ${esc(r.house)}</button></div>`);
  }
  return out.length ? `<div class="dayhead">Buren zoeken in deze periode een plek</div>${out.join("")}` : "";
}
// Eén claim opslaan; twee buren kunnen nooit tegelijk dezelfde tijd claimen.
async function doClaim(w, f, u) {
  await mutateClaims(w.spot, (items) => {
    const clash = items.find(c => c.house && c.until > c.from && c.from < u && c.until > f);
    if (clash) throw new UserError(`Nr ${clash.house} heeft deze plek al ${range(clash.from, clash.until)}. Kies een andere tijd.`);
    items.push({ id: rid(), owner: w.house, windowStart: w.start, windowEnd: w.end, house: st.house, from: f, until: u, earlyReturn: null, createdAt: now() });
  });
  bumpStats({ c: 1, min: (u - f) / MIN });
}
function claimDoneHtml(w, f, u, reqId) {
  const msg = `Hoi! Ik (${STREET} ${st.house}) heb jouw parkeerplek geclaimd, ${range(f, u)}. Dank je wel!`;
  const btns = waBtns(w.house, msg);
  return `<div class="notice green"><strong>De plek van nr ${esc(spotName(w.spot) || w.house)} is voor jou</strong><span>${esc(range(f, u))}.</span></div>
    ${reqQuestionHtml(f, u, reqId)}
    ${calBtn(calForClaim({ spot: w.spot, until: u }), "btn ghost block")}
    ${btns ? `<p class="muted" style="margin:0">Laat nr ${esc(w.house)} het weten:</p>${btns}` : `<p class="muted" style="margin:0">Nr ${esc(w.house)} heeft geen WhatsApp-nummer ingevuld, maar ziet je claim in de app.</p>`}
    <button class="btn ghost block" data-action="closesheet">Klaar</button>`;
}
// "Claim voor deze periode": in één keer precies de gevraagde tijd claimen.
async function claimFit(key, a, b, reqId) {
  const w = windows().find(x => x.key === key);
  const f = Math.max(a, floorQ(now()));
  if (!w || !(b > f)) { toast("Deze plek is niet meer vrij."); render(); return; }
  try { await doClaim(w, f, b); }
  catch (e) { console.warn(e); toast(e instanceof UserError ? e.message : "Claimen lukte niet. Controleer je verbinding en probeer het opnieuw."); return; }
  if (reqId) await guard(() => updateDoc(doc(fs, "requests", reqId), { offeredBy: w.house, offeredSpot: w.spot, ackOffered: true, selfClaim: true }));
  openSheet("Geclaimd", claimDoneHtml(w, f, b, reqId));
}
async function claim(key) {
  const w = windows().find(x => x.key === key); if (!w || !claimRange) return;
  const err = $("#cErr"); const fail = (m) => showErr(err, m);
  const { from, until } = claimRange.get();
  if (until <= from) return fail("De eindtijd moet na de begintijd liggen.");
  if (from < w.start - MIN || until > w.end + MIN) return fail(`Kies een tijd binnen ${range(w.start, w.end)}.`);
  if (until <= now()) return fail("Deze tijd ligt al in het verleden.");
  const f = Math.max(from, w.start), u = Math.min(until, w.end);
  try { await doClaim(w, f, u); }
  catch (e) { console.warn(e); return fail(e instanceof UserError ? e.message : "Claimen lukte niet. Controleer je verbinding en probeer het opnieuw."); }
  sheetBody(claimDoneHtml(w, f, u, null));
}
// Claim verlengen kan als de plek na je eindtijd nog vrij is binnen dezelfde vrijgave.
function extendInfo(c, wins = windows()) {
  if (c.earlyReturn || c.house !== st.house || !(c.until > now())) return null;
  const w = wins.find(w => w.spot === c.spot && w.start <= c.until && w.end > c.until); if (!w) return null;
  const next = liveClaims().filter(x => x.spot === c.spot && x.id !== c.id && x.from >= c.until).sort((a, b) => a.from - b.from)[0];
  const max = Math.min(w.end, next ? next.from : Infinity);
  return max - c.until >= Q ? { w, max } : null;
}
let extendVal = 0;
function extendSheet(id, spot) {
  const c = liveClaims().find(x => x.id === id && x.spot === spot); if (!c) return;
  const info = extendInfo(c); if (!info) { toast("Verlengen kan nu niet: de plek is daarna niet vrij."); return; }
  extendVal = Math.min(info.max, c.until + H);
  openSheet("Claim verlengen", `<div class="when">${esc(plekVan(spot))}: nu ${esc(range(c.from, c.until))}</div>
    <div id="extTF"></div>
    <p class="muted small" style="margin:0">Je kunt verlengen tot uiterlijk ${esc(when(info.max))}.</p>
    <div class="err" id="xErr" hidden></div>
    <button class="btn green block" data-action="extend" data-id="${id}" data-spot="${spot}">Verlengen</button>`);
  timeField($("#extTF"), { label: "Nieuwe eindtijd", get: () => extendVal, set: (v) => { extendVal = v; }, min: () => c.until + Q, max: () => info.max });
  $("#extTF .tfbtn").click();
}
async function extendClaim(id, spot) {
  const c = liveClaims().find(x => x.id === id && x.spot === spot); if (!c) return;
  const info = extendInfo(c), err = $("#xErr");
  if (!info) return showErr(err, "De plek is niet meer vrij na je eindtijd.");
  const u = Math.min(extendVal, info.max), old = c.until;
  if (!(u > old)) return showErr(err, "Kies een latere eindtijd.");
  try {
    await mutateClaims(spot, (items) => {
      const it = items.find(x => x.id === id); if (!it) throw new UserError("Je claim bestaat niet meer.");
      const clash = items.find(x => x.id !== id && x.house && x.until > x.from && x.from < u && x.until > it.until);
      if (clash) throw new UserError(`Nr ${clash.house} heeft de plek daarna al geclaimd.`);
      it.until = u; it.windowEnd = Math.max(it.windowEnd || 0, info.w.end);
    });
  } catch (e) { console.warn(e); return showErr(err, e instanceof UserError ? e.message : "Verlengen lukte niet. Probeer het opnieuw."); }
  bumpStats({ min: (u - old) / MIN });
  sheetBody(`<div class="notice green"><span>Je claim op ${esc(plekVan(spot))} loopt nu tot ${esc(when(u))}.</span></div>
    ${calBtn(calForClaim({ spot, until: u }), "btn ghost block")}
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
  // Langer vrijgeven (alleen eenmalig): samenvoegen met wat er al is.
  if (w.src === "once" && t > w.end) {
    let res = null;
    if (await guard(async () => { res = await upsertRelease(w.spot, w.start, Math.min(t, w.start + 31 * D), w.note); }))
      sheetBody(`<div class="notice green"><span>${esc(mineLabel(w.spot))} is nu vrij ${esc(range(res.f, res.u))}.</span></div>
        ${calBtn(calForRelease(w.spot, res.f, res.u), "btn ghost block")}
        <button class="btn ghost block" data-action="closesheet">Klaar</button>`);
    return;
  }
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
let recDays = new Set();
function recSheet(id) {
  const r = st.recurring.find(x => x.id === id); if (!r) return;
  recDays = new Set(r.days || []);
  openSheet(`${mineLabel(r.spot)}: elke week`, `
    <div class="field"><span class="lbl">Op deze dagen</span><div class="chips" id="recDays"></div></div>
    <div class="two">
      <div class="field"><label for="recF">Van</label><input type="time" id="recF" value="${esc(r.fromTime || "08:00")}" step="900"></div>
      <div class="field"><label for="recU">Tot</label><input type="time" id="recU" value="${esc(r.untilTime || "18:00")}" step="900"></div>
    </div>
    <p class="muted small" style="margin:0">Ligt de eindtijd voor de begintijd, dan loopt het door tot de volgende dag. Claims die buren al hebben gedaan, blijven gelden.</p>
    <div class="err" id="recErr" hidden></div>
    <button class="btn block" data-action="recsave" data-id="${id}">Opslaan</button>
    <button class="btn danger block" data-action="stoprec" data-ref="${id}">Stop herhaling</button>`);
  const paint = () => { $("#recDays").innerHTML = DAYS.map(([d, l]) => `<button type="button" class="chip" data-recday="${d}" aria-pressed="${recDays.has(d)}">${l}</button>`).join(""); };
  $("#recDays").addEventListener("click", (e) => { const b = e.target.closest("[data-recday]"); if (!b) return; const d = Number(b.dataset.recday); recDays.has(d) ? recDays.delete(d) : recDays.add(d); paint(); });
  paint();
}
async function recSave(id) {
  const r = st.recurring.find(x => x.id === id); if (!r) return;
  const err = $("#recErr"), ft = $("#recF").value, ut = $("#recU").value, days = [...recDays];
  if (!days.length) return showErr(err, "Kies minstens één dag.");
  if (!ft || !ut || ft === ut) return showErr(err, "Vul een begin- en eindtijd in die verschillen.");
  const fields = { days, fromTime: ft, untilTime: ut };
  if (ft !== r.fromTime || ut !== r.untilTime) fields.overrides = {};
  if (await guard(() => updateDoc(doc(fs, "recurring", id), fields))) { closeSheet(); toast("Wekelijkse vrijgave aangepast."); }
}
async function stopRec(id) { if (await guard(() => deleteDoc(doc(fs, "recurring", id)))) toast("Herhaling gestopt."); }
async function submitRequest(ev, rr) {
  ev.preventDefault();
  const err = $("#reqErr"); const fail = (m) => showErr(err, m); fail("");
  if (!st.house) return fail("Je adres is onbekend. Vraag de beheerder om hulp.");
  const { from, until } = rr.get();
  if (until <= from) return fail("De eindtijd moet na de begintijd liggen.");
  if (until <= now()) return fail("Deze periode ligt al in het verleden.");
  const note = $("#reqNote").value.trim().slice(0, 140);
  if (await guard(() => addDoc(collection(fs, "requests"), { house: st.house, from, until, note, offeredBy: null, offeredSpot: null, createdAt: now() }))) {
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
    if (!wins.some(w => w.spot === p && w.start <= from && w.end >= until)) { await upsertRelease(p, from, until, `Voor nr ${r.house}`); bumpStats({ r: 1 }); }
    await mutateClaims(p, (items) => {
      const clash = items.find(c => c.house && c.until > c.from && c.from < until && c.until > from);
      if (clash) throw new UserError(`Nr ${clash.house} heeft je plek in die periode al geclaimd.`);
      items.push({ id: rid(), owner: st.house, windowStart: from, windowEnd: until, house: r.house, from, until, earlyReturn: null, createdAt: now() });
    });
    await updateDoc(doc(fs, "requests", id), { offeredBy: st.house, offeredSpot: p });
  });
  if (ok) bumpStats({ c: 1, min: (until - from) / MIN, house: r.house });
  if (ok) openSheet("Aangeboden", `<div class="notice green"><span>Je plek staat klaar voor nr ${esc(r.house)}, ${esc(range(from, until))}.</span></div>
    ${waBtns(r.house, `Hoi! Je kunt ${range(from, until)} op mijn parkeerplek staan. Groet, ${STREET} ${st.house}`)}
    <button class="btn ghost block" data-action="closesheet">Klaar</button>`);
}
async function ackOffer(id) { await guard(() => updateDoc(doc(fs, "requests", id), { ackOffered: true })); }
async function delReq(id) { if (await guard(() => deleteDoc(doc(fs, "requests", id)))) toast("Verzoek ingetrokken."); }

/* ---------- account ---------- */
async function reauth(pw) { await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(st.user.email, pw)); }
const PW_ERR = {
  "auth/wrong-password": "Je huidige wachtwoord klopt niet.",
  "auth/invalid-credential": "Je huidige wachtwoord klopt niet.",
  "auth/missing-password": "Vul je wachtwoord in.",
  "auth/weak-password": "Kies een wachtwoord van minstens 6 tekens.",
  "auth/too-many-requests": "Te veel pogingen. Wacht even en probeer opnieuw.",
  "auth/network-request-failed": "Geen verbinding met internet.",
};
async function changePw(el) {
  const err = $("#pwErr"), old = $("#pwOld").value, nw = $("#pwNew").value; showErr(err, "");
  if (!old) return showErr(err, "Vul je huidige wachtwoord in.");
  if (nw.length < 6) return showErr(err, "Kies een nieuw wachtwoord van minstens 6 tekens.");
  el.disabled = true;
  try {
    await reauth(old); await updatePassword(auth.currentUser, nw);
    $("#pwOld").value = ""; $("#pwNew").value = ""; $("#setPw").open = false;
    toast("Je wachtwoord is gewijzigd.");
  } catch (e) { console.warn(e); showErr(err, PW_ERR[e.code] || "Dat lukte niet. Probeer het opnieuw."); }
  finally { el.disabled = false; }
}
async function delAccount(el) {
  const err = $("#delErr"), pw = $("#delPw").value; showErr(err, "");
  if (!pw) return showErr(err, "Vul je wachtwoord in ter bevestiging.");
  if (!confirmTap("delacc", el, "Zeker weten? Tik nog een keer")) return;
  el.disabled = true;
  try { await reauth(pw); }
  catch (e) { console.warn(e); el.disabled = false; el.textContent = "Account definitief verwijderen"; return showErr(err, PW_ERR[e.code] || "Dat lukte niet. Probeer het opnieuw."); }
  try {
    if (st.house) { try { await updateDoc(doc(fs, "houses", st.house), new FieldPath("contacts", st.user.uid), deleteField()); } catch (e) { console.warn(e); } }
    await deleteDoc(doc(fs, "members", st.user.uid));
    unsubscribeAll();
    await deleteUser(auth.currentUser);
    toast("Je account is verwijderd. Bedankt voor het meedoen!");
  } catch (e) { console.warn(e); el.disabled = false; showErr(err, "Verwijderen lukte niet helemaal. Vraag de beheerder om hulp."); }
}

/* ---------- tabs ---------- */
const TABS = ["kaart", "activiteit", "instellingen"];
function setTab(t) {
  if (!TABS.includes(t)) t = "kaart";
  st.tab = t;
  document.querySelectorAll("section[data-tab]").forEach(s => s.hidden = s.dataset.tab !== t);
  document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === t));
  try { history.replaceState(null, "", "#" + t); } catch {}
  window.scrollTo({ top: 0 });
  if (t === "instellingen" && st.member) checkAdmin();
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
  setTab((location.hash || "").slice(1) || "kaart");
  if (!$("#momentBtn")) mountMoment();
  subscribe();
  render();
  checkAdmin();
}
function subscribe() {
  if (st.live) return;
  st.live = true;
  const cut = now() - D, err = (e) => { console.warn("db", e); if (e.code === "permission-denied") toast("Geen toegang tot de gegevens."); };
  const arr = (k) => (s) => { st[k] = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); };
  const map = (k) => (s) => { const m = {}; s.docs.forEach(d => m[d.id] = d.data()); st[k] = m; render(); };
  st.unsubs = [
    onSnapshot(collection(fs, "spots"), (s) => { st.spotsLoaded = true; map("spots")(s); }, err),
    onSnapshot(collection(fs, "houses"), (s) => { st.phonesLoaded = true; map("phones")(s); }, err),
    onSnapshot(query(collection(fs, "releases"), where("until", ">", cut)), arr("releases"), err),
    onSnapshot(collection(fs, "recurring"), arr("recurring"), err),
    onSnapshot(collection(fs, "claims"), (s) => { st.claims = s.docs.flatMap(d => (d.data().items || []).map(c => ({ ...c, spot: d.id }))); render(); }, err),
    onSnapshot(query(collection(fs, "requests"), where("until", ">", cut)), arr("requests"), err),
    onSnapshot(collection(fs, "stats"), map("stats"), err),
  ];
}
function unsubscribeAll() { st.unsubs.forEach(u => { try { u(); } catch {} }); st.unsubs = []; st.live = false; }

onAuthStateChanged(auth, async (user) => {
  st.user = user;
  if (!user) { unsubscribeAll(); st.member = null; st.house = null; st.ob = null; showScreen("login"); renderAuthMode(); return; }
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
    case "moment": setMoment(d.v ? Number(d.v) : null); break;
    case "spot": spotSheet(d.spot); break;
    case "claimsheet": claimSheet(d.key); break;
    case "claim": claim(d.key); break;
    case "earlysheet": earlySheet(d.key); break;
    case "early": changeEnd(d.key, earlyVal); break;
    case "cancelwin": { const w = windows().find(x => x.key === d.key); if (w) changeEnd(w.key, w.start > now() ? w.start : floorQ(now())); break; }
    case "unclaim": unclaim(d.id, d.spot); break;
    case "ack": ack(d.id, d.spot); break;
    case "stoprec": if (st.sheet) closeSheet(); stopRec(d.ref); break;
    case "closesheet": closeSheet(); break;
    case "releasesheet": releaseSheet(d.spot); break;
    case "requestsheet": requestSheet(); break;
    case "requestslist": requestsListSheet(); break;
    case "ackoffer": ackOffer(d.id); break;
    case "claimfit": claimFit(d.key, Number(d.from), Number(d.until), d.req || null); break;
    case "reqdecide": reqDecide(d.id, d.v, el); break;
    case "recsheet": recSheet(d.id); break;
    case "recsave": recSave(d.id); break;
    case "extendsheet": extendSheet(d.id, d.spot); break;
    case "extend": extendClaim(d.id, d.spot); break;
    case "mileok": saveMember({ mile: Number(d.v) }); render(); break;
    case "changepw": changePw(el); break;
    case "delaccount": delAccount(el); break;
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
    case "calendar": calendarSheet(d.k); break;
    case "obnext": obNext(); break;
    case "obcharger": obCharger(d.v === "1"); break;
    case "obphone": obPhone(); break;
    case "obskipwa": obSkipWa(); break;
    case "admindel": adminDelete(d.id, el); break;
    case "adminunlink": adminUnlink(d.spot, el); break;
    case "backup": backup(); break;
    case "cleanup": cleanup(false); break;
    case "copyid": navigator.clipboard?.writeText(st.user.uid).then(() => toast("Account-ID gekopieerd."), () => toast("Kopiëren lukte niet. Houd de tekst ingedrukt om te kopiëren.")); break;
    case "ics": downloadIcs(d.k); break;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && st.sheet) closeSheet();
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("g.spot")) { e.preventDefault(); e.target.dataset.action === "linktap" ? linkTap(e.target.dataset.spot) : spotSheet(e.target.dataset.spot); }
});
document.querySelectorAll("#tabs button").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
document.addEventListener("change", (e) => { const el = e.target.closest?.('[data-action="adminhouse"]'); if (el) adminHouse(el.dataset.id, el.value); });
$("#authForm").addEventListener("submit", submitAuth);
$("#joinForm").addEventListener("submit", submitJoin);

const houseOpts = `<option value="">Kies…</option>` + HOUSES.map(h => `<option value="${h}">${STREET} ${h}</option>`).join("");
$("#authHouse").innerHTML = houseOpts;
$("#joinHouse").innerHTML = houseOpts;
renderAuthMode();
// Testomgeving? Dan duidelijk in beeld, zodat niemand hem met de echte app verwart.
if (cfg.envLabel) { document.querySelectorAll(".brand .sub").forEach(el => el.textContent = cfg.envLabel); document.documentElement.style.setProperty("--sign", "#b35c00"); }
// Elke minuut opnieuw tekenen (tijden, meldingen), maar niet terwijl iemand iets invult of aan de schijven draait.
setInterval(() => { if (!st.sheet && !document.activeElement?.matches?.("input,select,.wheel,.tfbtn,.momentbtn") && !document.querySelector(".tfw:not([hidden])")) render(); }, 60e3);
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
window.addEventListener("online", () => render());
window.addEventListener("offline", () => render());
$("#appVersion").textContent = `Versie ${APP_VERSION}`;
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkVersion(); });
