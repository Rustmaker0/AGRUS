// Простая обёртка над db.json (без зависимостей)
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "db.json");

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    // создаём пустую структуру, если файла нет/повреждён
    return {
      counters: { users: 0, categories: 0, services: 0, orders: 0 },
      users: [],
      categories: [],
      services: [],
      orders: [],
      sessions: [],
      availability: [], // <— добавили хранилище расписаний
    };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

module.exports = { loadDB, saveDB, DB_PATH };
