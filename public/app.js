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
    const h = { ...(headers || {}) };
    if (body !== undefined && !h["Content-Type"]) {
      h["Content-Type"] = "application/json";
    }

    const t = getToken();
    if (t) h["Authorization"] = "Bearer " + t;

    const res = await fetch("/api" + path, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
    },
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
      return API.request("/orders");
    },
    get(id) {
      return API.request(`/orders/${id}`);
    },
    create(serviceId, desired_datetime, comment) {
      return API.request("/orders", {
        method: "POST",
        body: { serviceId, desired_datetime, comment },
      });
    },
    reschedule(id, desired_datetime, comment) {
      return API.request(`/orders/${id}/reschedule`, {
        method: "PATCH",
        body: { desired_datetime, comment },
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

  analytics: {
    summary() {
      return API.request("/analytics/summary");
    },
  },

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
      const u = new URLSearchParams({ date: dateStr });
      return API.request(`/availability/${masterId}/slots?${u.toString()}`);
    },
  },

  notifications: {
    list({ limit = 20, offset = 0, unreadOnly = false } = {}) {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      if (unreadOnly) params.set("unreadOnly", "1");
      return API.request(`/notifications?${params.toString()}`);
    },
    unreadCount() {
      return API.request("/notifications/unread-count");
    },
    markRead(id) {
      return API.request(`/notifications/${id}/read`, { method: "PATCH" });
    },
    markAllRead() {
      return API.request("/notifications/read-all", { method: "PATCH" });
    },
  },
};

window.API = API;

// ===== header/nav + notifications
let currentHeaderUser = null;
let notificationsPollTimer = null;
let notificationsShellReady = false;

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
  currentHeaderUser = user;

  const here = location.pathname;
  const link = (href, title) =>
    `<a href="${href}" class="${here.endsWith(href) ? "active" : ""}">${title}</a>`;

  let html = "";
  html += link("/catalog.html", "Каталог");

  if (user) {
    html += `
      <button type="button" class="nav-btn nav-notify" id="notificationsToggle" aria-expanded="false" aria-controls="notificationsPanel">
        <span class="nav-notify-icon">🔔</span>
        <span>Уведомления</span>
        <span class="nav-badge hidden" id="navNotificationsBadge">0</span>
      </button>
    `;

    if (user.role === "master") {
      html += link("/master.html", "ЛК мастера");
      html += link("/analytics.html", "Аналитика");
      html += `<a href="#" id="logout">Выход</a>`;
    } else {
      html += link("/client.html", "ЛК клиента");
      html += `<a href="#" id="logout">Выход</a>`;
    }
  } else {
    html += link("/login.html", "Вход");
  }

  nav.innerHTML = html;

  const lo = document.getElementById("logout");
  if (lo) {
    lo.onclick = (e) => {
      e.preventDefault();
      stopNotificationsPolling();
      setToken(null);
      closeNotificationsPanel();
      location.href = "/";
    };
  }

  const toggle = document.getElementById("notificationsToggle");
  if (toggle && user) {
    ensureNotificationsShell();
    toggle.onclick = async (e) => {
      e.preventDefault();
      if (document.body.classList.contains("notifications-open")) {
        closeNotificationsPanel();
      } else {
        await openNotificationsPanel();
      }
    };
    await refreshNotificationsCount();
    startNotificationsPolling();
  } else {
    stopNotificationsPolling();
    closeNotificationsPanel();
  }
}

function ensureNotificationsShell() {
  if (notificationsShellReady) return;

  const shell = document.createElement("div");
  shell.id = "notificationsShell";
  shell.innerHTML = `
    <div class="notifications-backdrop" id="notificationsBackdrop"></div>
    <aside class="notifications-panel" id="notificationsPanel" aria-hidden="true">
      <div class="notifications-head">
        <div>
          <h3>Уведомления</h3>
          <div class="help" id="notificationsHint">Здесь появляются напоминания и изменения по заказам.</div>
        </div>
        <div class="notifications-head-actions">
          <button type="button" class="btn-secondary" id="notificationsReadAll">Прочитать все</button>
          <button type="button" class="btn-secondary" id="notificationsClose">×</button>
        </div>
      </div>
      <div class="notifications-body" id="notificationsBody">
        <div class="empty">Загрузка…</div>
      </div>
    </aside>
  `;
  document.body.append(shell);

  document.getElementById("notificationsBackdrop").addEventListener("click", closeNotificationsPanel);
  document.getElementById("notificationsClose").addEventListener("click", closeNotificationsPanel);
  document.getElementById("notificationsReadAll").addEventListener("click", async () => {
    try {
      await API.notifications.markAllRead();
      await renderNotificationsPanel(true);
    } catch {
      renderNotificationsError("Не удалось пометить уведомления как прочитанные.");
    }
  });

  document.addEventListener("click", (e) => {
    if (!document.body.classList.contains("notifications-open")) return;
    const panel = document.getElementById("notificationsPanel");
    const toggle = document.getElementById("notificationsToggle");
    if (!panel || !toggle) return;
    if (panel.contains(e.target) || toggle.contains(e.target)) return;
    closeNotificationsPanel();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeNotificationsPanel();
  });

  notificationsShellReady = true;
}

async function openNotificationsPanel() {
  if (!currentHeaderUser) return;
  ensureNotificationsShell();
  document.body.classList.add("notifications-open");
  const panel = document.getElementById("notificationsPanel");
  const toggle = document.getElementById("notificationsToggle");
  if (panel) panel.setAttribute("aria-hidden", "false");
  if (toggle) toggle.setAttribute("aria-expanded", "true");
  await renderNotificationsPanel(true);
}

function closeNotificationsPanel() {
  document.body.classList.remove("notifications-open");
  const panel = document.getElementById("notificationsPanel");
  const toggle = document.getElementById("notificationsToggle");
  if (panel) panel.setAttribute("aria-hidden", "true");
  if (toggle) toggle.setAttribute("aria-expanded", "false");
}

function startNotificationsPolling() {
  stopNotificationsPolling();
  if (!currentHeaderUser) return;
  notificationsPollTimer = window.setInterval(() => {
    if (document.hidden) return;
    refreshNotificationsCount();
  }, 30000);
}

function stopNotificationsPolling() {
  if (notificationsPollTimer) {
    clearInterval(notificationsPollTimer);
    notificationsPollTimer = null;
  }
}

function setNotificationsBadge(unread) {
  const badge = document.getElementById("navNotificationsBadge");
  if (!badge) return;
  const count = Number(unread) || 0;
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.classList.toggle("hidden", count <= 0);
  window.dispatchEvent(new CustomEvent("agrus:notifications-updated", { detail: { unread: count } }));
}

async function refreshNotificationsCount() {
  if (!currentHeaderUser) return 0;
  try {
    const data = await API.notifications.unreadCount();
    const unread = Number(data?.unread) || 0;
    setNotificationsBadge(unread);
    return unread;
  } catch {
    return 0;
  }
}

function renderNotificationsError(message) {
  const body = document.getElementById("notificationsBody");
  if (!body) return;
  body.innerHTML = `<div class="empty">${message}</div>`;
}

async function renderNotificationsPanel(forceReload = false) {
  const body = document.getElementById("notificationsBody");
  if (!body || !currentHeaderUser) return;

  if (forceReload) {
    body.innerHTML = `<div class="empty">Загрузка уведомлений…</div>`;
  }

  try {
    const payload = await API.notifications.list({ limit: 20 });
    const items = Array.isArray(payload?.items) ? payload.items : [];
    setNotificationsBadge(payload?.unread || 0);

    if (!items.length) {
      body.innerHTML = `<div class="empty">Пока нет уведомлений. Когда появятся новые заявки, переносы или напоминания, они будут здесь.</div>`;
      return;
    }

    body.innerHTML = "";
    const frag = document.createDocumentFragment();

    items.forEach((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `notification-item ${item.isRead ? "is-read" : "is-unread"}`;

      const targetHref = getNotificationTarget(item);
      const timeLabel = getNotificationTimeLabel(item);
      const actionLabel = targetHref
        ? currentHeaderUser?.role === "master"
          ? "Открыть заказ"
          : "Открыть мои заказы"
        : "Прочитать";

      btn.innerHTML = `
        <div class="notification-item-head">
          <strong>${escapeHtml(item.title || "Уведомление")}</strong>
          <span class="notification-time">${escapeHtml(timeLabel)}</span>
        </div>
        <div class="notification-message">${escapeHtml(item.message || "")}</div>
        <div class="notification-meta">
          <span class="notification-chip">${escapeHtml(notificationTypeLabel(item.type))}</span>
          <span class="notification-link-text">${escapeHtml(actionLabel)}</span>
        </div>
      `;

      btn.addEventListener("click", async () => {
        try {
          if (!item.isRead) {
            await API.notifications.markRead(item.id);
          }
        } catch {}

        await refreshNotificationsCount();

        if (targetHref) {
          location.href = targetHref;
          return;
        }

        await renderNotificationsPanel(true);
      });

      frag.append(btn);
    });

    body.append(frag);
  } catch {
    renderNotificationsError("Не удалось загрузить уведомления.");
  }
}

function getNotificationTarget(item) {
  const orderId = item?.orderId || item?.meta?.orderId;
  if (!currentHeaderUser || !orderId) return "";
  const base = currentHeaderUser.role === "master" ? "/master.html" : "/client.html";
  return `${base}?tab=orders&orderId=${encodeURIComponent(orderId)}`;
}

function notificationTypeLabel(type) {
  const map = {
    ORDER_CREATED: "Новая заявка",
    ORDER_REMINDER: "Напоминание",
    ORDER_STATUS_CHANGED: "Статус заказа",
    ORDER_RESCHEDULED: "Перенос времени",
  };
  return map[type] || "Уведомление";
}

function getNotificationTimeLabel(item) {
  const candidate = item?.meta?.desired_datetime || item?.scheduledFor || item?.created_at;
  return formatAnyDateTime(candidate);
}

// ===== misc utils
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

const RU_MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parsePseudoUtcParts(value) {
  if (value == null || value === "") return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return {
      year: value.getFullYear(),
      monthIndex: value.getMonth(),
      day: value.getDate(),
      hours: value.getHours(),
      minutes: value.getMinutes(),
      seconds: value.getSeconds(),
      milliseconds: value.getMilliseconds(),
    };
  }

  const raw = String(value).trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?/);
  if (!m) return null;

  return {
    year: Number(m[1]),
    monthIndex: Number(m[2]) - 1,
    day: Number(m[3]),
    hours: Number(m[4] || 0),
    minutes: Number(m[5] || 0),
    seconds: Number(m[6] || 0),
    milliseconds: Number(String(m[7] || "0").padEnd(3, "0")),
  };
}

function formatPseudoUtcDateTime(value) {
  const parts = parsePseudoUtcParts(value);
  if (!parts) return "—";
  return `${parts.day} ${RU_MONTHS_GENITIVE[parts.monthIndex]} ${parts.year} г. в ${pad2(parts.hours)}:${pad2(parts.minutes)}`;
}

function formatPseudoUtcTimeRange(startValue, endValue) {
  const start = parsePseudoUtcParts(startValue);
  const end = parsePseudoUtcParts(endValue);
  if (!start || !end) return "—";

  let endLabel = `${pad2(end.hours)}:${pad2(end.minutes)}`;
  if (
    start.year !== end.year ||
    start.monthIndex !== end.monthIndex ||
    start.day !== end.day
  ) {
    endLabel += " (след. дня)";
  }

  return `${pad2(start.hours)}:${pad2(start.minutes)} — ${endLabel}`;
}

function formatAnyDateTime(value) {
  if (value == null || value === "") return "—";

  if (typeof value === "number" || /^\d+$/.test(String(value).trim())) {
    const d = new Date(Number(value));
    if (!Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
    }
  }

  const pseudo = parsePseudoUtcParts(value);
  if (pseudo) return formatPseudoUtcDateTime(value);

  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  return String(value);
}

function getPseudoUtcComparableTimestamp(value) {
  const parts = parsePseudoUtcParts(value);
  if (!parts) return Number.NaN;
  return Date.UTC(
    parts.year,
    parts.monthIndex,
    parts.day,
    parts.hours,
    parts.minutes,
    parts.seconds,
    parts.milliseconds
  );
}

function getNowComparablePseudoUtcTimestamp() {
  const now = new Date();
  return Date.UTC(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds()
  );
}

function isPseudoUtcValueInPast(value) {
  const comparable = getPseudoUtcComparableTimestamp(value);
  return Number.isFinite(comparable) && comparable < getNowComparablePseudoUtcTimestamp();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ===== availability local fallback
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

window.AGRUS = {
  refreshNav: updateNav,
  refreshNotifications: refreshNotificationsCount,
  openNotifications: openNotificationsPanel,
  closeNotifications: closeNotificationsPanel,
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", renderHeader);
} else {
  renderHeader();
}
