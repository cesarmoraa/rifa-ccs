const state = {
  tickets: [],
  selectedNumbers: new Set(),
  currentReservation: null,
  pollTicketsTimer: null,
  pollReservationTimer: null,
  countdownTimer: null
};

const elements = {
  ticketGrid: document.getElementById("ticket-grid"),
  feedbackBox: document.getElementById("feedback-box"),
  selectedEmpty: document.getElementById("selected-empty"),
  selectedList: document.getElementById("selected-list"),
  selectedCount: document.getElementById("selected-count"),
  selectedTotal: document.getElementById("selected-total"),
  buyerName: document.getElementById("buyer-name"),
  buyerPhone: document.getElementById("buyer-phone"),
  buyerEmail: document.getElementById("buyer-email"),
  buyerNotes: document.getElementById("buyer-notes"),
  reservationForm: document.getElementById("reservation-form"),
  clearSelectionButton: document.getElementById("clear-selection-button"),
  refreshButton: document.getElementById("refresh-button"),
  metricAvailable: document.getElementById("metric-available"),
  metricPaid: document.getElementById("metric-paid"),
  banner: document.getElementById("reservation-banner"),
  bannerTitle: document.getElementById("banner-title"),
  bannerCopy: document.getElementById("banner-copy"),
  bannerTimer: document.getElementById("banner-timer"),
  transferExample: document.getElementById("transfer-example"),
  submitReservationButton: document.getElementById("submit-reservation-button")
};

const reservationStorageKey = "ccs_current_reservation";

bootstrap();

async function bootstrap() {
  bindEvents();
  restoreReservationPointer();
  await Promise.all([loadTickets(), loadCurrentReservation()]);
  startTicketPolling();
}

function bindEvents() {
  [elements.buyerName, elements.buyerPhone, elements.buyerEmail, elements.buyerNotes].forEach((field) => {
    field.addEventListener("input", updateTransferExample);
  });

  elements.clearSelectionButton.addEventListener("click", () => {
    state.selectedNumbers.clear();
    renderSelectedNumbers();
    updateTransferExample();
  });

  elements.refreshButton.addEventListener("click", async () => {
    await loadTickets();
    if (state.currentReservation) {
      await loadCurrentReservation();
    }
  });

  elements.reservationForm.addEventListener("submit", handleReservationSubmit);
}

async function handleReservationSubmit(event) {
  event.preventDefault();
  hideFeedback();

  const numbers = Array.from(state.selectedNumbers).sort((left, right) => left - right);
  if (!numbers.length) {
    showFeedback("Selecciona al menos un número disponible.", "error");
    return;
  }

  const payload = {
    numbers,
    buyerName: elements.buyerName.value.trim(),
    buyerPhone: elements.buyerPhone.value.trim(),
    buyerEmail: elements.buyerEmail.value.trim(),
    notes: elements.buyerNotes.value.trim()
  };

  elements.submitReservationButton.disabled = true;
  elements.submitReservationButton.textContent = "Procesando reserva...";

  try {
    const response = await fetch("/api/public/reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      const unavailableNumbers = Array.isArray(result.unavailable_numbers)
        ? result.unavailable_numbers.map(formatTicketNumber).join(", ")
        : "";
      const message = unavailableNumbers
        ? `${result.message} Números afectados: ${unavailableNumbers}.`
        : result.message || "No fue posible completar la reserva.";
      showFeedback(message, "error");
      await loadTickets();
      return;
    }

    const reservation = normalizeReservation(result.reservation);
    persistReservationPointer(reservation.id, reservation.access_token);
    state.currentReservation = reservation;
    state.selectedNumbers.clear();

    showFeedback(
      "Reserva creada correctamente. Tus números quedaron bloqueados por 1 día.",
      "success"
    );

    renderSelectedNumbers();
    updateTransferExample();
    await Promise.all([loadTickets(), loadCurrentReservation()]);
  } catch (error) {
    showFeedback(error.message || "Ocurrió un error inesperado.", "error");
  } finally {
    elements.submitReservationButton.disabled = false;
    elements.submitReservationButton.textContent = "Confirmar reserva y bloquear números";
  }
}

async function loadTickets() {
  const response = await fetch("/api/public/tickets");
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || "No fue posible cargar los tickets.");
  }

  state.tickets = payload.tickets;
  renderMetrics();
  renderTicketGrid();
}

async function loadCurrentReservation() {
  const pointer = readReservationPointer();
  if (!pointer) {
    state.currentReservation = null;
    stopReservationPolling();
    renderReservationBanner();
    return;
  }

  const searchParams = new URLSearchParams({
    reservationId: pointer.reservationId,
    accessToken: pointer.accessToken
  });
  const response = await fetch(`/api/public/reservations/current?${searchParams.toString()}`);
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    clearReservationPointer();
    state.currentReservation = null;
    stopReservationPolling();
    renderReservationBanner();
    return;
  }

  state.currentReservation = normalizeReservation(payload.reservation);
  renderReservationBanner();
  updateTransferExample();
  startReservationPolling();
}

function renderMetrics() {
  const available = state.tickets.filter((ticket) => ticket.status === "available").length;
  const paid = state.tickets.filter((ticket) => ticket.status === "paid_confirmed").length;

  elements.metricAvailable.textContent = String(available);
  elements.metricPaid.textContent = String(paid);
}

function renderTicketGrid() {
  elements.ticketGrid.innerHTML = "";

  const fragment = document.createDocumentFragment();
  for (const ticket of state.tickets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ticket-button ${statusClassName(ticket.status)}`;
    button.textContent = ticket.label;
    button.dataset.number = String(ticket.number);
    button.dataset.status = ticket.status;
    button.title = statusLabel(ticket.status);

    const isSelectable = ticket.status === "available";
    const isSelected = state.selectedNumbers.has(ticket.number);

    if (!isSelectable) {
      button.disabled = true;
    }

    if (isSelected) {
      button.classList.add("selected");
    }

    button.addEventListener("click", () => toggleSelection(ticket.number));
    fragment.appendChild(button);
  }

  elements.ticketGrid.appendChild(fragment);
}

function toggleSelection(number) {
  const ticket = state.tickets.find((item) => item.number === number);
  if (!ticket || ticket.status !== "available") {
    return;
  }

  if (state.selectedNumbers.has(number)) {
    state.selectedNumbers.delete(number);
  } else {
    state.selectedNumbers.add(number);
  }

  renderSelectedNumbers();
  renderTicketGrid();
  updateTransferExample();
}

function renderSelectedNumbers() {
  const numbers = Array.from(state.selectedNumbers).sort((left, right) => left - right);
  elements.selectedList.innerHTML = "";
  elements.selectedEmpty.classList.toggle("hidden", numbers.length > 0);

  const fragment = document.createDocumentFragment();
  for (const number of numbers) {
    const chip = document.createElement("div");
    chip.className = "selected-chip";
    chip.innerHTML = `
      <span>${formatTicketNumber(number)}</span>
      <button type="button" aria-label="Quitar ${formatTicketNumber(number)}">×</button>
    `;
    chip.querySelector("button").addEventListener("click", () => {
      state.selectedNumbers.delete(number);
      renderSelectedNumbers();
      renderTicketGrid();
      updateTransferExample();
    });
    fragment.appendChild(chip);
  }

  elements.selectedList.appendChild(fragment);
  elements.selectedCount.textContent = String(numbers.length);
  elements.selectedTotal.textContent = formatCurrency(numbers.length * 10000);
}

function renderReservationBanner() {
  stopCountdown();

  if (!state.currentReservation) {
    elements.banner.classList.add("hidden");
    return;
  }

  const reservation = state.currentReservation;
  const numbersLabel = reservation.numbers.map(formatTicketNumber).join("-");
  const buyerName = reservation.buyer_name || "Comprador";

  elements.banner.classList.remove("hidden");
  elements.bannerTitle.textContent = `${statusLabel(reservation.status)} · ${numbersLabel}`;

  if (reservation.status === "paid_confirmed") {
    elements.bannerCopy.textContent =
      "El pago ya fue validado por Solange. Tus números quedaron confirmados.";
    elements.bannerTimer.textContent = "PAGADO";
  } else if (reservation.status === "expired" || reservation.status === "released") {
    elements.bannerCopy.textContent =
      "El plazo terminó o la reserva fue liberada. Los números volvieron al stock disponible.";
    elements.bannerTimer.textContent = "EXPIRADO";
    clearReservationPointer();
    stopReservationPolling();
  } else if (reservation.status === "conflict") {
    elements.bannerCopy.textContent =
      reservation.conflict_reason || "Hay un conflicto pendiente de revisión por el equipo CCS.";
    elements.bannerTimer.textContent = "REVISAR";
  } else {
    elements.bannerCopy.textContent =
      "Si no realizas la transferencia y el pago no es validado dentro del plazo, volverán a quedar disponibles.";
    startCountdown(reservation.hold_expires_at);
  }

  elements.transferExample.textContent = `Rifa ${numbersLabel} ${buyerName}`;
}

function startCountdown(holdExpiresAt) {
  stopCountdown();

  const renderTick = () => {
    const msLeft = new Date(holdExpiresAt).getTime() - Date.now();
    if (msLeft <= 0) {
      elements.bannerTimer.textContent = "00:00";
      loadTickets().catch(() => null);
      loadCurrentReservation().catch(() => null);
      stopCountdown();
      return;
    }
    elements.bannerTimer.textContent = formatRemaining(msLeft);
  };

  renderTick();
  state.countdownTimer = window.setInterval(renderTick, 1000);
}

function stopCountdown() {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
}

function startTicketPolling() {
  stopTicketPolling();
  state.pollTicketsTimer = window.setInterval(() => {
    loadTickets().catch(() => null);
  }, 15000);
}

function stopTicketPolling() {
  if (state.pollTicketsTimer) {
    clearInterval(state.pollTicketsTimer);
    state.pollTicketsTimer = null;
  }
}

function startReservationPolling() {
  if (state.pollReservationTimer) {
    return;
  }
  state.pollReservationTimer = window.setInterval(() => {
    loadCurrentReservation().catch(() => null);
    loadTickets().catch(() => null);
  }, 12000);
}

function stopReservationPolling() {
  if (state.pollReservationTimer) {
    clearInterval(state.pollReservationTimer);
    state.pollReservationTimer = null;
  }
}

function updateTransferExample() {
  if (state.currentReservation?.numbers?.length) {
    const buyerName = state.currentReservation.buyer_name || "Comprador";
    const numbersLabel = state.currentReservation.numbers.map(formatTicketNumber).join("-");
    elements.transferExample.textContent = `Rifa ${numbersLabel} ${buyerName}`;
    return;
  }

  const selectedNumbers = Array.from(state.selectedNumbers)
    .sort((left, right) => left - right)
    .map(formatTicketNumber)
    .join("-");
  const buyerName = elements.buyerName.value.trim() || "Juan Pérez";
  elements.transferExample.textContent = `Rifa ${selectedNumbers || "045-046-047"} ${buyerName}`;
}

function showFeedback(message, tone) {
  elements.feedbackBox.textContent = message;
  elements.feedbackBox.className = `feedback-box ${tone}`;
}

function hideFeedback() {
  elements.feedbackBox.textContent = "";
  elements.feedbackBox.className = "feedback-box hidden";
}

function restoreReservationPointer() {
  const pointer = readReservationPointer();
  if (!pointer) {
    return;
  }
  state.currentReservation = { id: pointer.reservationId, access_token: pointer.accessToken };
}

function persistReservationPointer(reservationId, accessToken) {
  localStorage.setItem(
    reservationStorageKey,
    JSON.stringify({ reservationId, accessToken })
  );
}

function readReservationPointer() {
  const raw = localStorage.getItem(reservationStorageKey);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearReservationPointer() {
  localStorage.removeItem(reservationStorageKey);
}

function normalizeReservation(reservation) {
  return {
    ...reservation,
    numbers: Array.isArray(reservation.numbers)
      ? reservation.numbers.map(Number)
      : []
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
    case "available":
      return "Disponible";
    case "held":
      return "Bloqueado temporalmente";
    case "reserved_pending_payment":
      return "Reservado pendiente de pago";
    case "paid_confirmed":
      return "Pagado confirmado";
    case "released":
      return "Liberado";
    case "expired":
      return "Expirado";
    case "conflict":
      return "Conflicto";
    default:
      return status;
  }
}

function formatTicketNumber(number) {
  return String(number).padStart(3, "0");
}

function formatCurrency(value) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0
  }).format(value);
}

function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
