// public/app.js
// ===== token helpers
const TOKEN_KEY = "agrus_token";
function setToken(t) {
  t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);
}
function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

// ===== API wrapper
const API = {
  async request(path, { method = "GET", body, headers } = {}) {
    const h = { "Content-Type": "application/json", ...(headers || {}) };
    const t = getToken();
    if (t) h["Authorization"] = "Bearer " + t;
    const res = await fetch("/api" + path, {
      method,
      headers: h,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok) {
      const err = new Error(
        (data && data.error) || (data && data.message) || "API " + res.status
      );
      err.status = res.status;
      err.details = data;
      throw err;
    }
    return data;
  },

  // auth + user
  getMe() {
    return API.request("/users/me");
  },
  login(email, password) {
    return API.request("/auth/login", {
      method: "POST",
      body: { email, password },
    });
  },
  register(payload) {
    return API.request("/auth/register", { method: "POST", body: payload });
  },

  // categories
  categories: {
    list() {
      return API.request("/categories");
    },
    create(name) {
      return API.request("/categories", { method: "POST", body: { name } });
    },
    update(id, body) {
      return API.request(`/categories/${id}`, { method: "PUT", body });
    },
    delete(id) {
      return API.request(`/categories/${id}`, { method: "DELETE" });
    },
  },

  // services
  services: {
    list() {
      return API.request("/services");
    },
    get(id) {
      return API.request(`/services/${id}`);
    }, // опциональный, если есть на сервере
    create(body) {
      return API.request("/services", { method: "POST", body });
    },
    update(id, body) {
      return API.request(`/services/${id}`, { method: "PUT", body });
    },
    delete(id) {
      return API.request(`/services/${id}`, { method: "DELETE" });
    },
  },

  // orders
  orders: {
    list() {
      return API.request("/orders"); // по роли вернёт "свои"
    },
    get(id) {
      return API.request(`/orders/${id}`); // ПОДРОБНОСТИ ЗАКАЗА (новое)
    },
    create(serviceId, desired_datetime, comment) {
      return API.request("/orders", {
        method: "POST",
        body: { serviceId, desired_datetime, comment },
      });
    },
    async setStatus(id, status, reason) {
      try {
        return await API.request(`/orders/${id}/status`, {
          method: "PATCH",
          body: { status, reason },
        });
      } catch {
        return await API.request(`/orders/${id}/status`, {
          method: "PUT",
          body: { status, reason },
        });
      }
    },
  },

  // analytics (мастер)
  analytics: {
    summary() {
      return API.request("/analytics/summary");
    },
  },

  // availability (расписание мастера) + слоты на день
  availability: {
    async get(masterId) {
      return API.request(`/availability/${masterId}`);
    },
    async set(masterId, payload) {
      return API.request(`/availability/${masterId}`, {
        method: "PUT",
        body: payload,
      });
    },
    async slots(masterId, dateStr) {
      // YYYY-MM-DD
      const u = new URLSearchParams({ date: dateStr });
      return API.request(`/availability/${masterId}/slots?${u.toString()}`);
    },
  },
};

// ===== header/nav with logo + "Каталог"
function renderHeader() {
  if (document.querySelector("header")) {
    updateNav();
    return;
  }
  const header = document.createElement("header");
  header.innerHTML = `
    <div class="logo">
      <a href="/"><img class="logo-img" src="/logo.png" alt="АГРУС" /><span>АГРУС</span></a>
    </div>
    <nav class="nav" id="nav"></nav>`;
  document.body.prepend(header);
  updateNav();
}

async function updateNav() {
  const nav = document.getElementById("nav");
  if (!nav) return;
  let user = null;
  try {
    user = await API.getMe();
  } catch {}
  const here = location.pathname;
  const link = (href, title) =>
    `<a href="${href}" class="${
      here.endsWith(href) ? "active" : ""
    }">${title}</a>`;
  let html = "";
  html += link("/catalog.html", "Каталог");
  if (user) {
    if (user.role === "master") {
      html += link("/master.html", "ЛК мастера");
      // Заказы — убираем из шапки, они во вкладке ЛК мастера
      html += link("/analytics.html", "Аналитика");
      html += `<a href="#" id="logout">Выход</a>`;
    } else {
      html += link("/client.html", "ЛК клиента");
      // "Мои заказы" — убираем из шапки по требованию
      html += `<a href="#" id="logout">Выход</a>`;
    }
  } else {
    html += link("/login.html", "Вход");
  }
  nav.innerHTML = html;
  const lo = document.getElementById("logout");
  if (lo)
    lo.onclick = (e) => {
      e.preventDefault();
      setToken(null);
      location.href = "/";
    };
}

document.addEventListener("DOMContentLoaded", renderHeader);

// ===== misc utils (для разных страниц)
function statusLabel(st) {
  const map = {
    NEW: "Новый",
    ACCEPTED: "Принят",
    DONE: "Выполнен",
    REJECTED: "Отклонён",
    CANCELLED: "Отменён",
  };
  return map[st] || st;
}

// ===== availability local fallback (на всякий)
const LS_KEY = (id) => `agrus_availability_${id}`;
function loadLS(id) {
  try {
    const v = localStorage.getItem(LS_KEY(id));
    if (!v) return defaultAvailability();
    return JSON.parse(v);
  } catch {
    return defaultAvailability();
  }
}
function saveLS(id, payload) {
  localStorage.setItem(LS_KEY(id), JSON.stringify(payload));
}
function defaultAvailability() {
  return {
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
}
