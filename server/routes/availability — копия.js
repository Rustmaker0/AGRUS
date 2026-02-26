import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", ".."); // корень проекта
const DB_PATH = path.join(ROOT, "db.json");

function loadDB() {
  const raw = fs.readFileSync(DB_PATH, "utf-8");
  return JSON.parse(raw);
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

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

function requireMasterSelf(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "UNAUTHORIZED" });
  if (req.user.role !== "master")
    return res.status(403).json({ error: "FORBIDDEN" });
  if (String(req.user.id) !== String(req.params.masterId))
    return res.status(403).json({ error: "FORBIDDEN" });
  next();
}

// получить расписание мастера
router.get("/:masterId", (req, res) => {
  const masterId = Number(req.params.masterId);
  const db = loadDB();
  if (!db.availability) db.availability = {}; // на всякий случай
  const a = db.availability[String(masterId)];
  // Возвращаем дефолт, если пока не настраивалось — фронту так удобнее
  res.json(a || DEFAULT_AVAILABILITY);
});

// сохранить расписание мастера
router.put("/:masterId", requireMasterSelf, (req, res) => {
  const masterId = String(Number(req.params.masterId));
  const { slotMinutes, weekTemplate, exceptions } = req.body || {};

  // Простая валидация
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

  if (!Number.isFinite(Number(slotMinutes))) {
    return res.status(400).json({ error: "INVALID_SLOT_MINUTES" });
  }
  if (typeof weekTemplate !== "object" || weekTemplate === null) {
    return res.status(400).json({ error: "INVALID_WEEK_TEMPLATE" });
  }
  for (const d of [0, 1, 2, 3, 4, 5, 6]) {
    if (!checkRanges(weekTemplate[d] || [])) {
      return res.status(400).json({ error: "INVALID_WEEK_DAY", day: d });
    }
  }
  if (typeof exceptions !== "object" || exceptions === null) {
    return res.status(400).json({ error: "INVALID_EXCEPTIONS" });
  }
  for (const [date, arr] of Object.entries(exceptions)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !checkRanges(arr || [])) {
      return res.status(400).json({ error: "INVALID_EXCEPTION", date });
    }
  }

  const db = loadDB();
  if (!db.availability) db.availability = {};
  db.availability[masterId] = {
    slotMinutes: Number(slotMinutes),
    weekTemplate,
    exceptions,
  };
  saveDB(db);

  res.json(db.availability[masterId]);
});

export default router;
