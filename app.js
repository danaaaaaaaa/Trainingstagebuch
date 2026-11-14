"use strict";

/* =====================================================================
   Trainingstagebuch – Oberfläche
   Aufbau dieser Datei:
     1. Hilfsfunktionen   HTML bauen, Zeiten und Zahlen formatieren
     2. Api               spricht mit dem Python-Server
     3. Zustand, Timers   Trainings- und Pausenuhr oben rechts
     4. Ansichten         Startseite, Starten, Nachtragen, Training, Übung,
                          Tauschen, Verwalten
     5. Router            zeigt je nach Adresse (#/...) die passende Ansicht
   ===================================================================== */


/* ---------------------------------------------------------------------
   1. Hilfsfunktionen
   --------------------------------------------------------------------- */

const $view = document.getElementById("view");
const numberFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const volumeFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const pad = (n) => String(n).padStart(2, "0");

/** Baut ein HTML-Element: h("div", { class: "box" }, "Text", weitereElemente).
 *  Texte werden dabei immer als Text eingesetzt (nie als HTML) – das schützt
 *  davor, dass eingegebene Namen Schaden anrichten können. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "style") el.style.cssText = value;   // über CSSOM: erlaubt auch mit strenger Sicherheitsrichtlinie
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/** Wie h(), aber für SVG-Elemente (Diagramme). */
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  for (const child of children.flat(Infinity)) if (child != null && child !== false) el.append(child);
  return el;
}

/** Datum als Schlüssel "2026-11-01" (in der Zeitzone des Nutzers). */
function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Sonntag, 1. November 2026" */
function formatDay(key) {
  return new Date(key + "T12:00:00").toLocaleDateString("de-DE", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

/** "09:42" */
function formatTime(iso) {
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

/** Uhr-Anzeige: 00:12:34 (mit Stunden) oder 01:20 (nur Minuten und Sekunden). */
function formatClock(ms, withHours) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return withHours
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(Math.floor(total / 60))}:${pad(seconds)}`;
}

/** Gewicht eines Satzes: "60 kg", "Körpergewicht" oder "Körpergewicht + 5 kg". */
function formatLoad(set) {
  if (!set.bodyweight) return `${numberFormat.format(set.weight)} kg`;
  return set.weight > 0 ? `Körpergewicht + ${numberFormat.format(set.weight)} kg` : "Körpergewicht";
}

/** Ein Satz als Text: "10 × 60 kg". */
const formatSet = (set) => `${set.reps} × ${formatLoad(set)}`;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Sortiert eine Liste in Gruppen: groupBy(liste, eintrag => schlüssel). */
function groupBy(items, keyOf) {
  const groups = {};
  for (const item of items) (groups[keyOf(item)] ||= []).push(item);
  return groups;
}

/** Zeigt kurz eine Meldung am unteren Bildrand. */
function toast(message) {
  const el = h("div", { class: "toast", role: "status" }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

/** Verkleinert ein Foto (max. 900 px) und gibt es als Text (Data-URL) zurück. */
function resizeImage(file, maxSize = 900) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";                       // transparente PNGs: weißer Grund
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Das Bild konnte nicht geladen werden."));
    };
    img.src = url;
  });
}


/* ---------------------------------------------------------------------
   2. Api: Anfragen an den Server
   --------------------------------------------------------------------- */

class Api {
  /** Schickt eine "Anfrage" an die lokale Datenschicht (store.js). Es geht nichts
   *  über das Netzwerk. Fehler tragen eine lesbare Meldung. */
  static async request(path, method = "GET", body) {
    try {
      const result = await LocalServer.handle(method, path, body);
      return result === undefined ? null : result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      console.error(error);
      throw new Error("Das hat nicht geklappt. Bitte die App neu öffnen.");
    }
  }

  static get(path) { return Api.request(path); }
  static post(path, body) { return Api.request(path, "POST", body); }
  static patch(path, body) { return Api.request(path, "PATCH", body); }
  static delete(path) { return Api.request(path, "DELETE"); }
}

/** Gibt dem Nutzer eine Datei: Auf dem iPhone über das Teilen-Menü ("In Dateien sichern"),
 *  sonst als normaler Download. */
async function saveFile(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (error) { if (error.name === "AbortError") return; }   // abgebrochen: nichts tun
  }
  const url = URL.createObjectURL(file);
  const link = h("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}


/* ---------------------------------------------------------------------
   3. Zustand und Uhren
   --------------------------------------------------------------------- */

const state = {
  openFolds: new Set(),   // geöffnete Bereiche der Startseite
  progressExercise: null, // gewählte Übung bei der Gewichtsentwicklung
  editOrder: false,   // Reihenfolge/Supersätze bearbeiten (Training-Seite)
  session: null,                                  // laufendes Training (oder null)
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),  // angezeigter Monat
  selectedDay: null,                              // im Kalender angetippter Tag
  statsAll: false,                                // Statistik: false = Monat, true = alles
};

class Timers {
  /** Aktualisiert beide Uhren. Läuft jede Sekunde und nach jedem Seitenwechsel.
   *  Die Zeiten werden aus den Zeitstempeln des Servers berechnet, deshalb laufen
   *  die Uhren auch nach einem Neuladen der Seite korrekt weiter. */
  static update() {
    const session = state.session;
    document.getElementById("timers").hidden = !session;
    if (!session) return;

    const now = Date.now();
    document.getElementById("timer-total").textContent =
      formatClock(now - new Date(session.started_at), true);

    // Pause = Zeit seit dem zuletzt eingetragenen Satz (startet bei jedem neuen Satz neu)
    const lastSet = session.sets[session.sets.length - 1];
    document.getElementById("timer-rest-box").hidden = !lastSet;
    if (lastSet) {
      document.getElementById("timer-rest").textContent =
        formatClock(now - new Date(lastSet.logged_at), false);
    }
  }
}


/* ---------------------------------------------------------------------
   4. Ansichten
   Jede Ansicht lädt ihre Daten und gibt eine Liste von Elementen zurück.
   --------------------------------------------------------------------- */

const backLink = (href, text) => h("a", { class: "back", href }, "‹ " + text);

/** Läuft das gezeigte Training gerade (und ist nicht nachgetragen)? */
const isLive = (session) => Boolean(state.session) && state.session.id === session.id;

/** Adresse der Übungsliste eines Trainings. */
const sessionHref = (session) => (isLive(session) ? "#/session" : `#/log/${session.id}`);

/** Adresse einer Übung innerhalb eines Trainings. */
const exerciseHref = (session, exerciseId) =>
  isLive(session) ? `#/exercise/${exerciseId}` : `#/log/${session.id}/exercise/${exerciseId}`;

/** Holt ein Training: das laufende aus dem Zustand, andere vom Server. */
const loadSession = (id) =>
  state.session && state.session.id === Number(id) ? state.session : Api.get(`/api/sessions/${id}`);

/** Führt eine Aktion aus und lädt danach die Ansicht neu. Fehler erscheinen als Meldung. */
async function perform(action) {
  try {
    await action();
    route();
  } catch (error) {
    toast(error.message);
  }
}

/** Hinweis und Knopf, wenn noch kein Workout existiert. */
const noWorkoutsHint = () => [
  h("p", { class: "empty" }, "Du hast noch kein Workout angelegt."),
  h("a", { class: "btn primary", href: "#/manage" }, "Workout anlegen"),
];

/* ----- Startseite: Kalender ----- */

/* ----- Info-Symbole: Erklärtexte nur bei Bedarf einblenden ----- */

/** Erzeugt ein kleines "i"-Symbol und den dazugehörigen Erklärtext (zunächst versteckt).
 *  Gibt [Symbol, Text] zurück: Das Symbol kommt neben die Überschrift, der Text darunter. */
function makeInfo(text) {
  const note = h("p", { class: "info-text", role: "note", hidden: true }, text);
  const button = h("button", {
    type: "button", class: "info-btn", "aria-label": "Hinweis anzeigen", "aria-expanded": "false",
    onclick: () => {
      note.hidden = !note.hidden;
      button.setAttribute("aria-expanded", String(!note.hidden));
    },
  }, "i");
  return [button, note];
}

/** Zeigt ein Element (meist eine Überschrift) mit Info-Symbol rechts daneben und dem Text darunter. */
function withInfo(content, text) {
  const [button, note] = makeInfo(text);
  return h("div", { class: "info-block" }, h("div", { class: "info-row" }, content, button), note);
}

/* ----- Aufklappbare Bereiche der Startseite ----- */

/** Ein Bereich, der sich per Tipp auf die Titelzeile auf- und zuklappen lässt.
 *  Welche Bereiche offen sind, merkt sich die App, solange sie läuft. */
function fold(id, title, content, { hint = null, badge = null } = {}) {
  // Ist content eine Funktion, wird der Inhalt erst beim ersten Aufklappen gebaut (spart Arbeit)
  const lazy = typeof content === "function";
  const body = h("div", { class: "fold-body" }, lazy ? null : content);
  const el = h("details", { class: "fold" },
    h("summary", {},
      h("span", { class: "fold-title" }, title),
      hint ? h("span", { class: "fold-hint" }, hint) : null,
      badge ? h("span", { class: "fold-badge" }, badge) : null),
    body);
  let built = !lazy;
  const ensureBuilt = () => {
    if (built) return;
    built = true;
    body.append(...[content()].flat(Infinity).filter(Boolean));
  };
  el.open = state.openFolds.has(id);
  if (el.open) ensureBuilt();
  el.addEventListener("toggle", () => {
    if (el.open) { state.openFolds.add(id); ensureBuilt(); } else state.openFolds.delete(id);
  });
  return el;
}

async function renderHome() {
  const year = state.month.getFullYear();
  const month = state.month.getMonth();
  const monthKey = `${year}-${pad(month + 1)}`;

  const [sessions, stats, analysis, bodyWeight, weights] = await Promise.all([
    Api.get(`/api/sessions?month=${monthKey}`),
    Api.get(state.statsAll ? "/api/sessions/stats" : `/api/sessions/stats?month=${monthKey}`),
    Api.get(state.statsAll ? "/api/sessions/analysis" : `/api/sessions/analysis?month=${monthKey}`),
    Api.get("/api/bodyweight"),
    Api.get("/api/sessions/weights"),
  ]);
  const byDay = groupBy(sessions, (s) => dayKey(new Date(s.started_at)));   // neueste zuerst
  const selected = state.selectedDay && byDay[state.selectedDay] ? state.selectedDay : null;
  const details = selected
    ? await Promise.all(byDay[selected].map((s) => Api.get(`/api/sessions/${s.id}`)))
    : [];

  // Oben: laufendes Workout fortsetzen oder neues starten
  const top = state.session
    ? h("section", { class: "running" },
        h("div", {}, h("strong", {}, "Workout läuft"), h("span", { class: "muted" }, state.session.workout_name)),
        h("a", { class: "btn primary", href: "#/session" }, "Fortsetzen"))
    : h("a", { class: "btn primary big", href: "#/start" }, "Neues Workout starten");

  return [
    top,
    h("div", { class: "home-actions" },
      h("a", { class: "btn quiet", href: "#/backfill" }, "Training nachtragen"),
      h("a", { class: "btn quiet", href: "#/manage" }, "Workouts verwalten")),
    buildCalendar(year, month, byDay),
    buildLegend(sessions),
    selected ? buildDayDetail(selected, details) : null,
    h("div", { class: "folds" },
      fold("stats", "Statistik & Auswertung", [buildStats(stats), buildAnalysis(analysis)]),
      fold("weights", "Gewichtsentwicklung", buildWeightProgress(weights), { hint: "pro Übung" }),
      fold("bodyweight", "Körpergewicht", buildBodyWeight(bodyWeight),
        { hint: bodyWeight.length ? `${numberFormat.format(bodyWeight[0].kg)} kg` : "optional" }),
      fold("data", "Daten & Sicherung", buildDataSection(),
        { badge: backupDue() ? "Sicherung fällig" : null })),
  ];
}

/* ----- Körpergewicht (optional) ----- */

/** Eingabe des Körpergewichts, Verlauf als Liniendiagramm und die letzten Einträge.
 *  Wer das Gewicht nicht erfassen möchte, ignoriert den Bereich einfach. */
function buildBodyWeight(entries) {            // entries: neueste zuerst
  const today = dayKey(new Date());
  const kgInput = h("input", {
    type: "number", inputmode: "decimal", step: "0.1", min: 20, max: 500,
    placeholder: "kg", "aria-label": "Körpergewicht in kg", required: true,
  });
  const dateInput = h("input", { type: "date", value: today, max: today, "aria-label": "Datum", required: true });

  const form = h("form", {
    class: "weight-form",
    onsubmit: (event) => {
      event.preventDefault();
      const kg = parseFloat(kgInput.value.replace(",", "."));
      perform(() => Api.post("/api/bodyweight", { kg, date: dateInput.value }));
    },
  }, kgInput, dateInput, h("button", { type: "submit", class: "btn primary" }, "Eintragen"));

  return h("section", { class: "bodyweight", "aria-label": "Körpergewicht" },
    withInfo(
      h("p", { class: "muted" }, entries.length
        ? `Zuletzt: ${numberFormat.format(entries[0].kg)} kg am ${formatDay(entries[0].day)}`
        : "Noch kein Eintrag"),
      "Optional: Trage dein Gewicht ein, um den Verlauf zu sehen. Pro Tag gibt es einen Eintrag, ein neuer am selben Tag ersetzt den alten."),
    form,
    buildWeightChart(entries),
    entries.length
      ? h("div", { class: "sheet" }, entries.slice(0, 5).map((entry) =>
          h("div", { class: "row" },
            h("span", { class: "grow" }, formatDay(entry.day)),
            h("strong", {}, `${numberFormat.format(entry.kg)} kg`),
            h("button", {
              type: "button", class: "btn quiet", "aria-label": `Eintrag vom ${formatDay(entry.day)} löschen`,
              onclick: () => confirm("Eintrag löschen?") && perform(() => Api.delete(`/api/bodyweight/${entry.id}`)),
            }, "Löschen"))))
      : null);
}

/** Liniendiagramm des Körpergewichts (älteste Werte links). Erst ab zwei Einträgen. */
function buildWeightChart(entries) {
  if (entries.length < 2) return null;
  const points = [...entries].reverse().slice(-60).map((p) => ({ day: p.day, value: p.kg }));   // letzte 60 Einträge
  return buildTrendChart(points, `Körpergewicht von ${numberFormat.format(points[0].value)} auf ${numberFormat.format(points[points.length - 1].value)} kg`);
}

/** Allgemeines Liniendiagramm über die Zeit. points: [{ day: "2026-11-08", value }], älteste zuerst.
 *  Mit onPick(point) sind die Punkte antippbar (auch per Tastatur). */
function buildTrendChart(points, ariaLabel, onPick) {
  const W = 320, H = 150, left = 40, right = 12, top = 14, bottom = 28;
  const low = Math.min(...points.map((p) => p.value));
  const high = Math.max(...points.map((p) => p.value));
  const span = high - low || 1;
  const x = (i) => (points.length === 1 ? (left + W - right) / 2 : left + (i * (W - left - right)) / (points.length - 1));
  const y = (v) => (high === low ? (top + H - bottom) / 2 : H - bottom - ((v - low) / span) * (H - top - bottom));
  const shortDay = (key) => { const [, m, d] = key.split("-"); return `${d}.${m}.`; };
  const label = (text, attrs) => { const el = svg("text", { class: "chart-label", ...attrs }); el.textContent = text; return el; };

  const dots = points.map((p, i) => {
    const dot = svg("circle", { class: "chart-dot", cx: x(i), cy: y(p.value), r: onPick ? 5 : 3 });
    if (onPick) {
      dot.setAttribute("tabindex", "0");
      dot.setAttribute("role", "button");
      dot.setAttribute("aria-label", `${shortDay(p.day)}: ${numberFormat.format(p.value)}`);
      dot.addEventListener("click", () => onPick(p));
      dot.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPick(p); }
      });
    }
    return dot;
  });

  return svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": ariaLabel },
    svg("line", { class: "chart-grid", x1: left, x2: W - right, y1: y(high), y2: y(high) }),
    svg("line", { class: "chart-grid", x1: left, x2: W - right, y1: y(low), y2: y(low) }),
    label(numberFormat.format(high), { x: left - 6, y: y(high) + 4, "text-anchor": "end" }),
    high === low ? null : label(numberFormat.format(low), { x: left - 6, y: y(low) + 4, "text-anchor": "end" }),
    points.length > 1
      ? svg("polyline", { class: "chart-line", points: points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ") })
      : null,
    dots,
    label(shortDay(points[0].day), { x: left, y: H - 8, "text-anchor": "start" }),
    points.length > 1 ? label(shortDay(points[points.length - 1].day), { x: W - right, y: H - 8, "text-anchor": "end" }) : null);
}

/* ----- Gewichtsentwicklung pro Übung ----- */

/** Wähle eine Übung: Das Diagramm zeigt pro Trainingstag das höchste verwendete Gewicht.
 *  Ein Tipp auf einen Punkt zeigt Datum, Gewicht und Wiederholungen. */
function buildWeightProgress(list) {
  if (!list.length) {
    return h("p", { class: "empty" }, "Sobald du Sätze mit Gewicht einträgst, siehst du hier die Entwicklung pro Übung.");
  }
  const current = list.find((item) => item.exercise_id === state.progressExercise) || list[0];
  const detail = h("p", { class: "muted", "aria-live": "polite" });
  const showPoint = (p) => {
    detail.textContent = `${formatDay(p.day)}: ${numberFormat.format(p.weight)} kg × ${p.reps} Wdh.`;
  };

  const select = h("select", {
    "aria-label": "Übung wählen", class: "progress-select",
    onchange: () => { state.progressExercise = Number(select.value); route(); },
  }, list.map((item) => h("option", { value: item.exercise_id }, item.exercise_name)));
  select.value = String(current.exercise_id);

  const first = current.points[0];
  const last = current.points[current.points.length - 1];
  const change = last.weight - first.weight;
  showPoint(last);

  return h("div", { class: "weight-progress" },
    withInfo(select, "Pro Trainingstag zählt das höchste Gewicht. Tippe auf einen Punkt, um Datum, Gewicht und Wiederholungen zu sehen."),
    buildTrendChart(current.points.map((p) => ({ ...p, value: p.weight })),
      `Gewicht für ${current.exercise_name}, zuletzt ${numberFormat.format(last.weight)} kg`, showPoint),
    detail,
    h("p", { class: "muted small" },
      current.points.length > 1
        ? `Von ${numberFormat.format(first.weight)} kg auf ${numberFormat.format(last.weight)} kg (${change >= 0 ? "+" : "−"}${numberFormat.format(Math.abs(change))} kg) in ${plural(current.points.length, "Training", "Trainings")}.`
        : "Bisher gibt es nur ein Training mit Gewicht."));
}

/* ----- Daten: CSV-Export und Sicherung ----- */

/** Zeigt, wann zuletzt gesichert wurde, und bietet Export, Sicherung und Wiederherstellung an.
 *  Die Daten liegen nur auf diesem Handy, deshalb erinnert die App an Sicherungen. */
/** Wurde nie oder vor mehr als 14 Tagen gesichert? */
function backupDue() {
  const last = backup.lastBackupAt();
  return !last || (Date.now() - Date.parse(last)) / 86400000 > 14;
}

/** Prüft, ob der Service Worker aktiv ist und alle App-Dateien im Speicher des Geräts liegen. */
async function checkOfflineReady() {
  try {
    if (!("serviceWorker" in navigator) || !("caches" in window)) return false;
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.active || !navigator.serviceWorker.controller) return false;
    for (const file of ["index.html", "app.js", "store.js", "style.css"]) {
      if (!(await caches.match(file))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function buildDataSection() {
  const last = backup.lastBackupAt();
  const days = last ? Math.floor((Date.now() - Date.parse(last)) / 86400000) : null;
  const status = last
    ? `Letzte Sicherung: ${formatDay(dayKey(new Date(last)))}${days > 14 ? " – das ist schon länger her." : "."}`
    : "Noch keine Sicherung gespeichert.";

  const fileInput = h("input", {
    type: "file", accept: ".json,application/json", hidden: true,
    onchange: async () => {
      const file = fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      if (!confirm("Die Sicherung ersetzt ALLE Daten in der App. Fortfahren?")) return;
      await perform(async () => {
        await backup.restore(await file.text());
        state.session = await Api.get("/api/sessions/active");
        toast("Sicherung eingelesen.");
      });
    },
  });

  // Zeigt, ob die App auf diesem Gerät auch ohne Internet startet (füllt sich, sobald geprüft)
  const offlineStatus = h("p", { class: "muted small" });
  checkOfflineReady().then((ready) => {
    offlineStatus.textContent = ready
      ? "Offline-Start: bereit. Die App startet auch ohne Internet."
      : "Offline-Start: noch nicht bereit. Öffne die App einmal mit Internet und danach noch einmal.";
  });

  return h("section", { class: "data" },
    h("p", { class: last && days <= 14 ? "muted" : "warn" }, status),
    offlineStatus,
    h("div", { class: "home-actions" },
      h("button", { type: "button", class: "btn primary", onclick: () => perform(async () => {
        await saveFile(`trainingstagebuch-sicherung-${dayKey(new Date())}.json`, await backup.createFile(), "application/json");
      }) }, "Sicherung speichern"),
      h("button", { type: "button", class: "btn quiet", onclick: () => fileInput.click() }, "Sicherung einlesen")),
    h("p", {}, h("button", { type: "button", class: "btn quiet", onclick: () => perform(async () => {
      await saveFile("trainingstagebuch.csv", "\ufeff" + sessionStore.exportCsv(), "text/csv");
    }) }, "Alle Sätze als CSV exportieren")),
    fileInput);
}

/* ----- Ausführliche Auswertung: Diagramme und Übungen ----- */

/** Tortendiagramm der Muskelgruppen (Anteil an allen Wiederholungen).
 *  Ein Tipp auf ein Tortenstück oder einen Eintrag der Legende zeigt darunter Prozent,
 *  Wiederholungen, Sätze und das bewegte Gewicht der Gruppe. */
function buildMusclePie(muscles) {
  const COLORS = ["#c62f26", "#0b7f8c", "#b4590a", "#6d44c4", "#1b7f4b", "#b02a7e",
    "#2f5fd0", "#8a8f1a", "#d98c00", "#5a6b7b", "#e0607e", "#3aa6a0"];
  const percentFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
  const total = muscles.reduce((sum, m) => sum + m.reps, 0);
  const R = 90, C = 100;                                          // Radius und Mittelpunkt (Bild 200 x 200)

  // Farbe, Name und Anteil je Gruppe vorbereiten
  let start = -Math.PI / 2;                                       // oben beginnen
  const slices = muscles.map((m, i) => {
    const share = m.reps / total;
    const slice = {
      ...m, share, start, end: start + share * 2 * Math.PI,
      name: m.muscle || "Nicht zugeordnet",
      color: m.muscle ? (COLORS[i] || `hsl(${(i * 47) % 360} 55% 45%)`) : "#9aa3ad",
    };
    start = slice.end;
    return slice;
  });

  const point = (angle, radius = R) => [C + radius * Math.cos(angle), C + radius * Math.sin(angle)];
  const shape = (slice) => {
    if (slice.share > 0.9999) return svg("circle", { cx: C, cy: C, r: R });          // 100 %: ganzer Kreis
    const [x1, y1] = point(slice.start), [x2, y2] = point(slice.end);
    const large = slice.end - slice.start > Math.PI ? 1 : 0;
    return svg("path", { d: `M ${C} ${C} L ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} Z` });
  };

  const detail = h("div", { class: "pie-detail", "aria-live": "polite" });          // leer, bis etwas gewählt ist
  const parts = [];                                               // [Tortenstück, Legendeneintrag]
  let selected = null;

  const select = (slice) => {
    selected = selected === slice ? null : slice;                 // nochmal tippen = abwählen
    parts.forEach(([piece, entry, s]) => {
      const active = s === selected;
      piece.classList.toggle("active", active);
      entry.classList.toggle("active", active);
      entry.setAttribute("aria-pressed", String(active));
      const mid = (s.start + s.end) / 2;                          // gewähltes Stück etwas herausschieben
      piece.setAttribute("transform", active && slices.length > 1
        ? `translate(${6 * Math.cos(mid)} ${6 * Math.sin(mid)})` : "");
    });
    detail.replaceChildren(selected
      ? h("div", { class: "pie-facts" },
          h("strong", {}, h("i", { class: "swatch", style: `background: ${selected.color}` }), selected.name),
          h("dl", {},
            h("dt", {}, "Anteil"), h("dd", {}, `${percentFormat.format(selected.share * 100)} %`),
            h("dt", {}, "Wiederholungen"), h("dd", {}, volumeFormat.format(selected.reps)),
            h("dt", {}, "Sätze"), h("dd", {}, volumeFormat.format(selected.sets)),
            h("dt", {}, "Gesamtgewicht"), h("dd", {}, `${volumeFormat.format(selected.volume)} kg`)))
      : []);
  };

  const pieces = slices.map((slice) => {
    const piece = svg("g", { class: "pie-slice", tabindex: 0, role: "button",
        "aria-label": `${slice.name}: ${percentFormat.format(slice.share * 100)} Prozent` },
      shape(slice));
    piece.firstChild.setAttribute("fill", slice.color);
    piece.addEventListener("click", () => select(slice));
    piece.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(slice); }
    });
    return piece;
  });

  const legend = h("ul", { class: "pie-legend" }, slices.map((slice, i) => {
    const entry = h("button", { type: "button", class: "legend-entry", "aria-pressed": "false", onclick: () => select(slice) },
      h("i", { class: "swatch", style: `background: ${slice.color}` }),
      h("span", { class: "grow" }, slice.name),
      h("span", { class: "muted" }, `${percentFormat.format(slice.share * 100)} %`));
    parts.push([pieces[i], entry, slice]);
    return h("li", {}, entry);
  }));

  return h("div", { class: "pie" },
    svg("svg", { viewBox: "-8 -8 216 216", class: "pie-chart", role: "group", "aria-label": "Anteile der Muskelgruppen" }, pieces),
    legend, detail);
}

/** Zeigt unter der Statistik (im gleichen Zeitraum): bewegtes Gewicht im Zeitverlauf
 *  als Säulendiagramm und pro Übung Wiederholungen, Sätze und bewegtes Gewicht. */
function buildAnalysis({ exercises, muscles, timeline }) {
  if (!exercises.length) return null;
  const perDay = !state.statsAll;
  const label = (text, attrs) => { const el = svg("text", { class: "chart-label", ...attrs }); el.textContent = text; return el; };
  const labelOf = (key) => {                                    // Beschriftung unter der Säule
    const [year, month, day] = key.split("-");
    return perDay ? String(Number(day)) : `${month}/${year.slice(2)}`;
  };

  // Säulendiagramm: bewegtes Gewicht pro Tag (Monat) bzw. pro Monat (Gesamt)
  const W = 320, H = 160, left = 8, right = 8, top = 22, bottom = 26;
  const max = Math.max(...timeline.map((t) => t.volume)) || 1;
  const slot = (W - left - right) / timeline.length;
  const barWidth = Math.max(2, slot * 0.7);
  const labelStep = Math.ceil(timeline.length / (perDay ? 8 : 6));    // nicht jede Säule beschriften
  const bars = timeline.map((t, i) => {
    const height = (t.volume / max) * (H - top - bottom);
    return [
      t.volume > 0 ? svg("rect", {
        class: "bar-v", x: left + i * slot + (slot - barWidth) / 2, y: H - bottom - height,
        width: barWidth, height, rx: 2 },
        svg("title", {}, `${labelOf(t.key)}: ${volumeFormat.format(t.volume)} kg`)) : null,
      i % labelStep === 0 ? label(labelOf(t.key), { x: left + i * slot + slot / 2, y: H - 8, "text-anchor": "middle" }) : null,
    ];
  });
  const sessionsTotal = timeline.reduce((sum, t) => sum + t.sessions, 0);

  // Pro Übung: Balken nach Wiederholungen
  const maxReps = Math.max(...exercises.map((e) => e.reps));
  return h("section", { class: "analysis", "aria-label": "Auswertung" },
    h("h3", {}, perDay ? "Bewegtes Gewicht pro Tag" : "Bewegtes Gewicht pro Monat"),
    svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img",
        "aria-label": `Bewegtes Gewicht, höchster Wert ${volumeFormat.format(max)} kg` },
      svg("line", { class: "chart-grid", x1: left, x2: W - right, y1: H - bottom, y2: H - bottom }),
      label(`max. ${volumeFormat.format(max)} kg`, { x: left, y: 12, "text-anchor": "start" }),
      bars),
    h("p", { class: "muted small" }, `${plural(sessionsTotal, "Training", "Trainings")} in diesem Zeitraum.`),

    withInfo(h("h3", {}, "Muskelgruppen (Anteil an den Wiederholungen)"),
      "Tippe auf ein Stück der Torte oder auf einen Eintrag darunter, um Prozent, Wiederholungen, Sätze und Gesamtgewicht zu sehen."),
    buildMusclePie(muscles),
    h("p", { class: "muted small" },
      h("a", { href: "#/muscles" }, "Muskelgruppen der Übungen zuordnen"),
      muscles.some((m) => !m.muscle) ? " – einige Übungen sind noch nicht zugeordnet." : ""),

    h("h3", {}, "Wiederholungen pro Übung"),
    h("div", { class: "sheet" }, exercises.map((e) =>
      h("div", { class: "ex-stat" },
        h("div", { class: "ex-stat-head" },
          h("strong", {}, e.exercise_name),
          h("span", {}, `${volumeFormat.format(e.reps)} Wdh.`)),
        h("div", { class: "bar-track" }, h("i", { class: "bar-h", style: `width: ${Math.max(2, (e.reps / maxReps) * 100)}%` })),
        h("span", { class: "muted small" },
          `${plural(e.sets, "Satz", "Sätze")} · ${volumeFormat.format(e.volume)} kg bewegt`)))));
}

function buildCalendar(year, month, byDay) {
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;   // Montag = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dayKey(new Date());
  const isCurrentMonth = year === new Date().getFullYear() && month === new Date().getMonth();

  const changeMonth = (step) => {
    state.month = new Date(year, month + step, 1);
    state.selectedDay = null;
    route();
  };

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(h("span"));      // leere Felder vor dem 1.

  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${pad(month + 1)}-${pad(day)}`;
    const list = byDay[key] || [];

    // Farbe der Scheibe: eine Farbe, bei mehreren Workouts am Tag geteilt
    const colors = [...new Set(list.map((s) => s.color))];
    const plate = colors.length <= 1
      ? colors[0]
      : `conic-gradient(${colors.map((c, i) => `${c} ${(i * 100) / colors.length}% ${((i + 1) * 100) / colors.length}%`).join(", ")})`;

    const names = list.map((s) => s.workout_name).join(", ");
    cells.push(h("button", {
      type: "button",
      class: ["day", list.length && "has", key === todayKey && "today", key === state.selectedDay && "selected"]
        .filter(Boolean).join(" "),
      style: plate ? `--plate: ${plate}` : null,
      "aria-label": `${day}. ${names ? "– " + names : ""}`,
      onclick: list.length ? () => { state.selectedDay = key === state.selectedDay ? null : key; route(); } : null,
    }, h("span", { class: "num" }, day)));
  }

  return h("section", { "aria-label": "Kalender" },
    h("div", { class: "calendar-head" },
      h("button", { type: "button", class: "icon-btn", "aria-label": "Vorheriger Monat", onclick: () => changeMonth(-1) }, "‹"),
      h("h2", { class: "month-title" },
        state.month.toLocaleDateString("de-DE", { month: "long", year: "numeric" })),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Nächster Monat", onclick: () => changeMonth(1) }, "›")),
    isCurrentMonth ? null : h("div", { class: "home-links" },
      h("button", {
        type: "button", class: "btn quiet",
        onclick: () => { state.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1); state.selectedDay = null; route(); },
      }, "Zurück zu heute")),
    h("div", { class: "weekdays" }, ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((d) => h("span", {}, d))),
    h("div", { class: "grid" }, cells));
}

/** Farblegende: welche Farbe gehört zu welchem Workout (nur Workouts dieses Monats). */
function buildLegend(sessions) {
  const workouts = [...new Map(sessions.map((s) => [s.workout_id, s])).values()];
  if (!workouts.length) return null;
  return h("div", { class: "legend" }, workouts.map((s) =>
    h("span", {}, h("i", { class: "dot", style: `background: ${s.color}` }), s.workout_name)));
}

/** Details zu den Trainings eines angetippten Tages (neuestes oben). */
function buildDayDetail(key, sessions) {
  return h("section", { class: "detail" },
    h("h2", {}, formatDay(key)),
    sessions.map((session) => {
      // Sätze nach Übung zusammenfassen (Reihenfolge wie trainiert)
      const byExercise = new Map();
      for (const set of session.sets) {
        if (!byExercise.has(set.exercise_id)) byExercise.set(set.exercise_id, { name: set.exercise_name, sets: [] });
        byExercise.get(set.exercise_id).sets.push(set);
      }
      let timeText;
      if (session.backfilled) {
        timeText = `nachgetragen, ${formatTime(session.started_at)} Uhr`;
      } else if (session.ended_at) {
        const minutes = Math.max(1, Math.round((new Date(session.ended_at) - new Date(session.started_at)) / 60000));
        timeText = `${formatTime(session.started_at)} bis ${formatTime(session.ended_at)} Uhr, ${minutes} Min.`;
      } else {
        timeText = `ab ${formatTime(session.started_at)} Uhr, läuft noch`;
      }

      return h("article", { class: "detail-session" },
        h("div", { class: "detail-head" },
          h("i", { class: "dot lg", style: `background: ${session.color}` }),
          h("h3", {}, session.workout_name),
          h("span", { class: "muted small" }, timeText)),
        h("p", { class: "muted small" }, `Bewegtes Gewicht: ${volumeFormat.format(session.total_volume)} kg`),
        [...byExercise.values()].map(({ name, sets }) =>
          h("div", { class: "detail-ex" },
            h("strong", {}, name),
            h("div", { class: "setchips" }, sets.map((s) =>
              h("span", { class: "setchip" }, formatSet(s), s.note ? h("em", {}, ` – ${s.note}`) : null))))),
        h("div", { class: "detail-actions" },
          session.backfilled ? h("a", { class: "btn quiet", href: `#/log/${session.id}` }, "Bearbeiten") : null,
          h("button", {
            type: "button", class: "btn quiet danger",
            onclick: () => confirm("Dieses Training mit allen Sätzen löschen?")
              && perform(() => Api.delete(`/api/sessions/${session.id}`)),
          }, "Training löschen")));
    }));
}

/** Statistik ganz unten: bewegtes Gewicht pro Workout (Wiederholungen × Gewicht). */
function buildStats(rows) {
  const total = rows.reduce((sum, row) => sum + row.volume, 0);
  const switchButton = (label, showAll) => h("button", {
    type: "button", class: "seg" + (state.statsAll === showAll ? " active" : ""),
    onclick: () => { state.statsAll = showAll; route(); },
  }, label);

  const statsInfo = makeInfo("Bewegtes Gewicht = Wiederholungen × Gewicht. Bei Körpergewicht zählt nur das Zusatzgewicht.");
  return h("section", { class: "stats", "aria-label": "Statistik" },
    h("div", { class: "stats-head" },
      h("div", { class: "info-row" }, h("h3", {}, "Statistik"), statsInfo[0]),
      h("div", { class: "segmented" }, switchButton("Dieser Monat", false), switchButton("Gesamt", true))),
    rows.length
      ? h("div", { class: "sheet" },
          rows.map((row) => h("div", { class: "row" },
            h("i", { class: "dot lg", style: `background: ${row.color}` }),
            h("span", { class: "grow" },
              h("strong", {}, row.workout_name),
              h("span", { class: "muted small block" }, plural(row.sessions, "Training", "Trainings"))),
            h("span", { class: "volume" }, `${volumeFormat.format(row.volume)} kg`))),
          rows.length > 1
            ? h("div", { class: "row total" },
                h("span", { class: "grow" }, h("strong", {}, "Alle Workouts")),
                h("span", { class: "volume" }, `${volumeFormat.format(total)} kg`))
            : null)
      : h("p", { class: "empty" }, "In diesem Zeitraum gibt es noch keine Trainings."),
    statsInfo[1]);
}

/* ----- Workout auswählen (zum Starten und zum Nachtragen) ----- */

/** Liste der Workouts zum Antippen. Vorausgewählt ist das zuletzt verwendete
 *  Workout, sonst das zuletzt erstellte. onChange(workout) meldet jede Auswahl. */
function workoutChooser(workouts, onChange) {
  // Zuletzt verwendete zuerst; ohne Verwendung bleibt die Reihenfolge "neueste zuerst"
  const sorted = [...workouts].sort((a, b) =>
    (b.last_used_at ? Date.parse(b.last_used_at) : 0) - (a.last_used_at ? Date.parse(a.last_used_at) : 0));
  let selectedId = sorted[0].id;

  const options = sorted.map((w) => ({
    workout: w,
    label: h("label", { class: "choice" },
      h("input", { type: "radio", name: "workout", value: w.id, checked: w.id === selectedId, onchange: () => select(w.id) }),
      h("i", { class: "dot lg", style: `background: ${w.color}` }),
      h("span", { class: "choice-main" },
        h("strong", {}, w.name),
        h("span", { class: "muted small" },
          w.exercises.length ? plural(w.exercises.length, "Übung", "Übungen") : "Noch keine Übungen")),
      w.last_used_at
        ? h("span", { class: "muted small" }, "zuletzt " + new Date(w.last_used_at).toLocaleDateString("de-DE", { day: "numeric", month: "short" }))
        : null),
  }));

  function select(id) {
    selectedId = id;
    options.forEach((o) => o.label.classList.toggle("selected", o.workout.id === id));
    onChange(workouts.find((w) => w.id === id));
  }
  select(selectedId);

  return {
    element: h("div", { class: "sheet" }, options.map((o) => o.label)),
    get selectedId() { return selectedId; },
  };
}

/* ----- Training starten ----- */

async function renderStart() {
  if (state.session) { location.hash = "#/session"; return null; }

  const workouts = await Api.get("/api/workouts");
  const header = [backLink("#/", "Kalender"), h("h1", {}, "Workout starten")];
  if (!workouts.length) return [...header, ...noWorkoutsHint()];

  const startButton = h("button", {
    type: "button", class: "btn primary big",
    onclick: () => perform(async () => {
      await Api.post("/api/sessions", { workout_id: chooser.selectedId });
      location.hash = "#/session";
    }),
  }, "Training starten");
  const chooser = workoutChooser(workouts, (w) => { startButton.disabled = !w.exercises.length; });

  return [...header, chooser.element, h("div", { class: "start-bar" }, startButton)];
}

/* ----- Training nachtragen ----- */

async function renderBackfill() {
  const workouts = await Api.get("/api/workouts");
  const header = [backLink("#/", "Kalender"), h("h1", {}, "Training nachtragen")];
  if (!workouts.length) return [...header, ...noWorkoutsHint()];

  const today = dayKey(new Date());
  const dateInput = h("input", { type: "date", id: "backfill-date", value: today, max: today, required: true });
  const timeInput = h("input", { type: "time", id: "backfill-time", value: new Date().toTimeString().slice(0, 5), required: true });
  const submit = h("button", { type: "submit", class: "btn primary big" }, "Training anlegen");
  const chooser = workoutChooser(workouts, (w) => { submit.disabled = !w.exercises.length; });

  const form = h("form", {
    onsubmit: (event) => {
      event.preventDefault();
      perform(async () => {
        const session = await Api.post("/api/sessions/backfill", {
          workout_id: chooser.selectedId, date: dateInput.value, time: timeInput.value,
        });
        location.hash = `#/log/${session.id}`;
      });
    },
  },
    chooser.element,
    h("div", { class: "fields when" },
      h("div", { class: "field" }, h("label", { for: "backfill-date" }, "Datum"), dateInput),
      h("div", { class: "field" }, h("label", { for: "backfill-time" }, "Uhrzeit"), timeInput)),
    withInfo(h("span", { class: "muted small" }, "Wann war das Training?"),
      "Danach trägst du die Sätze wie im normalen Training ein. Alle Sätze erhalten die gewählte Uhrzeit."),
    h("div", { class: "start-bar" }, submit));

  return [...header, form];
}

/* ----- Übungsliste eines Trainings (laufend oder nachgetragen) ----- */

async function renderLiveSession() {
  if (!state.session) { location.hash = "#/"; return null; }
  return buildSessionPage(state.session);
}

async function renderLoggedSession(sessionId) {
  return buildSessionPage(await loadSession(sessionId));
}

function buildSessionPage(session) {
  const live = isLive(session);

  // Wie viele Sätze wurden pro Übung schon eingetragen?
  const counts = {};
  for (const set of session.sets) counts[set.exercise_id] = (counts[set.exercise_id] || 0) + 1;

  // Änderungen sind nur bei laufenden und nachgetragenen Trainings möglich
  const editable = live || session.backfilled;
  const move = (ex, direction) => perform(async () => {
    const updated = await Api.post(`/api/sessions/${session.id}/exercises/${ex.id}/move`, { direction });
    if (live) state.session = updated;
  });
  const link = (ex, linked) => perform(async () => {
    const updated = await Api.post(`/api/sessions/${session.id}/exercises/${ex.id}/link`, { linked });
    if (live) state.session = updated;
  });

  // Nummern: normale Übungen 1, 2, 3 ...; Supersatz-Übungen 2a, 2b ...
  const labels = [];
  let number = 0, letter = 0;
  session.exercises.forEach((ex, index) => {
    const joined = index > 0 && ex.superset != null && session.exercises[index - 1].superset === ex.superset;
    if (joined) letter += 1; else { number += 1; letter = 0; }
    const inSuperset = ex.superset != null;
    labels.push(inSuperset ? `${number}${String.fromCharCode(97 + letter)}` : String(number));
  });

  const finish = () => {
    const message = session.sets.length
      ? (live ? "Workout jetzt beenden?" : "Fertig mit dem Nachtragen?")
      : "Es wurde noch kein Satz eingetragen. Das Training wird verworfen. Fortfahren?";
    if (!confirm(message)) return;
    perform(async () => {
      await Api.post(`/api/sessions/${session.id}/finish`);
      location.hash = "#/";
    });
  };

  return [
    live ? null : backLink("#/", "Kalender"),
    h("h1", {}, session.workout_name),
    live ? null : h("p", { class: "muted" },
      `Nachgetragen für ${formatDay(dayKey(new Date(session.started_at)))}, ${formatTime(session.started_at)} Uhr`),
    session.exercises.length
      ? h("ol", { class: "exercise-list sheet" }, session.exercises.map((ex, index) => {
          const before = session.exercises[index - 1];
          const after = session.exercises[index + 1];
          const joinedBefore = Boolean(before) && ex.superset != null && before.superset === ex.superset;
          const joinedAfter = Boolean(after) && ex.superset != null && after.superset === ex.superset;
          return h("li", { class: "exercise-entry" + (ex.superset != null ? " superset" : "") + (joinedBefore ? " cont" : "") },
            h("div", { class: "exercise-item" },
              h("a", { class: "exercise-row", href: exerciseHref(session, ex.id) },
                h("span", { class: "no" }, labels[index]),
                h("span", { class: "name" }, ex.name),
                counts[ex.id]
                  ? h("span", { class: "chip" }, plural(counts[ex.id], "Satz", "Sätze"))
                  : h("span", { class: "chev" }, "›")),
              editable ? h("a", { class: "swap-link", href: `#/swap/${session.id}/${ex.id}`, "aria-label": `${ex.name} tauschen` }, "Tauschen") : null),
            editable && state.editOrder
              ? h("div", { class: "order-tools" },
                  h("button", { type: "button", class: "btn quiet", "aria-label": `${ex.name} nach oben`,
                    disabled: index === 0, onclick: () => move(ex, -1) }, "↑"),
                  h("button", { type: "button", class: "btn quiet", "aria-label": `${ex.name} nach unten`,
                    onclick: () => move(ex, 1) }, "↓"),
                  after ? h("button", { type: "button", class: "btn quiet", onclick: () => link(ex, !joinedAfter) },
                    joinedAfter ? "Superset trennen" : "Mit nächster als Superset") : null)
              : null);
        }))
      : h("p", { class: "empty" }, "Dieses Workout hat keine Übungen. Füge unten eine hinzu."),
    editable && session.exercises.length > 1
      ? h("p", { class: "add-link" }, h("button", { type: "button", class: "btn quiet",
          onclick: () => { state.editOrder = !state.editOrder; route(); } },
          state.editOrder ? "Fertig mit Sortieren" : "Reihenfolge & Supersätze ändern"))
      : null,
    editable ? h("p", { class: "add-link" }, h("a", { class: "btn quiet", href: `#/add/${session.id}` }, "Übung hinzufügen")) : null,
    h("div", { class: "finish" },
      h("button", { type: "button", class: live ? "btn" : "btn primary", onclick: finish },
        live ? "Workout beenden" : "Fertig")),
  ];
}

/* ----- Eine Übung: Sätze eintragen und Verlauf ansehen ----- */

async function renderLiveExercise(exerciseId) {
  if (!state.session) { location.hash = "#/"; return null; }
  return buildExercisePage(state.session, Number(exerciseId));
}

async function renderLoggedExercise(sessionId, exerciseId) {
  return buildExercisePage(await loadSession(sessionId), Number(exerciseId));
}

async function buildExercisePage(session, exerciseId) {
  const exercise = session.exercises.find((e) => e.id === exerciseId);
  if (!exercise) { location.hash = sessionHref(session); return null; }

  // Verlauf dieser Übung aus ALLEN Workouts, neueste Sätze zuerst
  const history = await Api.get(`/api/exercises/${exercise.id}/history`);
  const doneHere = history.filter((s) => s.session_id === session.id).length;
  const previous = history[0];                  // letzter Satz: dient als Vorgabe im Formular

  // --- Formular für den nächsten Satz ---
  const reps = h("input", {
    type: "number", id: "field-reps", inputmode: "numeric", min: 1, max: 1000, step: 1,
    required: true, value: previous ? previous.reps : null,
  });
  const weight = h("input", {
    type: "number", id: "field-weight", inputmode: "decimal", min: 0, max: 1000, step: "any",
    value: previous && !(previous.bodyweight && previous.weight === 0) ? previous.weight : null,
  });
  const bodyweight = h("input", {
    type: "checkbox", id: "field-bodyweight", checked: Boolean(previous && previous.bodyweight),
    onchange: syncWeightField,
  });
  const weightLabel = h("label", { for: "field-weight" });
  const note = h("input", {
    type: "text", id: "field-note", maxlength: 200, autocomplete: "off",
    placeholder: "Anmerkung (optional)", "aria-label": "Anmerkung zum Satz",
  });
  const saveButton = h("button", { type: "submit", class: "btn primary" }, "Satz speichern");

  /** Bei "Körpergewicht" wird aus dem Gewicht ein optionales Zusatzgewicht. */
  function syncWeightField() {
    weightLabel.textContent = bodyweight.checked ? "Zusatzgewicht in kg (optional)" : "Gewicht in kg";
    weight.required = !bodyweight.checked;
  }
  syncWeightField();

  const form = h("form", {
    class: "set-panel",
    onsubmit: (event) => {
      event.preventDefault();
      saveButton.disabled = true;
      perform(() => Api.post(`/api/sessions/${session.id}/sets`, {
        exercise_id: exercise.id,
        reps: Number(reps.value),
        weight: Number(weight.value) || 0,
        bodyweight: bodyweight.checked,
        note: note.value.trim() || null,
      })).finally(() => { saveButton.disabled = false; });
    },
  },
    h("h2", {}, `Satz ${doneHere + 1}`),
    h("div", { class: "fields" },
      numberField(h("label", { for: "field-reps" }, "Wiederholungen"), reps, [-1, 1], 1, "Wiederholungen"),
      numberField(weightLabel, weight, [2.5, 5, 10, -2.5, -5, -10], 0, "Gewicht")),
    h("label", { class: "check" }, bodyweight, "Körpergewicht (z. B. Klimmzüge)"),
    note,
    saveButton);

  return [
    backLink(sessionHref(session), "Übungen"),
    h("div", { class: "title-row" },
      h("h1", {}, exercise.name),
      h("a", { class: "btn quiet", href: `#/swap/${session.id}/${exercise.id}` }, "Übung tauschen")),
    exercise.image_url ? h("img", { class: "hero", src: exercise.image_url, alt: exercise.name }) : null,
    buildProgressionHint(history),
    form,
    buildProgressChart(history),
    buildHistory(history, session),
  ];
}

/** Hinweis "Gewicht erhöhen": Waren bei den letzten 5 Trainings (alle innerhalb von 60 Tagen) die
 *  schwersten Sätze unverändert (gleiches Gewicht und gleiche Wiederholungszahl), wird eine
 *  Steigerung empfohlen. Wie viele Sätze verglichen werden, richtet sich nach den Trainings selbst:
 *  Es zählt die kleinste Satzzahl dieser 5 Trainings (immer 1 Satz: ein Satz, mal 3 und mal 5: die
 *  schwersten 3). Schwerster Satz = höchstes Gewicht, bei Gleichstand mehr Wiederholungen.
 *  Reine Körpergewichtsübungen (Gewicht 0) bekommen keinen Hinweis. */
function buildProgressionHint(history) {
  const NEEDED = 5, DAYS = 60;
  const trainings = Object.values(groupBy(history, (s) => s.session_id)).map((sets) => ({
    sorted: [...sets].sort((a, b) => b.weight - a.weight || b.reps - a.reps),      // schwerster Satz zuerst
    at: Math.max(...sets.map((s) => new Date(s.logged_at).getTime())),
  })).sort((a, b) => b.at - a.at);                                                  // neuestes Training zuerst

  const last = trainings.slice(0, NEEDED);
  if (last.length < NEEDED) return null;
  const count = Math.min(...last.map((t) => t.sorted.length));                      // so viele Sätze werden verglichen
  const keyOf = (t) => t.sorted.slice(0, count).map((s) => `${s.weight}x${s.reps}`).join("|");
  const same = last.every((t) => t.sorted[0].weight > 0 && keyOf(t) === keyOf(last[0]));
  const recent = Date.now() - last[NEEDED - 1].at <= DAYS * 24 * 60 * 60 * 1000;
  if (!same || !recent) return null;

  const shown = last[0].sorted.slice(0, count).map((s) => `${numberFormat.format(s.weight)} kg × ${s.reps}`).join(", ");
  return h("p", { class: "progress-hint", role: "note" },
    h("strong", {}, "Zeit für mehr Gewicht? "),
    `Bei den letzten ${NEEDED} Trainings ${count === 1 ? "war dein schwerster Satz" : `waren deine ${count} schwersten Sätze`} `
    + `immer gleich: ${shown}. Probiere diesmal eine kleine Steigerung.`);
}

/** Zahlenfeld mit Tasten für feste Schritte (gut mit nassen Fingern zu treffen).
 *  amounts: die Schritte in der Reihenfolge der Tasten, z. B. [-1, 1] oder [2.5, 5, 10, -2.5, -5, -10].
 *  Alle Tasten sind gleichwertig; bei mehr als zwei Tasten stehen sie in zwei Reihen. */
function numberField(labelElement, input, amounts, min, name) {
  const MAX = 1000;
  const change = (amount) => {
    const next = (Number(input.value) || 0) + amount;
    input.value = Math.min(MAX, Math.max(min, Math.round(next * 100) / 100));
    input.classList.add("changed");                              // kurzes Aufleuchten als Rückmeldung
    setTimeout(() => input.classList.remove("changed"), 220);
  };
  // Beschriftung mit Vorzeichen und deutschem Komma: "+2,5", "−10"
  // (bei nur zwei Tasten, z. B. Wiederholungen, genügt "−" und "+")
  const caption = (amount) => `${amount > 0 ? "+" : "−"}${amounts.length > 2 ? numberFormat.format(Math.abs(amount)) : ""}`;

  return h("div", { class: "field" },
    labelElement,
    input,
    h("div", { class: "step-buttons", style: `grid-template-columns: repeat(${amounts.length > 2 ? Math.ceil(amounts.length / 2) : 2}, minmax(0, 1fr))` },
      amounts.map((amount) => h("button", {
        type: "button", class: "step" + (amounts.length > 2 ? " small" : ""),
        "aria-label": `${name} ${amount > 0 ? "plus" : "minus"} ${numberFormat.format(Math.abs(amount))}`,
        onclick: () => change(amount),
      }, caption(amount)))));
}

/** Fortschrittsdiagramm einer Übung: pro Trainingstag der beste Wert.
 *  Meist das höchste Gewicht; bei reinen Körpergewichtsübungen die meisten
 *  Wiederholungen. Erst ab zwei Trainingstagen sinnvoll, sonst kein Diagramm. */
function buildProgressChart(history) {
  const byDay = groupBy(history, (s) => dayKey(new Date(s.logged_at)));
  const days = Object.keys(byDay).sort();                     // älteste zuerst (links)
  if (days.length < 2) return null;

  const useWeight = history.some((s) => s.weight > 0);
  const valueOf = (set) => (useWeight ? set.weight : set.reps);
  const points = days.map((key) => ({ key, value: Math.max(...byDay[key].map(valueOf)) }));

  const W = 320, H = 150, left = 40, right = 12, top = 14, bottom = 28;
  const low = Math.min(...points.map((p) => p.value));
  const high = Math.max(...points.map((p) => p.value));
  const span = high - low || 1;                               // alle Werte gleich: Linie in der Mitte
  const x = (i) => left + (i * (W - left - right)) / (points.length - 1);
  const y = (v) => (high === low ? (top + H - bottom) / 2 : H - bottom - ((v - low) / span) * (H - top - bottom));
  const shortDay = (key) => { const [, m, d] = key.split("-"); return `${d}.${m}.`; };
  const label = (text, attrs) => { const el = svg("text", { class: "chart-label", ...attrs }); el.textContent = text; return el; };

  const best = points.reduce((a, b) => (b.value >= a.value ? b : a));
  const unit = useWeight ? "kg" : "Wdh.";
  return h("section", { class: "progress", "aria-label": "Fortschritt" },
    h("h3", {}, useWeight ? "Fortschritt: bestes Gewicht pro Tag" : "Fortschritt: meiste Wiederholungen pro Tag"),
    svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img",
        "aria-label": `Bestwert ${numberFormat.format(best.value)} ${unit} am ${shortDay(best.key)}` },
      svg("line", { class: "chart-grid", x1: left, x2: W - right, y1: y(high), y2: y(high) }),
      svg("line", { class: "chart-grid", x1: left, x2: W - right, y1: y(low), y2: y(low) }),
      label(numberFormat.format(high), { x: left - 6, y: y(high) + 4, "text-anchor": "end" }),
      high === low ? null : label(numberFormat.format(low), { x: left - 6, y: y(low) + 4, "text-anchor": "end" }),
      svg("polyline", { class: "chart-line", points: points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ") }),
      points.map((p, i) => svg("circle", { class: "chart-dot", cx: x(i), cy: y(p.value), r: 4 })),
      label(shortDay(points[0].key), { x: left, y: H - 8, "text-anchor": "start" }),
      label(shortDay(points[points.length - 1].key), { x: W - right, y: H - 8, "text-anchor": "end" })),
    h("p", { class: "muted small" }, `Bestwert: ${numberFormat.format(best.value)} ${unit} (${shortDay(best.key)})`));
}

/** Alle bisherigen Sätze einer Übung, nach Datum gruppiert. Neuestes Datum und
 *  neuester Satz stehen oben, damit man möglichst wenig scrollen muss. */
function buildHistory(history, session) {
  if (!history.length) return null;

  const todayKey = dayKey(new Date());
  const groups = groupBy(history, (s) => dayKey(new Date(s.logged_at)));   // Server liefert neueste zuerst
  const days = Object.keys(groups).sort().reverse();

  const removeSet = (set) => {
    // Sätze aus früheren Trainings nur nach Rückfrage löschen
    if (set.session_id !== session.id && !confirm("Diesen Satz aus einem früheren Training löschen?")) return;
    perform(() => Api.delete(`/api/sessions/${set.session_id}/sets/${set.id}`));
  };

  return h("section", { class: "history", "aria-label": "Bisherige Sätze" },
    days.map((key) => {
      const sets = groups[key];
      return h("div", { class: "history-day" },
        h("div", { class: "history-head" },
          key === todayKey ? h("span", { class: "today-tag" }, "Heute") : null,
          h("h3", {}, formatDay(key))),
        h("div", { class: "sheet" }, sets.map((set, index) =>
          h("div", { class: "row set-row" },
            h("span", { class: "no" }, `Satz ${sets.length - index}`),
            h("span", { class: "result-block" },
              h("span", { class: "result" }, formatSet(set)),
              set.note ? h("span", { class: "note" }, set.note) : null),
            h("span", { class: "time" }, formatTime(set.logged_at)),
            h("button", { type: "button", class: "icon-x", "aria-label": "Satz löschen", onclick: () => removeSet(set) }, "✕")))));
    }));
}

/* ----- Übung spontan tauschen ----- */

/* ----- Muskelgruppen zuordnen ----- */

async function renderMuscles() {
  const [library, groups] = await Promise.all([Api.get("/api/exercises"), Api.get("/api/muscles")]);
  const custom = groups.filter((g) => g.custom);
  const ownExercises = library.filter((ex) => !ex.preset);        // Vorauswahl-Übungen noch nicht zuordnen

  const nameInput = h("input", {
    type: "text", maxlength: 30, required: true, autocomplete: "off",
    placeholder: "Neue Muskelgruppe, z. B. Hüftbeuger", "aria-label": "Name der neuen Muskelgruppe",
  });

  return [
    backLink("#/", "Kalender"),
    h("h1", {}, "Muskelgruppen"),

    withInfo(h("h2", {}, "Übungen bearbeiten"),
      "Ordne jede Übung ihrer Hauptmuskelgruppe zu. Die Auswertung auf der Startseite nutzt das. "
      + "Mit „Ändern“ passt du Bezeichnung und Bild einer Übung an."),
    ownExercises.length
      ? h("div", { class: "sheet" }, ownExercises.map((ex) => h("div", { class: "row edit-row" },
          h("span", { class: "grow" }, ex.name),
          muscleSelector(ex.muscle, (muscle) => perform(() => Api.patch(`/api/exercises/${ex.id}`, { muscle }))),
          h("a", { class: "btn quiet", href: `#/edit/${ex.id}`, "aria-label": `${ex.name} ändern` }, "Ändern"))))
      : h("p", { class: "empty" }, "Es gibt noch keine Übungen."),

    h("h2", {}, "Eigene Muskelgruppen"),
    h("form", {
      class: "inline-form",
      onsubmit: (event) => {
        event.preventDefault();
        perform(() => Api.post("/api/muscles", { name: nameInput.value }));
      },
    }, nameInput, h("button", { type: "submit", class: "btn primary" }, "Hinzufügen")),
    custom.length
      ? h("div", { class: "sheet" }, custom.map((g) => h("div", { class: "row" },
          h("span", { class: "grow" }, g.name),
          h("button", {
            type: "button", class: "btn quiet danger",
            onclick: () => confirm(`Muskelgruppe „${g.name}“ löschen? Zugeordnete Übungen sind danach wieder ohne Zuordnung.`)
              && perform(() => Api.delete(`/api/muscles/${g.id}`)),
          }, "Löschen"))))
      : h("p", { class: "muted small" }, "Noch keine eigenen Gruppen. Die festen Gruppen lassen sich nicht ändern."),
  ];
}

/* ----- Übung bearbeiten: Bezeichnung und Bild ----- */

async function renderEditExercise(exerciseId) {
  const library = await Api.get("/api/exercises");
  const exercise = library.find((ex) => ex.id === Number(exerciseId));
  if (!exercise) { location.hash = "#/muscles"; return null; }

  let newImage = null;                 // neu gewähltes Bild (verkleinert)
  let removeImage = false;             // vorhandenes Bild entfernen?

  const nameInput = h("input", {
    type: "text", maxlength: 80, required: true, autocomplete: "off",
    value: exercise.name, "aria-label": "Bezeichnung der Übung",
  });
  const preview = h("img", { class: "thumb", alt: "Bild der Übung", hidden: !exercise.image_url, src: exercise.image_url || "" });
  const fileInput = h("input", {
    type: "file", accept: "image/*", hidden: true,
    onchange: async () => {
      if (!fileInput.files[0]) return;
      try {
        newImage = await resizeImage(fileInput.files[0]);
        removeImage = false;
        preview.src = newImage;
        preview.hidden = false;
        removeButton.hidden = false;
        pickButton.textContent = "Bild ändern";
      } catch (error) {
        toast(error.message);
      }
    },
  });
  const pickButton = h("button", { type: "button", class: "btn", onclick: () => fileInput.click() },
    exercise.image_url ? "Bild ändern" : "Bild wählen");
  const removeButton = h("button", {
    type: "button", class: "btn quiet danger", hidden: !exercise.image_url,
    onclick: () => {
      newImage = null; removeImage = true;
      preview.hidden = true; removeButton.hidden = true;
    },
  }, "Bild entfernen");

  return [
    backLink("#/muscles", "Muskelgruppen"),
    h("h1", {}, "Übung ändern"),
    h("form", {
      class: "add-exercise",
      onsubmit: (event) => {
        event.preventDefault();
        const changes = { name: nameInput.value };
        if (newImage) changes.image = newImage;
        else if (removeImage) changes.remove_image = true;
        perform(async () => {
          await Api.patch(`/api/exercises/${exercise.id}`, changes);
          location.hash = "#/muscles";
        });
      },
    },
      h("label", { class: "muscle-field" }, h("span", { class: "muted small" }, "Bezeichnung"), nameInput),
      h("div", { class: "actions" }, pickButton, removeButton, preview, fileInput),
      h("button", { type: "submit", class: "btn primary" }, "Speichern")),
  ];
}

/* ----- Übung nachträglich zu einem Training hinzufügen ----- */

async function renderAddExercise(sessionId) {
  const session = await loadSession(sessionId);
  const library = await Api.get("/api/exercises");
  const picker = buildExercisePicker({
    library,
    excludeIds: session.exercises.map((e) => e.id),    // schon vorhandene nicht anbieten
    submitLabel: "Übung hinzufügen",
    onSubmit: (choice) => perform(async () => {
      await Api.post(`/api/sessions/${session.id}/exercises`, choice);
      state.session = state.session && state.session.id === session.id
        ? await Api.get("/api/sessions/active") : state.session;
      location.hash = sessionHref(session);
    }),
  });
  return [
    backLink(sessionHref(session), "Übungen"),
    withInfo(h("h1", {}, "Übung hinzufügen"),
      "Die Übung wird nur zu diesem Training hinzugefügt. Das Workout selbst bleibt unverändert."),
    h("div", { class: "sheet" }, picker),
  ];
}

async function renderSwap(sessionId, exerciseId) {
  const session = await loadSession(sessionId);
  const exerciseKey = Number(exerciseId);
  const current = session.exercises.find((e) => e.id === exerciseKey);
  if (!current) { location.hash = sessionHref(session); return null; }

  const header = [
    backLink(sessionHref(session), "Übungen"),
    h("h1", {}, "Übung tauschen"),
    withInfo(h("p", { class: "muted" }, `Statt „${current.name}“.`),
      "Die Übung wird nur in diesem Training getauscht. Die anderen Übungen und das Workout selbst bleiben unverändert."),
  ];

  if (session.sets.some((s) => s.exercise_id === exerciseKey)) {
    return [...header, h("p", { class: "empty" },
      "Für diese Übung sind in diesem Training schon Sätze eingetragen. Lösche sie zuerst auf der Übungsseite, wenn du die Übung tauschen möchtest.")];
  }

  const library = await Api.get("/api/exercises");
  const picker = buildExercisePicker({
    library,
    excludeIds: session.exercises.map((e) => e.id),    // schon im Training vorhandene nicht anbieten
    submitLabel: "Übung ersetzen",
    onSubmit: (choice) => perform(async () => {
      await Api.post(`/api/sessions/${session.id}/exercises/${exerciseKey}/replace`, choice);
      location.hash = sessionHref(session);
    }),
  });
  return [...header, h("div", { class: "sheet" }, picker)];
}

/* ----- Workouts und Übungen verwalten ----- */

async function renderManage() {
  const [workouts, library] = await Promise.all([Api.get("/api/workouts"), Api.get("/api/exercises")]);

  const nameInput = h("input", {
    type: "text", maxlength: 60, required: true,
    placeholder: "Name, z. B. Push-Tag", "aria-label": "Name des neuen Workouts",
  });
  const createForm = h("form", {
    class: "inline-form",
    onsubmit: (event) => {
      event.preventDefault();
      perform(() => Api.post("/api/workouts", { name: nameInput.value }));
    },
  }, nameInput, h("button", { type: "submit", class: "btn primary" }, "Workout anlegen"));

  return [
    backLink("#/", "Kalender"),
    h("h1", {}, "Workouts verwalten"),
    createForm,
    workouts.length ? null : h("p", { class: "empty" }, "Noch keine Workouts. Lege oben dein erstes an."),
    workouts.map((workout) =>
      h("section", { class: "workout" },
        h("div", { class: "workout-head" },
          h("i", { class: "dot lg", style: `background: ${workout.color}` }),
          h("h2", {}, workout.name),
          h("button", {
            type: "button", class: "btn quiet",
            onclick: () => {
              const name = prompt("Neuer Name für das Workout:", workout.name)?.trim();
              if (name && name !== workout.name) perform(() => Api.patch(`/api/workouts/${workout.id}`, { name }));
            },
          }, "Umbenennen"),
          h("button", {
            type: "button", class: "btn quiet danger",
            onclick: () => confirm(`Workout „${workout.name}“ löschen? Bisherige Trainings bleiben im Kalender erhalten.`)
              && perform(() => Api.delete(`/api/workouts/${workout.id}`)),
          }, "Löschen")),
        h("div", { class: "sheet" },
          workout.exercises.length
            ? workout.exercises.map((ex, index) =>
                h("div", { class: "row" },
                  ex.image_url ? h("img", { class: "thumb", src: ex.image_url, alt: "", loading: "lazy" }) : null,
                  h("span", { class: "grow" }, ex.name),
                  moveButton(workout, ex, -1, index === 0),
                  moveButton(workout, ex, 1, index === workout.exercises.length - 1),
                  h("button", {
                    type: "button", class: "icon-x", "aria-label": `${ex.name} aus dem Workout entfernen`,
                    onclick: () => perform(() => Api.delete(`/api/workouts/${workout.id}/exercises/${ex.id}`)),
                  }, "✕")))
            : h("p", { class: "empty" }, "Noch keine Übungen."),
          buildExercisePicker({
            library,
            excludeIds: workout.exercises.map((e) => e.id),
            submitLabel: "Übung hinzufügen",
            onSubmit: (choice) => perform(() => Api.post(`/api/workouts/${workout.id}/exercises`, choice)),
          })))),
  ];
}

/** Pfeil-Knopf, der eine Übung im Workout nach oben (-1) oder unten (1) schiebt. */
function moveButton(workout, exercise, direction, disabled) {
  return h("button", {
    type: "button", class: "icon-x", disabled,
    "aria-label": `${exercise.name} nach ${direction < 0 ? "oben" : "unten"} schieben`,
    onclick: () => perform(() => Api.post(`/api/workouts/${workout.id}/exercises/${exercise.id}/move`, { direction })),
  }, direction < 0 ? "↑" : "↓");
}

/** Eingabe einer Übung mit Vorschlägen. Mit jedem getippten Zeichen werden die
 *  bereits bekannten Übungen darunter passend gefiltert ("Ba" -> "Bankdrücken").
 *  Tippt man auf einen Vorschlag, wird genau diese Übung verwendet. Ein neuer
 *  Name (mit optionalem Bild) legt eine neue Übung an.
 *  onSubmit bekommt { exercise_id } oder { name, image }. */
// Namen aller wählbaren Muskelgruppen (wird vor jeder Ansicht aktualisiert)
let muscleNames = [];

/** Auswahlfeld für die Muskelgruppe. current = bisherige Gruppe oder null. */
function muscleSelector(current, onChange) {
  const select = h("select", { "aria-label": "Muskelgruppe", onchange: () => onChange?.(select.value || null) },
    h("option", { value: "" }, "keine Zuordnung"),
    muscleNames.map((name) => h("option", { value: name }, name)));
  select.value = current || "";
  return select;
}

function buildExercisePicker({ library, excludeIds, submitLabel, onSubmit }) {
  let imageData = null;                         // das gewählte, verkleinerte Bild
  const candidates = library.filter((ex) => !excludeIds.includes(ex.id));

  const nameInput = h("input", {
    type: "text", maxlength: 80, autocomplete: "off",
    placeholder: "Übung suchen oder neu eingeben", "aria-label": "Name der Übung",
    oninput: refresh,
  });
  const hint = h("p", { class: "muted small" });
  const list = h("div", { class: "suggestions", role: "list" });

  // Muskelgruppe für neue Übungen. Wird aus dem Namen vorgeschlagen, solange man nicht selbst wählt.
  let muscleTouched = false;
  const muscleSelect = muscleSelector(null, () => { muscleTouched = true; });

  /** Zeigt zu den eingetippten Buchstaben die passenden bekannten Übungen. */
  function refresh() {
    const query = nameInput.value.trim().toLowerCase();
    const startsWith = (ex) => Number(ex.name.toLowerCase().startsWith(query));
    const matches = candidates
      .filter((ex) => ex.name.toLowerCase().includes(query))
      .sort((a, b) => startsWith(b) - startsWith(a));         // Treffer am Wortanfang zuerst

    if (!muscleTouched) muscleSelect.value = MuscleGuesser.guess(nameInput.value) || "";

    list.replaceChildren(...matches.map((ex) =>
      h("button", {
        type: "button", class: "suggestion", role: "listitem",
        // Vorauswahl-Übungen gibt es noch nicht in der Bibliothek: sie werden mit ihrer Muskelgruppe neu angelegt
        onclick: () => onSubmit(ex.preset ? { name: ex.name, muscle: ex.muscle } : { exercise_id: ex.id }),
      }, ex.image_url ? h("img", { class: "mini", src: ex.image_url, alt: "", loading: "lazy" }) : null, ex.name)));
    list.hidden = !matches.length;

    if (!candidates.length) hint.textContent = "";
    else if (query && !matches.length) hint.textContent = `„${nameInput.value.trim()}“ ist neu und wird angelegt.`;
    else hint.textContent = "Vorschläge und angelegte Übungen: antippen, um sie zu verwenden.";
  }

  const preview = h("img", { class: "thumb", alt: "Vorschau", hidden: true });
  const fileInput = h("input", {
    type: "file", accept: "image/*", hidden: true,
    onchange: async () => {
      if (!fileInput.files[0]) return;
      try {
        imageData = await resizeImage(fileInput.files[0]);
        preview.src = imageData;
        preview.hidden = false;
        pickButton.textContent = "Bild ändern";
      } catch (error) {
        toast(error.message);
      }
    },
  });
  const pickButton = h("button", { type: "button", class: "btn", onclick: () => fileInput.click() }, "Bild wählen");

  const form = h("form", {
    class: "add-exercise",
    onsubmit: (event) => {
      event.preventDefault();
      onSubmit({ name: nameInput.value, image: imageData, muscle: muscleSelect.value || null });
    },
  },
    nameInput, hint, list,
    h("label", { class: "muscle-field" }, h("span", { class: "muted small" }, "Muskelgruppe (für neue Übungen)"), muscleSelect),
    h("div", { class: "actions" },
      pickButton, preview, fileInput,
      h("button", { type: "submit", class: "btn primary" }, submitLabel)));
  refresh();
  return form;
}


/* ---------------------------------------------------------------------
   5. Router: Adresse (#/...) -> Ansicht
   --------------------------------------------------------------------- */

const routes = [
  [/^#\/?$/, renderHome],
  [/^#\/start$/, renderStart],
  [/^#\/backfill$/, renderBackfill],
  [/^#\/manage$/, renderManage],
  [/^#\/session$/, renderLiveSession],
  [/^#\/exercise\/(\d+)$/, renderLiveExercise],
  [/^#\/log\/(\d+)$/, renderLoggedSession],
  [/^#\/log\/(\d+)\/exercise\/(\d+)$/, renderLoggedExercise],
  [/^#\/swap\/(\d+)\/(\d+)$/, renderSwap],
  [/^#\/add\/(\d+)$/, renderAddExercise],
  [/^#\/muscles$/, renderMuscles],
  [/^#\/edit\/(\d+)$/, renderEditExercise],
];

let renderId = 0;   // verhindert, dass eine langsame alte Ansicht eine neuere überschreibt

async function route() {
  const id = ++renderId;
  try {
    state.session = await Api.get("/api/sessions/active");
    muscleNames = (await Api.get("/api/muscles")).map((m) => m.name);
    Timers.update();

    const hash = location.hash || "#/";
    for (const [pattern, view] of routes) {
      const match = hash.match(pattern);
      if (!match) continue;
      const nodes = await view(...match.slice(1));
      if (id === renderId && nodes) $view.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
      return;
    }
    location.hash = "#/";                    // unbekannte Adresse: zur Startseite
  } catch (error) {
    if (id !== renderId) return;
    $view.replaceChildren(h("p", { class: "empty" }, error.message));
  }
}

window.addEventListener("hashchange", () => { window.scrollTo(0, 0); route(); });
setInterval(() => Timers.update(), 1000);
route();

// Service Worker: speichert die App-Dateien, damit sie auch ohne Internet startet
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* ohne Offline-Start weiter nutzbar */ });
}

// Zoomen ausschalten: Die App soll sich beim Training nicht versehentlich vergrößern.
// Doppeltippen verhindert "touch-action" in der style.css, das Auseinanderziehen mit zwei Fingern
// blockieren wir hier (iOS meldet es als "gesture"-Ereignis).
for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(type, (event) => event.preventDefault());
}
