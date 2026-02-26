const express = require("express");
const router = express.Router();
const { loadDB, saveDB } = require("../db");

const BUSY_STATUSES = new Set(["NEW", "ACCEPTED", "DONE"]);

function intervalsForDate(av, dateStr) {
  const ex = av.exceptions && av.exceptions[dateStr];
  if (ex) return ex;
  const dow = new Date(dateStr + "T00:00:00").getDay();
  return av.weekTemplate[dow] || [];
}

function assertSlotFree(db, masterId, desiredISO) {
  const av = (db.availability || []).find(
    (a) => Number(a.masterId) === Number(masterId)
  );
  if (!av)
    throw Object.assign(new Error("Расписание мастера не задано"), {
      status: 400,
    });

  const slotMinutes = av.slotMinutes || 30;
  const dt = new Date(desiredISO);
  if (isNaN(dt))
    throw Object.assign(new Error("Некорректная дата/время"), { status: 400 });

  const dateStr = dt.toISOString().slice(0, 10);
  const hh = dt.getHours().toString().padStart(2, "0");
  const mm = dt.getMinutes().toString().padStart(2, "0");
  const timeStr = `${hh}:${mm}`;

  // слот должен помещаться в один из рабочих интервалов
  const ints = intervalsForDate(av, dateStr);
  const fits = ints.some(([from, to]) => {
    const [fh, fm] = from.split(":").map(Number);
    const [th, tm] = to.split(":").map(Number);
    const start = fh * 60 + fm,
      end = th * 60 + tm;
    const m = dt.getHours() * 60 + dt.getMinutes();
    return m >= start && m + slotMinutes <= end;
  });
  if (!fits)
    throw Object.assign(new Error("Выбранное время вне рабочего графика"), {
      status: 400,
    });

  // пересечение с заказами этого мастера
  const ms = dt.getTime(),
    me = ms + slotMinutes * 60 * 1000;
  const clash = db.orders.some((o) => {
    if (Number(o.masterId) !== Number(masterId)) return false;
    if (!o.desired_datetime) return false;
    if (!BUSY_STATUSES.has(o.status)) return false;
    const os = new Date(o.desired_datetime).getTime();
    const oe = os + slotMinutes * 60 * 1000;
    return Math.max(ms, os) < Math.min(me, oe);
  });
  if (clash)
    throw Object.assign(new Error("Этот слот уже занят"), { status: 409 });
}

// POST /api/orders
router.post("/", (req, res) => {
  const db = loadDB();
  const { serviceId, desired_datetime, comment } = req.body || {};

  // Получаем юзера из вашего auth-мидлвара
  const user = req.user && db.users.find((u) => u.id === req.user.id);
  if (!user || user.role !== "client") {
    return res
      .status(403)
      .json({ message: "Только клиент может создавать заказ" });
  }

  const service = db.services.find((s) => s.id === Number(serviceId));
  if (!service) return res.status(404).json({ message: "Service not found" });

  if (!desired_datetime) {
    return res
      .status(400)
      .json({ message: "Укажите дату и время (desired_datetime)" });
  }

  try {
    assertSlotFree(db, service.masterId, desired_datetime);
  } catch (e) {
    return res.status(e.status || 400).json({ message: e.message });
  }

  db.counters.orders = (db.counters.orders || 0) + 1;
  const id = db.counters.orders;

  const ord = {
    id,
    serviceId: service.id,
    masterId: service.masterId,
    clientId: user.id,
    comment: comment || "",
    desired_datetime,
    status: "NEW",
    status_date: new Date().toISOString(),
  };
  db.orders.push(ord);
  saveDB(db);
  res.json(ord);
});

module.exports = router;
