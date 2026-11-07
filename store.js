"use strict";

/* =====================================================================
   Trainingstagebuch – Datenhaltung direkt auf dem Gerät
   Hier steckt alles, was früher der Python-Server gemacht hat. Die Daten
   liegen in der IndexedDB des Browsers (also nur auf diesem Handy). Es gibt
   keinen Server, nichts wird über das Internet geschickt.

   Aufbau dieser Datei:
     1. Fehler und Hilfsfunktionen
     2. Images          prüft Bilder (Art, Größe, Dateikopf)
     3. Database        speichert alle Tabellen im Browser
     4. ExerciseLibrary, WorkoutStore, SessionStore   die Fachlogik
     5. Backup          Sicherung als Datei speichern und wieder einlesen
     6. LocalServer     verteilt die Anfragen der Oberfläche an die Klassen
   ===================================================================== */


/* ---------------------------------------------------------------------
   1. Fehler und Hilfsfunktionen
   --------------------------------------------------------------------- */

/** Ein Fehler mit lesbarer Meldung. Der Status entspricht den HTTP-Zahlen der
 *  früheren Server-Version (404 = nicht gefunden, 409 = passt gerade nicht,
 *  422 = ungültige Eingabe, 500 = Speicherproblem). */
class AppError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
const notFound = (message) => new AppError(message, 404);
const conflict = (message) => new AppError(message, 409);
const invalid = (message = "Bitte die Eingaben prüfen.") => new AppError(message, 422);

const pad2 = (n) => String(n).padStart(2, "0");

/** Zeitpunkt als Text mit Zeitzone, z. B. "2026-11-07T10:35:00+01:00". */
function localIso(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = pad2(Math.floor(Math.abs(offset) / 60));
  const minutes = pad2(Math.abs(offset) % 60);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${sign}${hours}:${minutes}`;
}
const nowIso = () => localIso(new Date());

/** Zum Vergleichen von Namen: Groß-/Kleinschreibung egal ("bankdrücken" = "Bankdrücken"). */
const normalizeName = (text) => text.trim().normalize("NFC").toLowerCase().replace(/ß/g, "ss");

const timeOf = (iso) => Date.parse(iso);
const isPlainText = (value, max) => typeof value === "string" && value.trim().length >= 1 && value.trim().length <= max;


/* ---------------------------------------------------------------------
   2. Images: Bilder prüfen
   --------------------------------------------------------------------- */

class Images {
  static MAX_BYTES = 5 * 1024 * 1024;

  /** Prüft ein Bild im Format "data:image/jpeg;base64,...": erlaubte Art,
   *  Größe und ob die ersten Bytes wirklich zu dieser Art passen. */
  static check(dataUrl) {
    if (typeof dataUrl !== "string") throw invalid("Das Bildformat wird nicht unterstützt.");
    const comma = dataUrl.indexOf(",");
    const header = dataUrl.slice(0, comma);
    const payload = dataUrl.slice(comma + 1);
    const match = /^data:(image\/(?:jpeg|png|webp));base64$/.exec(header);
    if (comma < 0 || !match) throw invalid("Erlaubt sind nur JPG-, PNG- und WebP-Bilder.");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 !== 0) {
      throw invalid("Das Bild konnte nicht gelesen werden.");
    }
    if (Math.floor(payload.length * 3 / 4) > Images.MAX_BYTES) throw invalid("Das Bild ist zu groß (maximal 5 MB).");

    const head = atob(payload.slice(0, 16));          // die ersten 12 Bytes
    const ok = {
      "image/jpeg": head.startsWith("\xff\xd8\xff"),
      "image/png": head.startsWith("\x89PNG\r\n\x1a\n"),
      "image/webp": head.startsWith("RIFF") && head.slice(8, 12) === "WEBP",
    }[match[1]];
    if (!ok) throw invalid("Das Bild konnte nicht gelesen werden.");
    return dataUrl;
  }
}


/* ---------------------------------------------------------------------
   3. Database: alle Tabellen im Browser-Speicher
   Die Daten werden beim Start in den Arbeitsspeicher geladen. Jede Änderung
   wird danach sofort als Ganzes in die IndexedDB geschrieben (in einem
   einzigen Schritt: entweder komplett gespeichert oder gar nicht).
   Bilder liegen getrennt, damit nicht bei jedem Satz alle Fotos neu
   geschrieben werden.
   --------------------------------------------------------------------- */

class Database {
  static NAME = "trainingstagebuch";
  static TABLES = ["workouts", "exercises", "workout_exercises", "sessions", "session_exercises", "set_entries"];

  constructor() {
    this.tables = Database.emptyTables();
    this.images = {};               // Übungs-Id -> Bild als Data-URL
    this.meta = {};                 // z. B. Zeitpunkt der letzten Sicherung
    this.dirtyImages = new Set();   // Bilder, die beim nächsten Speichern geschrieben werden
    this.idb = null;
  }

  static emptyTables() {
    const tables = { counters: {} };
    for (const name of Database.TABLES) tables[name] = [];
    return tables;
  }

  /** Öffnet den Speicher und lädt alle Daten. */
  async open() {
    this.idb = await new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new AppError("Der Speicher auf diesem Gerät ist nicht verfügbar.", 500));
      const request = indexedDB.open(Database.NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("kv");
        request.result.createObjectStore("images");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new AppError("Der Speicher auf diesem Gerät ist nicht verfügbar.", 500));
    });
    await this.load();
    // Bitte den Browser, die Daten nicht von selbst zu löschen (wird nicht überall gewährt)
    try { await navigator.storage?.persist?.(); } catch { /* nicht schlimm */ }
  }

  /** Liest den gespeicherten Stand neu ein (auch zum Zurücksetzen nach einem Fehler). */
  async load() {
    const read = await new Promise((resolve, reject) => {
      const tx = this.idb.transaction(["kv", "images"], "readonly");
      const tables = tx.objectStore("kv").get("tables");
      const meta = tx.objectStore("kv").get("meta");
      const keys = tx.objectStore("images").getAllKeys();
      const values = tx.objectStore("images").getAll();
      tx.oncomplete = () => resolve({ tables: tables.result, meta: meta.result, keys: keys.result, values: values.result });
      tx.onerror = tx.onabort = () => reject(new AppError("Der Speicher konnte nicht gelesen werden.", 500));
    });
    this.tables = Object.assign(Database.emptyTables(), read.tables || {});
    this.meta = read.meta || {};
    this.images = Object.fromEntries(read.keys.map((key, i) => [key, read.values[i]]));
    this.dirtyImages.clear();
  }

  /** Vergibt die nächste freie Nummer einer Tabelle (Nummern werden nie doppelt vergeben). */
  nextId(table) {
    const id = this.tables.counters[table] || 1;
    this.tables.counters[table] = id + 1;
    return id;
  }

  setImage(exerciseId, dataUrl) {
    this.images[exerciseId] = dataUrl;
    this.dirtyImages.add(exerciseId);
  }

  /** Speichert den aktuellen Stand. Schlägt es fehl, wird der zuletzt
   *  gespeicherte Stand wieder geladen, damit nichts halb Gespeichertes übrig bleibt. */
  async persist() {
    try {
      await new Promise((resolve, reject) => {
        const tx = this.idb.transaction(["kv", "images"], "readwrite");
        tx.objectStore("kv").put(this.tables, "tables");
        tx.objectStore("kv").put(this.meta, "meta");
        const images = tx.objectStore("images");
        for (const id of this.dirtyImages) {
          if (this.images[id]) images.put(this.images[id], id);
          else images.delete(id);
        }
        this.dirtyImages.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () =>
          reject(new AppError("Speichern nicht möglich. Ist der Speicher des Geräts voll?", 500));
      });
    } catch (error) {
      await this.load();
      throw error;
    }
  }

  /** Ersetzt den gesamten Inhalt (beim Einlesen einer Sicherung). */
  async replaceAll(tables, images, meta) {
    for (const id of Object.keys(this.images)) this.dirtyImages.add(Number(id));
    this.tables = tables;
    this.images = images;
    this.meta = meta;
    for (const id of Object.keys(images)) this.dirtyImages.add(Number(id));
    await this.persist();
  }
}


/* ---------------------------------------------------------------------
   4. Fachlogik
   --------------------------------------------------------------------- */

/** Die Bibliothek aller Übungen: Jede Übung gibt es nur einmal, egal in wie
 *  vielen Workouts sie vorkommt. Dadurch gehören Sätze und Verlauf zur Übung selbst. */
class ExerciseLibrary {
  constructor(db) {
    this.db = db;
  }

  toExercise(row) {
    return { id: row.id, name: row.name, image_url: this.db.images[row.id] || null };
  }

  /** Alle bekannten Übungen, alphabetisch (für die Vorschläge beim Eintippen). */
  getAll() {
    return [...this.db.tables.exercises]
      .sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }))
      .map((row) => this.toExercise(row));
  }

  /** Prüft die Eingabe: entweder eine vorhandene Übung (exercise_id) oder ein Name. */
  parse(choice) {
    const c = choice || {};
    const byId = c.exercise_id != null;
    if (byId && !Number.isInteger(c.exercise_id)) throw invalid();
    if (!byId && !isPlainText(c.name, 80)) throw invalid("Bitte eine Übung wählen oder einen Namen eingeben.");
    const image = c.image ? Images.check(c.image) : null;
    return { exercise_id: byId ? c.exercise_id : null, name: byId ? null : c.name.trim(), image };
  }

  /** Id einer vorhandenen Übung (oder null, wenn der Name neu ist). Ändert nichts. */
  find(parsed) {
    const exercises = this.db.tables.exercises;
    if (parsed.exercise_id != null) {
      if (!exercises.some((e) => e.id === parsed.exercise_id)) throw notFound("Übung nicht gefunden.");
      return parsed.exercise_id;
    }
    const wanted = normalizeName(parsed.name);
    return exercises.find((e) => normalizeName(e.name) === wanted)?.id ?? null;
  }

  /** Gibt die Id der gewählten Übung zurück und legt sie bei Bedarf neu an.
   *  (Gespeichert wird erst vom Aufrufer.) */
  resolve(parsed) {
    const existing = this.find(parsed);
    if (existing != null) {
      if (parsed.image && !this.db.images[existing]) this.db.setImage(existing, parsed.image);
      return existing;
    }
    const id = this.db.nextId("exercises");
    this.db.tables.exercises.push({ id, name: parsed.name });
    if (parsed.image) this.db.setImage(id, parsed.image);
    return id;
  }
}


/** Die Vorlagen: Workouts anlegen/umbenennen/löschen, Übungen hinzufügen,
 *  entfernen und umsortieren. */
class WorkoutStore {
  // Farben für den Kalender; jedes neue Workout bekommt die nächste Farbe
  static COLORS = ["#c62f26", "#b4590a", "#1b7f4b", "#0b7f8c", "#6d44c4", "#b02a7e"];

  constructor(db, library) {
    this.db = db;
    this.library = library;
  }

  _workout(id) {
    const workout = this.db.tables.workouts.find((w) => w.id === id && !w.archived);
    if (!workout) throw notFound("Workout nicht gefunden.");
    return workout;
  }

  /** Die Übungen eines Workouts in der eingestellten Reihenfolge. */
  _links(workoutId) {
    return this.db.tables.workout_exercises
      .filter((link) => link.workout_id === workoutId)
      .sort((a, b) => a.position - b.position || a.id - b.id);
  }

  /** Alle sichtbaren Workouts samt Übungen, das neueste zuerst. */
  getAll() {
    const t = this.db.tables;
    const withSets = new Set(t.set_entries.map((e) => e.session_id));
    const exerciseById = new Map(t.exercises.map((e) => [e.id, e]));

    return t.workouts
      .filter((w) => !w.archived)
      .sort((a, b) => b.id - a.id)
      .map((w) => {
        // zuletzt verwendet = jüngstes Training dieses Workouts, in dem Sätze eingetragen wurden
        const used = t.sessions.filter((s) => s.workout_id === w.id && withSets.has(s.id))
          .sort((a, b) => timeOf(b.started_at) - timeOf(a.started_at))[0];
        return {
          id: w.id, name: w.name, color: w.color,
          last_used_at: used ? used.started_at : null,
          exercises: this._links(w.id).map((l) => this.library.toExercise(exerciseById.get(l.exercise_id))),
        };
      });
  }

  async create(data) {
    if (!isPlainText(data?.name, 60)) throw invalid("Bitte einen Namen eingeben (höchstens 60 Zeichen).");
    const t = this.db.tables;
    const color = WorkoutStore.COLORS[t.workouts.length % WorkoutStore.COLORS.length];
    const workout = { id: this.db.nextId("workouts"), name: data.name.trim(), color, created_at: nowIso(), archived: 0 };
    t.workouts.push(workout);
    await this.db.persist();
    return { id: workout.id, name: workout.name, color, last_used_at: null, exercises: [] };
  }

  /** Ändert den Namen. Alte Trainings zeigen den neuen Namen ebenfalls. */
  async rename(workoutId, data) {
    if (!isPlainText(data?.name, 60)) throw invalid("Bitte einen Namen eingeben (höchstens 60 Zeichen).");
    this._workout(workoutId).name = data.name.trim();
    await this.db.persist();
    return null;
  }

  /** "Löscht" ein Workout: Es verschwindet aus der Auswahl, bisherige Trainings
   *  bleiben im Kalender erhalten. */
  async archive(workoutId) {
    const workout = this._workout(workoutId);
    if (this.db.tables.sessions.some((s) => s.workout_id === workoutId && s.ended_at == null)) {
      throw conflict("Dieses Workout läuft gerade. Beende es zuerst.");
    }
    workout.archived = 1;
    await this.db.persist();
    return null;
  }

  /** Fügt dem Workout (ans Ende) eine vorhandene oder neue Übung hinzu. */
  async addExercise(workoutId, choice) {
    this._workout(workoutId);
    const parsed = this.library.parse(choice);
    const existing = this.library.find(parsed);
    const links = this._links(workoutId);
    if (existing != null && links.some((l) => l.exercise_id === existing)) {
      throw conflict("Diese Übung gehört schon zum Workout.");
    }
    const exerciseId = this.library.resolve(parsed);
    const position = links.reduce((max, l) => Math.max(max, l.position), 0) + 1;
    this.db.tables.workout_exercises.push({
      id: this.db.nextId("workout_exercises"), workout_id: workoutId, exercise_id: exerciseId, position,
    });
    await this.db.persist();
    return this.library.toExercise(this.db.tables.exercises.find((e) => e.id === exerciseId));
  }

  /** Schiebt eine Übung um eine Stelle (-1 = nach oben, 1 = nach unten). */
  async moveExercise(workoutId, exerciseId, data) {
    const direction = data?.direction;
    if (![-1, 0, 1].includes(direction)) throw invalid();
    const links = this._links(workoutId);
    const index = links.findIndex((l) => l.exercise_id === exerciseId);
    if (index < 0) throw notFound("Übung nicht gefunden.");
    const target = index + direction;
    if (target >= 0 && target < links.length) [links[index], links[target]] = [links[target], links[index]];
    links.forEach((link, position) => { link.position = position; });    // neu durchnummerieren
    await this.db.persist();
    return null;
  }

  /** Entfernt eine Übung aus dem Workout. Die Übung selbst und ihre Sätze bleiben erhalten. */
  async removeExercise(workoutId, exerciseId) {
    const links = this.db.tables.workout_exercises;
    const index = links.findIndex((l) => l.workout_id === workoutId && l.exercise_id === exerciseId);
    if (index < 0) throw notFound("Übung nicht gefunden.");
    links.splice(index, 1);
    await this.db.persist();
    return null;
  }
}


/** Die Trainings: starten, nachtragen, Sätze eintragen, beenden, Verlauf, Statistik, Export. */
class SessionStore {
  constructor(db, library) {
    this.db = db;
    this.library = library;
  }

  // ---------- Hilfen zum Zusammenbauen der Antworten ----------

  _setsBySession() {
    const map = new Map();
    for (const e of this.db.tables.set_entries) {
      if (!map.has(e.session_id)) map.set(e.session_id, []);
      map.get(e.session_id).push(e);
    }
    return map;
  }

  /** Kurzfassung eines Trainings (für den Kalender). */
  _summary(session, setsBySession = this._setsBySession()) {
    const workout = this.db.tables.workouts.find((w) => w.id === session.workout_id);
    const sets = setsBySession.get(session.id) || [];
    return {
      id: session.id, workout_id: session.workout_id,
      workout_name: workout.name, color: workout.color,
      started_at: session.started_at, ended_at: session.ended_at ?? null,
      backfilled: Boolean(session.backfilled),
      set_count: sets.length,
      total_volume: sets.reduce((sum, e) => sum + e.reps * e.weight, 0),
    };
  }

  _setView(entry) {
    const exercise = this.db.tables.exercises.find((e) => e.id === entry.exercise_id);
    return {
      id: entry.id, session_id: entry.session_id, exercise_id: entry.exercise_id,
      exercise_name: exercise.name, reps: entry.reps, weight: entry.weight,
      bodyweight: Boolean(entry.bodyweight), note: entry.note ?? null, logged_at: entry.logged_at,
    };
  }

  /** Ein Training mit Übungen und Sätzen. */
  _full(session) {
    const t = this.db.tables;
    const exercises = t.session_exercises
      .filter((se) => se.session_id === session.id)
      .sort((a, b) => a.id - b.id)
      .map((se) => this.library.toExercise(t.exercises.find((e) => e.id === se.exercise_id)));
    const sets = t.set_entries
      .filter((e) => e.session_id === session.id)
      .sort((a, b) => timeOf(a.logged_at) - timeOf(b.logged_at) || a.id - b.id)
      .map((e) => this._setView(e));
    return { ...this._summary(session), exercises, sets };
  }

  _find(sessionId) {
    const session = this.db.tables.sessions.find((s) => s.id === sessionId);
    if (!session) throw notFound("Training nicht gefunden.");
    return session;
  }

  /** Das Training, wenn man es ändern darf: Es läuft gerade oder wurde nachgetragen.
   *  Normale beendete Trainings sind abgeschlossen. */
  _editable(sessionId) {
    const session = this._find(sessionId);
    if (session.ended_at != null && !session.backfilled) throw conflict("Dieses Workout ist bereits beendet.");
    return session;
  }

  static checkMonth(month) {
    if (!/^\d{4}-\d{2}$/.test(month || "")) throw invalid();
    return month;
  }

  // ---------- Abrufen ----------

  /** Das gerade laufende Training oder null. */
  getActive() {
    const running = this.db.tables.sessions.filter((s) => s.ended_at == null).sort((a, b) => b.id - a.id)[0];
    return running ? this._full(running) : null;
  }

  get(sessionId) {
    return this._full(this._find(sessionId));
  }

  /** Alle Trainings eines Monats ('2026-11'), neueste zuerst. Trainings ohne
   *  einen einzigen Satz zählen nicht als durchgeführt. */
  getMonth(month) {
    SessionStore.checkMonth(month);
    const bySession = this._setsBySession();
    return this.db.tables.sessions
      .filter((s) => s.started_at.startsWith(month) && bySession.has(s.id))
      .sort((a, b) => timeOf(b.started_at) - timeOf(a.started_at) || b.id - a.id)
      .map((s) => this._summary(s, bySession));
  }

  /** Alle bisherigen Sätze einer Übung, egal in welchem Workout, neueste zuerst. */
  exerciseHistory(exerciseId) {
    if (!this.db.tables.exercises.some((e) => e.id === exerciseId)) throw notFound("Übung nicht gefunden.");
    return this.db.tables.set_entries
      .filter((e) => e.exercise_id === exerciseId)
      .sort((a, b) => timeOf(b.logged_at) - timeOf(a.logged_at) || b.id - a.id)
      .slice(0, 500)
      .map((e) => this._setView(e));
  }

  /** Pro Workout: Anzahl Trainings und bewegtes Gewicht (Wiederholungen x Gewicht).
   *  Mit Monat nur dieser Monat, ohne Monat alle Trainings. */
  stats(month) {
    if (month != null) SessionStore.checkMonth(month);
    const bySession = this._setsBySession();
    const rows = new Map();
    for (const s of this.db.tables.sessions) {
      if (!bySession.has(s.id) || (month != null && !s.started_at.startsWith(month))) continue;
      const workout = this.db.tables.workouts.find((w) => w.id === s.workout_id);
      const row = rows.get(workout.id) || {
        workout_id: workout.id, workout_name: workout.name, color: workout.color, sessions: 0, volume: 0,
      };
      row.sessions += 1;
      row.volume += bySession.get(s.id).reduce((sum, e) => sum + e.reps * e.weight, 0);
      rows.set(workout.id, row);
    }
    return [...rows.values()].sort((a, b) => b.volume - a.volume);
  }

  /** Alle Sätze als CSV-Text (für Excel: Semikolon-getrennt). Neueste zuerst. */
  exportCsv() {
    const t = this.db.tables;
    // Zellen, die mit = + - @ beginnen, würde Excel als Formel ausführen: Apostroph davor
    const safe = (text) => (text && "=+-@".includes(text[0]) ? "'" + text : text || "");
    const cell = (text) => (/[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);

    const rows = [...t.set_entries]
      .sort((a, b) => timeOf(b.logged_at) - timeOf(a.logged_at) || b.id - a.id)
      .map((e) => {
        const session = t.sessions.find((s) => s.id === e.session_id);
        const workout = t.workouts.find((w) => w.id === session.workout_id);
        const exercise = t.exercises.find((x) => x.id === e.exercise_id);
        const [day, clock] = e.logged_at.split("T");
        return [day, clock.slice(0, 5), safe(workout.name), safe(exercise.name), String(e.reps),
          String(e.weight).replace(".", ","), e.bodyweight ? "ja" : "nein", safe(e.note)];
      });
    const header = ["Datum", "Uhrzeit", "Workout", "Übung", "Wiederholungen", "Gewicht_kg", "Körpergewicht", "Notiz"];
    return [header, ...rows].map((row) => row.map(cell).join(";")).join("\r\n") + "\r\n";
  }

  // ---------- Starten, Nachtragen, Beenden, Löschen ----------

  /** Startet ein Training. Es kann immer nur eines gleichzeitig laufen. */
  async start(data) {
    if (!Number.isInteger(data?.workout_id)) throw invalid();
    if (this.db.tables.sessions.some((s) => s.ended_at == null)) throw conflict("Es läuft bereits ein Workout.");
    const session = this._create(data.workout_id, nowIso(), false);
    await this.db.persist();
    return this._full(session);
  }

  /** Legt ein Training in der Vergangenheit an. Es gilt sofort als beendet,
   *  die Sätze trägt man danach ein. */
  async backfill(data) {
    if (!Number.isInteger(data?.workout_id) || !/^\d{4}-\d{2}-\d{2}$/.test(data?.date || "")
        || !/^\d{2}:\d{2}$/.test(data?.time || "")) throw invalid();
    const moment = new Date(`${data.date}T${data.time}`);
    // Zweiter Teil des Vergleichs fängt Daten wie den 30. Februar ab
    if (Number.isNaN(moment.getTime()) || localIso(moment).slice(0, 16) !== `${data.date}T${data.time}`) {
      throw invalid("Ungültiges Datum oder ungültige Uhrzeit.");
    }
    if (moment > new Date()) throw invalid("Ein nachgetragenes Training kann nicht in der Zukunft liegen.");
    const session = this._create(data.workout_id, localIso(moment), true);
    await this.db.persist();
    return this._full(session);
  }

  /** Beendet ein Training. Wurde kein Satz eingetragen, wird es verworfen (null). */
  async finish(sessionId) {
    const session = this._find(sessionId);
    if (!this.db.tables.set_entries.some((e) => e.session_id === sessionId)) {
      this._remove(sessionId);
      await this.db.persist();
      return null;
    }
    if (session.ended_at == null) session.ended_at = nowIso();
    await this.db.persist();
    return this._full(session);
  }

  /** Löscht ein Training samt aller Sätze. */
  async delete(sessionId) {
    this._find(sessionId);
    this._remove(sessionId);
    await this.db.persist();
    return null;
  }

  // ---------- Übungen tauschen ----------

  /** Tauscht eine Übung nur in DIESEM Training aus. Das Workout selbst und die
   *  übrigen Übungen bleiben unverändert. */
  async replaceExercise(sessionId, exerciseId, choice) {
    const t = this.db.tables;
    this._editable(sessionId);
    const link = t.session_exercises.find((se) => se.session_id === sessionId && se.exercise_id === exerciseId);
    if (!link) throw notFound("Diese Übung gehört nicht zu diesem Training.");
    if (t.set_entries.some((e) => e.session_id === sessionId && e.exercise_id === exerciseId)) {
      throw conflict("Für diese Übung sind schon Sätze eingetragen. Lösche sie zuerst.");
    }
    const parsed = this.library.parse(choice);
    const existing = this.library.find(parsed);
    if (existing != null && existing !== exerciseId
        && t.session_exercises.some((se) => se.session_id === sessionId && se.exercise_id === existing)) {
      throw conflict("Diese Übung ist schon Teil des Trainings.");
    }
    link.exercise_id = this.library.resolve(parsed);
    await this.db.persist();
    return this.get(sessionId);
  }

  // ---------- Sätze ----------

  /** Trägt einen Satz ein. Bei einem nachgetragenen Training bekommt der Satz
   *  die Startzeit des Trainings, sonst die aktuelle Zeit. */
  async addSet(sessionId, data) {
    const d = data || {};
    const weight = d.weight ?? 0;
    const note = typeof d.note === "string" ? d.note.trim() : null;
    if (!Number.isInteger(d.exercise_id) || !Number.isInteger(d.reps) || d.reps < 1 || d.reps > 1000
        || typeof weight !== "number" || !(weight >= 0 && weight <= 1000)
        || (d.bodyweight != null && typeof d.bodyweight !== "boolean")
        || (note != null && note.length > 200)) throw invalid();

    const session = this._editable(sessionId);
    const t = this.db.tables;
    if (!t.session_exercises.some((se) => se.session_id === sessionId && se.exercise_id === d.exercise_id)) {
      throw notFound("Diese Übung gehört nicht zu diesem Training.");
    }
    const entry = {
      id: this.db.nextId("set_entries"), session_id: sessionId, exercise_id: d.exercise_id,
      reps: d.reps, weight, bodyweight: d.bodyweight ? 1 : 0, note: note || null,
      logged_at: session.backfilled ? session.started_at : nowIso(),
    };
    t.set_entries.push(entry);
    await this.db.persist();
    return this._setView(entry);
  }

  /** Löscht einen Satz (auch aus früheren Trainings). */
  async deleteSet(sessionId, setId) {
    const entries = this.db.tables.set_entries;
    const index = entries.findIndex((e) => e.id === setId && e.session_id === sessionId);
    if (index < 0) throw notFound("Satz nicht gefunden.");
    entries.splice(index, 1);
    await this.db.persist();
    return null;
  }

  // ---------- Intern ----------

  /** Legt ein Training an und kopiert die Übungen des Workouts hinein. */
  _create(workoutId, startedAt, backfilled) {
    const t = this.db.tables;
    const workout = t.workouts.find((w) => w.id === workoutId && !w.archived);
    if (!workout) throw notFound("Workout nicht gefunden.");
    const session = {
      id: this.db.nextId("sessions"), workout_id: workoutId,
      started_at: startedAt, ended_at: backfilled ? startedAt : null, backfilled: backfilled ? 1 : 0,
    };
    t.sessions.push(session);
    t.workout_exercises
      .filter((l) => l.workout_id === workoutId)
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .forEach((l) => t.session_exercises.push({
        id: this.db.nextId("session_exercises"), session_id: session.id, exercise_id: l.exercise_id,
      }));
    return session;
  }

  /** Entfernt ein Training mit seinen Übungen und Sätzen. */
  _remove(sessionId) {
    const t = this.db.tables;
    t.sessions = t.sessions.filter((s) => s.id !== sessionId);
    t.session_exercises = t.session_exercises.filter((se) => se.session_id !== sessionId);
    t.set_entries = t.set_entries.filter((e) => e.session_id !== sessionId);
  }
}


/* ---------------------------------------------------------------------
   5. Backup: Sicherung als Datei
   Weil die Daten nur auf dem Handy liegen, ist die Sicherung wichtig:
   Geht das Handy verloren oder wird die App gelöscht, sind sonst alle
   Trainings weg. Die Sicherung ist eine einfache Textdatei (JSON).
   --------------------------------------------------------------------- */

class Backup {
  static FORMAT = "trainingstagebuch-sicherung";
  static VERSION = 1;

  constructor(db) {
    this.db = db;
  }

  lastBackupAt() {
    return this.db.meta.lastBackupAt || null;
  }

  /** Alle Daten als Text für die Sicherungsdatei. Merkt sich den Zeitpunkt. */
  async createFile() {
    const content = JSON.stringify({
      format: Backup.FORMAT, version: Backup.VERSION, exported_at: nowIso(),
      tables: this.db.tables, images: this.db.images,
    });
    this.db.meta.lastBackupAt = nowIso();
    await this.db.persist();
    return content;
  }

  /** Liest eine Sicherungsdatei ein und ersetzt ALLE jetzigen Daten.
   *  Die Datei wird vorher streng geprüft (Typen, Verweise, Farben, Bilder). */
  async restore(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw invalid("Die Datei ist keine gültige Sicherung des Trainingstagebuchs."); }
    const { tables, images } = Backup.validate(data);
    await this.db.replaceAll(tables, images, { lastBackupAt: this.db.meta.lastBackupAt || null });
  }

  /** Prüft den Inhalt einer Sicherung und gibt bereinigte Tabellen zurück. */
  static validate(data) {
    const fail = () => { throw invalid("Die Datei ist keine gültige Sicherung des Trainingstagebuchs."); };
    const isInt = Number.isInteger;
    const isText = (v, max = 200) => typeof v === "string" && v.length <= max;
    const isTime = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

    if (!data || data.format !== Backup.FORMAT || data.version !== Backup.VERSION
        || typeof data.tables !== "object" || data.tables === null) fail();

    // Pro Tabelle: welche Felder müssen welchen Typ haben?
    const rules = {
      workouts: (r) => isText(r.name, 60) && /^#[0-9a-fA-F]{6}$/.test(r.color) && isText(r.created_at),
      exercises: (r) => isText(r.name, 80),
      workout_exercises: (r) => isInt(r.workout_id) && isInt(r.exercise_id) && isInt(r.position),
      sessions: (r) => isInt(r.workout_id) && isTime(r.started_at) && (r.ended_at == null || isTime(r.ended_at)),
      session_exercises: (r) => isInt(r.session_id) && isInt(r.exercise_id),
      set_entries: (r) => isInt(r.session_id) && isInt(r.exercise_id) && isInt(r.reps) && r.reps >= 1 && r.reps <= 1000
        && typeof r.weight === "number" && r.weight >= 0 && r.weight <= 1000
        && (r.note == null || isText(r.note)) && isTime(r.logged_at),
    };

    const tables = { counters: {} };
    for (const name of Database.TABLES) {
      const rows = data.tables[name];
      if (!Array.isArray(rows)) fail();
      const ids = new Set();
      tables[name] = rows.map((row) => {
        if (!row || typeof row !== "object" || !isInt(row.id) || row.id < 1 || ids.has(row.id) || !rules[name](row)) fail();
        ids.add(row.id);
        return { ...row };
      });
      tables.counters[name] = Math.max(0, ...ids) + 1;
    }

    // Alle Verweise müssen auf vorhandene Einträge zeigen
    const has = (table, id) => tables[table].some((r) => r.id === id);
    const refs = [
      ["workout_exercises", "workout_id", "workouts"], ["workout_exercises", "exercise_id", "exercises"],
      ["sessions", "workout_id", "workouts"],
      ["session_exercises", "session_id", "sessions"], ["session_exercises", "exercise_id", "exercises"],
      ["set_entries", "session_id", "sessions"], ["set_entries", "exercise_id", "exercises"],
    ];
    for (const [table, field, target] of refs) {
      if (!tables[table].every((row) => has(target, row[field]))) fail();
    }

    // Bilder: Schlüssel = Nummer einer vorhandenen Übung, Wert = geprüftes Bild
    const images = {};
    for (const [key, value] of Object.entries(data.images || {})) {
      if (!has("exercises", Number(key))) fail();
      images[Number(key)] = Images.check(value);
    }
    return { tables, images };
  }
}


/* ---------------------------------------------------------------------
   6. LocalServer: nimmt die "Anfragen" der Oberfläche entgegen
   Die Oberfläche arbeitet weiter mit Adressen wie "/api/workouts". Statt
   an einen Server gehen sie hier an die Klassen oben. Das hält die
   Oberfläche unverändert und übersichtlich.
   --------------------------------------------------------------------- */

const db = new Database();
const library = new ExerciseLibrary(db);
const workoutStore = new WorkoutStore(db, library);
const sessionStore = new SessionStore(db, library);
const backup = new Backup(db);
const ready = db.open();            // die Oberfläche wartet darauf, bevor sie Daten abfragt

class LocalServer {
  // [Methode, Adresse, Funktion(Nummern aus der Adresse..., Abfrage, Inhalt)]
  // Feste Adressen ("/active", "/stats") stehen vor denen mit Nummer.
  static ROUTES = [
    ["GET",    /^\/api\/workouts$/,                              () => workoutStore.getAll()],
    ["POST",   /^\/api\/workouts$/,                              (q, body) => workoutStore.create(body)],
    ["PATCH",  /^\/api\/workouts\/(\d+)$/,                       (q, body, id) => workoutStore.rename(id, body)],
    ["DELETE", /^\/api\/workouts\/(\d+)$/,                       (q, body, id) => workoutStore.archive(id)],
    ["POST",   /^\/api\/workouts\/(\d+)\/exercises$/,            (q, body, id) => workoutStore.addExercise(id, body)],
    ["POST",   /^\/api\/workouts\/(\d+)\/exercises\/(\d+)\/move$/, (q, body, id, ex) => workoutStore.moveExercise(id, ex, body)],
    ["DELETE", /^\/api\/workouts\/(\d+)\/exercises\/(\d+)$/,     (q, body, id, ex) => workoutStore.removeExercise(id, ex)],
    ["GET",    /^\/api\/exercises$/,                             () => library.getAll()],
    ["GET",    /^\/api\/exercises\/(\d+)\/history$/,             (q, body, id) => sessionStore.exerciseHistory(id)],
    ["GET",    /^\/api\/sessions\/active$/,                      () => sessionStore.getActive()],
    ["GET",    /^\/api\/sessions\/stats$/,                       (q) => sessionStore.stats(q.get("month"))],
    ["GET",    /^\/api\/sessions$/,                              (q) => sessionStore.getMonth(q.get("month"))],
    ["POST",   /^\/api\/sessions$/,                              (q, body) => sessionStore.start(body)],
    ["POST",   /^\/api\/sessions\/backfill$/,                    (q, body) => sessionStore.backfill(body)],
    ["GET",    /^\/api\/sessions\/(\d+)$/,                       (q, body, id) => sessionStore.get(id)],
    ["DELETE", /^\/api\/sessions\/(\d+)$/,                       (q, body, id) => sessionStore.delete(id)],
    ["POST",   /^\/api\/sessions\/(\d+)\/finish$/,               (q, body, id) => sessionStore.finish(id)],
    ["POST",   /^\/api\/sessions\/(\d+)\/exercises\/(\d+)\/replace$/, (q, body, id, ex) => sessionStore.replaceExercise(id, ex, body)],
    ["POST",   /^\/api\/sessions\/(\d+)\/sets$/,                 (q, body, id) => sessionStore.addSet(id, body)],
    ["DELETE", /^\/api\/sessions\/(\d+)\/sets\/(\d+)$/,          (q, body, id, setId) => sessionStore.deleteSet(id, setId)],
  ];

  static async handle(method, path, body) {
    await ready;
    const [pathname, query = ""] = path.split("?");
    for (const [routeMethod, pattern, handler] of LocalServer.ROUTES) {
      const match = routeMethod === method && pattern.exec(pathname);
      if (match) return handler(new URLSearchParams(query), body, ...match.slice(1).map(Number));
    }
    throw notFound("Unbekannte Adresse.");
  }
}
