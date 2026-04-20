const state = {
  tickets: [],
  reservations: [],
  events: [],
  refreshTimer: null
};

const elements = {
  searchInput: document.getElementById("search-input"),
  statusFilter: document.getElementById("status-filter"),
  refreshButton: document.getElementById("admin-refresh-button"),
  logoutButton: document.getElementById("logout-button"),
  statsGrid: document.getElementById("stats-grid"),
  ticketGrid: document.getElementById("admin-ticket-grid"),
  reservationList: document.getElementById("reservation-list"),
  eventsList: document.getElementById("events-list"),
  feedback: document.getElementById("admin-feedback")
};

bootstrap();

async function bootstrap() {
  bindEvents();
  await loadDashboard();
  state.refreshTimer = window.setInterval(loadDashboard, 15000);
}

function bindEvents() {
  elements.searchInput.addEventListener("input", debounce(loadDashboard, 250));
  elements.statusFilter.addEventListener("change", loadDashboard);
  elements.refreshButton.addEventListener("click", loadDashboard);
  elements.logoutButton.addEventListener("click", handleLogout);
}

async function handleLogout() {
  await fetch("/api/admin/logout", { method: "POST" });
  window.location.href = "/admin/login";
}

async function loadDashboard() {
  const searchParams = new URLSearchParams({
    query: elements.searchInput.value.trim(),
    status: elements.statusFilter.value
  });

  const response = await fetch(`/api/admin/dashboard?${searchParams.toString()}`);
  const payload = await response.json();

  if (response.status === 401) {
    window.location.href = "/admin/login";
    return;
  }

  if (!response.ok || !payload.ok) {
    showFeedback(payload.message || "No fue posible cargar el panel.", "error");
    return;
  }

  hideFeedback();
  state.tickets = payload.tickets;
  state.reservations = payload.reservations;
  state.events = payload.events;
  renderStats(payload.summary);
  renderTicketGrid();
  renderReservations();
  renderEvents();
}

function renderStats(summary) {
  const items = [
    ["Disponibles", summary.tickets.available],
    ["Bloqueados", summary.tickets.held + summary.tickets.reserved_pending_payment],
    ["Pagados", summary.tickets.paid_confirmed],
    ["Ventas confirmadas", formatCurrency(summary.totalSalesAmount)]
  ];

  elements.statsGrid.innerHTML = items
    .map(
      ([label, value]) => `
        <article class="stat-card">
          <span>${label}</span>
          <strong>${value}</strong>
        </article>
      `
    )
    .join("");
}

function renderTicketGrid() {
  elements.ticketGrid.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const ticket of state.tickets) {
    const tile = document.createElement("div");
    tile.className = `ticket-button ${statusClassName(ticket.status)}`;
    tile.textContent = ticket.label;
    tile.title = `${ticket.label} · ${statusLabel(ticket.status)}`;
    fragment.appendChild(tile);
  }

  elements.ticketGrid.appendChild(fragment);
}

function renderReservations() {
  if (!state.reservations.length) {
    elements.reservationList.innerHTML = '<div class="empty-admin">No hay reservas para mostrar con los filtros actuales.</div>';
    return;
  }

  elements.reservationList.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const reservation of state.reservations) {
    const card = document.createElement("article");
    card.className = "reservation-card";
    card.innerHTML = `
      <div class="reservation-card-head">
        <div>
          <span class="section-kicker">Reserva ${reservation.reservation_code}</span>
          <h3>${reservation.numbers_label || "Sin números"}</h3>
        </div>
        <span class="status-pill status-${reservation.status}">${statusLabel(reservation.status)}</span>
      </div>

      <div class="reservation-meta">
        <div>
          <span>Comprador</span>
          <strong>${escapeHtml(reservation.buyer_name || "-")}</strong>
        </div>
        <div>
          <span>Teléfono</span>
          <strong>${escapeHtml(reservation.buyer_phone || "-")}</strong>
        </div>
        <div>
          <span>Correo</span>
          <strong>${escapeHtml(reservation.buyer_email || "-")}</strong>
        </div>
        <div>
          <span>Expira / Pago</span>
          <strong>${formatImportantDate(reservation)}</strong>
        </div>
      </div>

      ${reservation.notes ? `<p>${escapeHtml(reservation.notes)}</p>` : ""}

      <div class="reservation-actions"></div>
    `;

    const actionsContainer = card.querySelector(".reservation-actions");
    buildReservationActions(reservation).forEach((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.className;
      button.textContent = action.label;
      button.addEventListener("click", () => runReservationAction(reservation.id, action.type));
      actionsContainer.appendChild(button);
    });

    fragment.appendChild(card);
  }

  elements.reservationList.appendChild(fragment);
}

function buildReservationActions(reservation) {
  const actions = [];

  if (reservation.status === "held") {
    actions.push({ type: "mark-pending", label: "Marcar pendiente", className: "button-warning" });
  }

  if (reservation.status === "held" || reservation.status === "reserved_pending_payment") {
    actions.push({ type: "confirm-payment", label: "Confirmar pago", className: "button-primary compact" });
    actions.push({ type: "release", label: "Liberar números", className: "button-danger" });
  }

  if (reservation.status !== "conflict" && reservation.status !== "released" && reservation.status !== "expired") {
    actions.push({ type: "conflict", label: "Marcar conflicto", className: "button-neutral" });
  }

  return actions;
}

async function runReservationAction(reservationId, action) {
  const needsNote = action === "release" || action === "conflict";
  const note = needsNote
    ? window.prompt("Ingresa una nota breve para registrar esta acción:", "") || ""
    : "";

  const response = await fetch(`/api/admin/reservations/${reservationId}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note })
  });
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    showFeedback(payload.message || "La acción no pudo ejecutarse.", "error");
    return;
  }

  showFeedback(payload.message || "Acción aplicada correctamente.", "success");
  await loadDashboard();
}

function renderEvents() {
  if (!state.events.length) {
    elements.eventsList.innerHTML = '<div class="empty-admin">Todavía no hay eventos registrados.</div>';
    return;
  }

  elements.eventsList.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const event of state.events) {
    const card = document.createElement("article");
    card.className = "event-card";
    const detail = event.detail && typeof event.detail === "object"
      ? Object.entries(event.detail)
          .filter(([, value]) => value)
          .map(([key, value]) => `${key}: ${value}`)
          .join(" · ")
      : "";

    card.innerHTML = `
      <div class="event-card-head">
        <div>
          <span class="section-kicker">${escapeHtml(event.event_type)}</span>
          <h3>${formatTicketNumber(event.ticket_number)} · ${escapeHtml(event.reservation_code || "Sin código")}</h3>
        </div>
        <span>${formatDateTime(event.event_at)}</span>
      </div>
      <p>${escapeHtml(event.buyer_name || "Sin comprador")} · ${escapeHtml(event.actor || "system")}${detail ? ` · ${escapeHtml(detail)}` : ""}</p>
    `;
    fragment.appendChild(card);
  }

  elements.eventsList.appendChild(fragment);
}

function showFeedback(message, tone) {
  elements.feedback.textContent = message;
  elements.feedback.className = `feedback-box ${tone}`;
}

function hideFeedback() {
  elements.feedback.textContent = "";
  elements.feedback.className = "feedback-box hidden";
}

function debounce(callback, waitMs) {
  let timerId = null;
  return (...args) => {
    clearTimeout(timerId);
    timerId = window.setTimeout(() => callback(...args), waitMs);
  };
}

function statusClassName(status) {
  switch (status) {
    case "available":
      return "available-state";
    case "held":
      return "held-state";
    case "reserved_pending_payment":
      return "pending-state";
    case "paid_confirmed":
      return "paid-state";
    case "conflict":
      return "conflict-state";
    default:
      return "";
  }
}

function statusLabel(status) {
  switch (status) {
    case "held":
      return "Bloqueado temporalmente";
    case "reserved_pending_payment":
      return "Pendiente de pago";
    case "paid_confirmed":
      return "Pagado confirmado";
    case "released":
      return "Liberado";
    case "expired":
      return "Expirado";
    case "conflict":
      return "Conflicto";
    case "available":
      return "Disponible";
    default:
      return status;
  }
}

function formatCurrency(value) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0
  }).format(value);
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("es-CL", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatImportantDate(reservation) {
  if (reservation.status === "paid_confirmed") {
    return reservation.paid_at ? formatDateTime(reservation.paid_at) : "Pagado";
  }
  if (reservation.hold_expires_at) {
    return formatDateTime(reservation.hold_expires_at);
  }
  if (reservation.released_at) {
    return formatDateTime(reservation.released_at);
  }
  return "-";
}

function formatTicketNumber(number) {
  return String(number).padStart(3, "0");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
