// server.js
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

const DB_PATH = path.join(__dirname, "db.json");
const PUBLIC = path.join(__dirname, "public");

app.use(express.json());
app.use(express.static(PUBLIC));

function loadDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

// ===== helpers =====
function timeToMinutes(hhmm) {
  const [h, m] = (hhmm || "").split(":").map(Number);
  return h * 60 + (m || 0);
}
function minutesToHHMM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}
function sameYMD(a, b) {
  const da = new Date(a),
    db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}
function slotsForDate(av, dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime()))
    return { slotMinutes: av.slotMinutes || 30, slots: [] };
  const dow = d.getDay();
  const minutes = Number(av.slotMinutes) || 30;
  let ranges = av.exceptions?.[dateStr];
  if (ranges === undefined) ranges = av.weekTemplate?.[dow] || [];
  const result = [];
  for (const [from, to] of ranges || []) {
    let cur = timeToMinutes(from);
    const end = timeToMinutes(to);
    while (cur + minutes <= end) {
      const start = `${dateStr}T${minutesToHHMM(cur)}:00.000Z`;
      const finish = `${dateStr}T${minutesToHHMM(cur + minutes)}:00.000Z`;
      result.push({ start, end: finish });
      cur += minutes;
    }
  }
  return { slotMinutes: minutes, slots: result };
}

// ===== crypto/auth =====
function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, dk) =>
      err ? reject(err) : resolve(dk.toString("hex"))
    );
  });
}
function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function auth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    req.user = null;
    return next();
  }
  const db = loadDB();
  const sess = db.sessions.find((s) => s.token === token);
  if (!sess) {
    req.user = null;
    return next();
  }
  const u = db.users.find((x) => x.id === sess.userId);
  if (!u) {
    req.user = null;
    return next();
  }
  req.user = { id: u.id, role: u.role, name: u.name, email: u.email };
  req.token = token;
  next();
}
function requireAuth(role = null) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "UNAUTHORIZED" });
    if (role && req.user.role !== role)
      return res.status(403).json({ error: "FORBIDDEN" });
    next();
  };
}

app.get("/api/health", (_, res) => res.json({ ok: true }));

// ===== auth =====
app.post("/api/auth/register", async (req, res) => {
  const { name = "", email = "", password = "", role = "" } = req.body || {};
  if (!email || !password || !role)
    return res.status(400).json({ error: "INVALID_FIELDS" });
  const db = loadDB();
  if (
    db.users.some((u) => u.email.toLowerCase() === String(email).toLowerCase())
  )
    return res.status(400).json({ error: "EMAIL_EXISTS" });
  const id = ++db.counters.users;
  const salt = crypto.randomBytes(16).toString("hex");
  const passHash = await hashPassword(password, salt);
  const user = {
    id,
    role,
    name: name || email.split("@")[0],
    email,
    passSalt: salt,
    passHash,
  };
  db.users.push(user);
  const token = makeToken();
  db.sessions.push({
    token,
    userId: id,
    expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
  });
  saveDB(db);
  res.json({ token, user: { id, role, name: user.name, email } });
});

app.post("/api/auth/login", async (req, res) => {
  const { email = "", password = "" } = req.body || {};
  const db = loadDB();
  const user = db.users.find(
    (u) => u.email.toLowerCase() === String(email).toLowerCase()
  );
  if (!user) return res.status(400).json({ error: "INVALID_CREDENTIALS" });
  const hash = await hashPassword(password, user.passSalt);
  if (hash !== user.passHash)
    return res.status(400).json({ error: "INVALID_CREDENTIALS" });
  const token = makeToken();
  db.sessions.push({
    token,
    userId: user.id,
    expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
  });
  saveDB(db);
  res.json({
    token,
    user: { id: user.id, role: user.role, name: user.name, email: user.email },
  });
});

app.post("/api/auth/logout", auth, (req, res) => {
  if (!req.user) return res.json({ ok: true });
  const db = loadDB();
  db.sessions = db.sessions.filter((s) => s.token !== req.token);
  saveDB(db);
  res.json({ ok: true });
});

app.get("/api/users/me", auth, (req, res) => {
  if (!req.user) return res.status(401).json({ error: "UNAUTHORIZED" });
  res.json(req.user);
});

// ===== categories =====
app.get("/api/categories", (_, res) => res.json(loadDB().categories));
app.post("/api/categories", auth, requireAuth("master"), (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "INVALID_FIELDS" });
  const db = loadDB();
  const id = ++db.counters.categories;
  const cat = { id, name };
  db.categories.push(cat);
  saveDB(db);
  res.json(cat);
});
app.put("/api/categories/:id", auth, requireAuth("master"), (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body || {};
  const db = loadDB();
  const cat = db.categories.find((c) => c.id === id);
  if (!cat) return res.status(404).json({ error: "NOT_FOUND" });
  if (name) cat.name = name;
  saveDB(db);
  res.json(cat);
});
app.delete("/api/categories/:id", auth, requireAuth("master"), (req, res) => {
  const id = Number(req.params.id);
  const db = loadDB();
  db.categories = db.categories.filter((c) => c.id !== id);
  db.services = db.services.filter((s) => s.categoryId !== id);
  saveDB(db);
  res.json({ ok: true });
});

// ===== services =====
app.get("/api/services", (req, res) => {
  const db = loadDB();
  let list = db.services;
  const { masterId, categoryId } = req.query;
  if (masterId)
    list = list.filter((s) => String(s.masterId) === String(masterId));
  if (categoryId)
    list = list.filter((s) => String(s.categoryId) === String(categoryId));
  res.json(list);
});
// ➜ НОВОЕ: получить конкретную услугу по id
app.get("/api/services/:id", (req, res) => {
  const db = loadDB();
  const id = Number(req.params.id);
  const svc = db.services.find((s) => s.id === id);
  if (!svc) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(svc);
});
app.post("/api/services", auth, requireAuth("master"), (req, res) => {
  const { title, description = "", price = 0, categoryId } = req.body || {};
  if (!title || !categoryId)
    return res.status(400).json({ error: "INVALID_FIELDS" });
  const db = loadDB();
  const id = ++db.counters.services;
  const svc = {
    id,
    masterId: req.user.id,
    categoryId: Number(categoryId),
    title,
    description,
    price: Number(price) || 0,
  };
  db.services.push(svc);
  saveDB(db);
  res.json(svc);
});
app.put("/api/services/:id", auth, requireAuth("master"), (req, res) => {
  const id = Number(req.params.id);
  const { title, description, price, categoryId } = req.body || {};
  const db = loadDB();
  const svc = db.services.find((s) => s.id === id);
  if (!svc) return res.status(404).json({ error: "NOT_FOUND" });
  if (svc.masterId !== req.user.id)
    return res.status(403).json({ error: "FORBIDDEN" });
  if (title !== undefined) svc.title = title;
  if (description !== undefined) svc.description = description;
  if (price !== undefined) svc.price = Number(price) || 0;
  if (categoryId !== undefined) svc.categoryId = Number(categoryId);
  saveDB(db);
  res.json(svc);
});
app.delete("/api/services/:id", auth, requireAuth("master"), (req, res) => {
  const id = Number(req.params.id);
  const db = loadDB();
  const svc = db.services.find((s) => s.id === id);
  if (!svc) return res.status(404).json({ error: "NOT_FOUND" });
  if (svc.masterId !== req.user.id)
    return res.status(403).json({ error: "FORBIDDEN" });
  db.services = db.services.filter((s) => s.id !== id);
  saveDB(db);
  res.json({ ok: true });
});

// ===== orders =====
const VALID_STATUSES = ["NEW", "ACCEPTED", "DONE", "REJECTED", "CANCELLED"];

app.get("/api/orders", auth, (req, res) => {
  if (!req.user) return res.status(401).json({ error: "UNAUTHORIZED" });
  const db = loadDB();
  let list = db.orders;
  if (req.user.role === "master")
    list = list.filter((o) => o.masterId === req.user.id);
  else list = list.filter((o) => o.clientId === req.user.id);
  res.json(list);
});

// NEW: подробности заказа
app.get("/api/orders/:id", auth, (req, res) => {
  if (!req.user) return res.status(401).json({ error: "UNAUTHORIZED" });
  const db = loadDB();
  const id = Number(req.params.id);
  const o = db.orders.find((x) => x.id === id);
  if (!o) return res.status(404).json({ error: "NOT_FOUND" });

  // доступ
  if (req.user.role === "master" && o.masterId !== req.user.id)
    return res.status(403).json({ error: "FORBIDDEN" });
  if (req.user.role === "client" && o.clientId !== req.user.id)
    return res.status(403).json({ error: "FORBIDDEN" });

  const client = db.users.find((u) => u.id === o.clientId);
  const svc = db.services.find((s) => s.id === o.serviceId);
  const detail = {
    ...o,
    client: client
      ? { id: client.id, name: client.name, email: client.email }
      : null,
    service: svc
      ? {
          id: svc.id,
          title: svc.title,
          price: svc.price,
          categoryId: svc.categoryId,
        }
      : null,
  };
  res.json(detail);
});

app.post("/api/orders", auth, (req, res) => {
  if (!req.user) return res.status(401).json({ error: "UNAUTHORIZED" });
  if (req.user.role !== "client")
    return res.status(403).json({ error: "FORBIDDEN" });
  const { serviceId, comment = "", desired_datetime = null } = req.body || {};
  const db = loadDB();
  const svc = db.services.find((s) => s.id === Number(serviceId));
  if (!svc) return res.status(400).json({ error: "SERVICE_NOT_FOUND" });

  if (desired_datetime) {
    const dt = new Date(desired_datetime);
    if (Number.isNaN(dt.getTime()))
      return res.status(400).json({ error: "INVALID_DATETIME" });
    const dateStr = dt.toISOString().slice(0, 10);
    const masterId = svc.masterId;
    const av =
      (db.availability && db.availability[String(masterId)]) ||
      DEFAULT_AVAILABILITY;
    const day = slotsForDate(av, dateStr);
    const wanted = day.slots.find(
      (s) => sameYMD(s.start, dt.toISOString()) && s.start === dt.toISOString()
    );
    if (!wanted) return res.status(400).json({ error: "SLOT_NOT_IN_SCHEDULE" });

    const busy = db.orders.some(
      (o) =>
        o.masterId === masterId &&
        (o.status === "NEW" || o.status === "ACCEPTED") &&
        sameYMD(o.desired_datetime, desired_datetime) &&
        o.desired_datetime === desired_datetime
    );
    if (busy) return res.status(400).json({ error: "SLOT_UNAVAILABLE" });
  }

  const id = ++db.counters.orders;
  const order = {
    id,
    serviceId: svc.id,
    masterId: svc.masterId,
    clientId: req.user.id,
    comment,
    desired_datetime: desired_datetime || new Date().toISOString(),
    status: "NEW",
    status_date: new Date().toISOString(),
  };
  db.orders.push(order);
  saveDB(db);
  res.json(order);
});

app.put("/api/orders/:id/status", auth, (req, res) => {
  const { status, reason = "" } = req.body || {};
  if (!VALID_STATUSES.includes(status))
    return res.status(400).json({ error: "INVALID_STATUS" });
  const db = loadDB();
  const id = Number(req.params.id);
  const o = db.orders.find((x) => x.id === id);
  if (!o) return res.status(404).json({ error: "NOT_FOUND" });
  if (req.user.role === "master") {
    if (o.masterId !== req.user.id)
      return res.status(403).json({ error: "FORBIDDEN" });
    const allowed =
      (o.status === "NEW" &&
        (status === "ACCEPTED" || status === "REJECTED")) ||
      (o.status === "ACCEPTED" &&
        (status === "DONE" || status === "CANCELLED"));
    if (!allowed) return res.status(400).json({ error: "ILLEGAL_TRANSITION" });
    o.status = status;
    o.status_date = new Date().toISOString();
    if (status === "REJECTED") o.rejectionReason = reason || "";
  } else {
    if (o.clientId !== req.user.id)
      return res.status(403).json({ error: "FORBIDDEN" });
    const allowed =
      (o.status === "NEW" || o.status === "ACCEPTED") && status === "CANCELLED";
    if (!allowed) return res.status(400).json({ error: "ILLEGAL_TRANSITION" });
    o.status = status;
    o.status_date = new Date().toISOString();
  }
  saveDB(db);
  res.json(o);
});

// ===== analytics =====
app.get("/api/analytics/summary", auth, (req, res) => {
  if (!req.user) return res.status(401).json({ error: "UNAUTHORIZED" });
  const db = loadDB();
  const orders =
    req.user.role === "master"
      ? db.orders.filter((o) => o.masterId === req.user.id)
      : db.orders.filter((o) => o.clientId === req.user.id);
  const sum = {
    total: orders.length,
    NEW: orders.filter((o) => o.status === "NEW").length,
    ACCEPTED: orders.filter((o) => o.status === "ACCEPTED").length,
    DONE: orders.filter((o) => o.status === "DONE").length,
    REJECTED: orders.filter((o) => o.status === "REJECTED").length,
    CANCELLED: orders.filter((o) => o.status === "CANCELLED").length,
  };
  res.json(sum);
});

// ===== availability =====
const DEFAULT_AVAILABILITY = {
  slotMinutes: 30,
  weekTemplate: {
    1: [
      ["09:00", "13:00"],
      ["14:00", "18:00"],
    ],
    2: [
      ["09:00", "13:00"],
      ["14:00", "18:00"],
    ],
    3: [
      ["09:00", "13:00"],
      ["14:00", "18:00"],
    ],
    4: [
      ["09:00", "13:00"],
      ["14:00", "18:00"],
    ],
    5: [["10:00", "16:00"]],
    6: [["10:00", "14:00"]],
    0: [],
  },
  exceptions: {},
};

app.get("/api/availability/:masterId", auth, (req, res) => {
  const db = loadDB();
  const a = db.availability?.[String(Number(req.params.masterId))];
  res.json(a || DEFAULT_AVAILABILITY);
});

app.get("/api/availability/:masterId/slots", (req, res) => {
  const dateStr = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr))
    return res.status(400).json({ error: "INVALID_DATE" });
  const db = loadDB();
  const masterId = Number(req.params.masterId);
  const av = db.availability?.[String(masterId)] || DEFAULT_AVAILABILITY;

  const day = slotsForDate(av, dateStr);
  const busyOrders = db.orders.filter(
    (o) =>
      o.masterId === masterId &&
      (o.status === "NEW" || o.status === "ACCEPTED") &&
      sameYMD(o.desired_datetime, dateStr + "T00:00:00Z")
  );
  const busySet = new Set(busyOrders.map((o) => o.desired_datetime));
  const result = day.slots.map((s) => ({
    ...s,
    status: busySet.has(s.start) ? "busy" : "free",
  }));
  res.json({ slotMinutes: day.slotMinutes, slots: result });
});

app.put(
  "/api/availability/:masterId",
  auth,
  requireAuth("master"),
  (req, res) => {
    if (String(req.user.id) !== String(req.params.masterId))
      return res.status(403).json({ error: "FORBIDDEN" });
    const { slotMinutes, weekTemplate, exceptions } = req.body || {};
    const isTime = (s) => typeof s === "string" && /^\d{2}:\d{2}$/.test(s);
    const checkRanges = (arr) =>
      Array.isArray(arr) &&
      arr.every(
        (r) =>
          Array.isArray(r) &&
          r.length === 2 &&
          isTime(r[0]) &&
          isTime(r[1]) &&
          r[0] < r[1]
      );

    if (!Number.isFinite(Number(slotMinutes)))
      return res.status(400).json({ error: "INVALID_SLOT_MINUTES" });
    if (typeof weekTemplate !== "object" || weekTemplate === null)
      return res.status(400).json({ error: "INVALID_WEEK_TEMPLATE" });
    for (const d of [0, 1, 2, 3, 4, 5, 6])
      if (!checkRanges(weekTemplate[d] || []))
        return res.status(400).json({ error: "INVALID_WEEK_DAY", day: d });
    if (typeof exceptions !== "object" || exceptions === null)
      return res.status(400).json({ error: "INVALID_EXCEPTIONS" });
    for (const [date, arr] of Object.entries(exceptions)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !checkRanges(arr || []))
        return res.status(400).json({ error: "INVALID_EXCEPTION", date });
    }

    const db = loadDB();
    if (!db.availability) db.availability = {};
    db.availability[String(req.user.id)] = {
      slotMinutes: Number(slotMinutes),
      weekTemplate,
      exceptions,
    };
    saveDB(db);
    res.json(db.availability[String(req.user.id)]);
  }
);

// fallback
app.get("*", (_, res) => res.sendFile(path.join(PUBLIC, "index.html")));

(async function ensureSeeds() {
  const db = loadDB();
  let changed = false;
  for (const u of db.users) {
    if (!u.passSalt || !u.passHash) {
      u.passSalt = crypto.randomBytes(16).toString("hex");
      u.passHash = await new Promise((resolve, reject) => {
        crypto.scrypt("1234", u.passSalt, 64, (err, dk) =>
          err ? reject(err) : resolve(dk.toString("hex"))
        );
      });
      changed = true;
    }
  }
  if (changed) saveDB(db);
})();

app.listen(PORT, () =>
  console.log(`AGRUS server running at http://localhost:${PORT}`)
);
