import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadEnvFile(path.join(__dirname, ".env"));

const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "127.0.0.1",
  appUrl: process.env.APP_URL || "http://localhost:3000",
  holdMinutes: Number(process.env.HOLD_MINUTES || 30),
  supabaseUrl: requiredEnv("SUPABASE_URL"),
  supabaseServiceRoleKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  adminPassword: requiredEnv("ADMIN_PASSWORD"),
  adminName: process.env.ADMIN_NAME || "Solange",
  adminSessionSecret: requiredEnv("ADMIN_SESSION_SECRET")
};

const publicDir = path.join(__dirname, "public");
const sessionCookieName = "ccs_admin_session";
const sessionDurationMs = 1000 * 60 * 60 * 12;
const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const server = createServer(async (req, res) => {
  try {
    await routeRequest(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, {
      ok: false,
      message: error instanceof Error ? error.message : "Error interno del servidor."
    });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`CCS Rifa app escuchando en ${config.appUrl}`);
});

async function routeRequest(req, res) {
  const url = new URL(req.url || "/", config.appUrl);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, 200, { ok: true, status: "up" });
  }

  if (pathname.startsWith("/api/")) {
    return handleApi(req, res, url);
  }

  if (pathname === "/") {
    return serveFile(res, path.join(publicDir, "index.html"));
  }

  if (pathname === "/admin/login") {
    return serveFile(res, path.join(publicDir, "admin-login.html"));
  }

  if (pathname === "/admin") {
    if (!isAdminAuthenticated(req)) {
      return redirect(res, "/admin/login");
    }
    return serveFile(res, path.join(publicDir, "admin.html"));
  }

  return serveStaticAsset(res, pathname);
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/public/tickets") {
    await releaseExpiredReservations();
    const tickets = await supabaseSelect(
      "/rest/v1/ticket_public_view?select=number,label,status,hold_expires_at&order=number.asc"
    );
    return sendJson(res, 200, {
      ok: true,
      holdMinutes: config.holdMinutes,
      tickets
    });
  }

  if (req.method === "POST" && pathname === "/api/public/reservations") {
    const body = await readJsonBody(req);
    const numbers = Array.isArray(body.numbers) ? body.numbers.map(Number) : [];
    const buyerName = sanitizeText(body.buyerName);
    const buyerPhone = sanitizeText(body.buyerPhone);
    const buyerEmail = sanitizeNullableText(body.buyerEmail);
    const notes = sanitizeNullableText(body.notes);

    if (!numbers.length) {
      return sendJson(res, 400, {
        ok: false,
        message: "Selecciona al menos un número antes de continuar."
      });
    }

    if (!buyerName || !buyerPhone) {
      return sendJson(res, 400, {
        ok: false,
        message: "Nombre y teléfono son obligatorios."
      });
    }

    const result = await supabaseRpc("create_reservation_hold", {
      p_numbers: numbers,
      p_buyer_name: buyerName,
      p_buyer_phone: buyerPhone,
      p_buyer_email: buyerEmail,
      p_notes: notes
    });

    const payload = normalizeRpcPayload(result);
    const statusCode = payload.ok ? 200 : 409;
    return sendJson(res, statusCode, payload);
  }

  if (req.method === "GET" && pathname === "/api/public/reservations/current") {
    const reservationId = sanitizeText(url.searchParams.get("reservationId"));
    const accessToken = sanitizeText(url.searchParams.get("accessToken"));

    if (!reservationId || !accessToken) {
      return sendJson(res, 400, {
        ok: false,
        message: "Faltan credenciales de la reserva."
      });
    }

    const result = await supabaseRpc("get_public_reservation", {
      p_reservation_id: reservationId,
      p_access_token: accessToken
    });

    const payload = normalizeRpcPayload(result);
    const statusCode = payload.ok ? 200 : 404;
    return sendJson(res, statusCode, payload);
  }

  if (req.method === "POST" && pathname === "/api/admin/login") {
    const body = await readJsonBody(req);
    const password = String(body.password || "");

    if (!password || !safeEqual(password, config.adminPassword)) {
      return sendJson(res, 401, {
        ok: false,
        message: "Clave incorrecta."
      });
    }

    const signedSession = createSignedSession({
      role: "admin",
      name: config.adminName,
      expiresAt: Date.now() + sessionDurationMs
    });

    res.setHeader("Set-Cookie", serializeCookie(sessionCookieName, signedSession, {
      httpOnly: true,
      sameSite: "Lax",
      secure: config.appUrl.startsWith("https://"),
      maxAge: Math.floor(sessionDurationMs / 1000),
      path: "/"
    }));

    return sendJson(res, 200, {
      ok: true,
      adminName: config.adminName
    });
  }

  if (req.method === "POST" && pathname === "/api/admin/logout") {
    res.setHeader("Set-Cookie", serializeCookie(sessionCookieName, "", {
      httpOnly: true,
      sameSite: "Lax",
      secure: config.appUrl.startsWith("https://"),
      maxAge: 0,
      path: "/"
    }));
    return sendJson(res, 200, { ok: true });
  }

  if (!isAdminAuthenticated(req)) {
    return sendJson(res, 401, {
      ok: false,
      message: "Necesitas iniciar sesión como administradora."
    });
  }

  if (req.method === "GET" && pathname === "/api/admin/dashboard") {
    await releaseExpiredReservations();

    const [tickets, reservations, events] = await Promise.all([
      supabaseSelect(
        "/rest/v1/ticket_admin_view?select=number,label,status,hold_expires_at,active_reservation_id,buyer_name,buyer_phone,paid_at,payment_validated_by,updated_at&order=number.asc"
      ),
      supabaseSelect(
        "/rest/v1/reservation_admin_view?select=id,reservation_code,status,buyer_name,buyer_phone,buyer_email,notes,hold_expires_at,reserved_at,paid_at,payment_validated_by,released_at,release_reason,conflict_reason,numbers,numbers_label,ticket_count&order=reserved_at.desc"
      ),
      supabaseSelect(
        "/rest/v1/ticket_events_view?select=id,reservation_id,reservation_code,buyer_name,buyer_phone,ticket_number,event_type,actor,event_at,detail&order=event_at.desc&limit=150"
      )
    ]);

    const query = sanitizeNullableText(url.searchParams.get("query"))?.toLowerCase() || "";
    const status = sanitizeNullableText(url.searchParams.get("status"));

    const filteredReservations = reservations.filter((reservation) => {
      if (status && status !== "all" && reservation.status !== status) {
        return false;
      }

      if (!query) {
        return true;
      }

      const haystack = [
        reservation.reservation_code,
        reservation.buyer_name,
        reservation.buyer_phone,
        reservation.buyer_email,
        reservation.notes,
        reservation.numbers_label,
        reservation.status
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });

    const filteredEvents = events.filter((event) => {
      if (!query) {
        return true;
      }
      const haystack = [
        event.reservation_code,
        event.buyer_name,
        event.buyer_phone,
        event.ticket_number,
        event.event_type,
        event.actor
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });

    return sendJson(res, 200, {
      ok: true,
      holdMinutes: config.holdMinutes,
      adminName: config.adminName,
      summary: buildDashboardSummary(tickets, reservations),
      tickets,
      reservations: filteredReservations,
      events: filteredEvents
    });
  }

  const actionMatch = pathname.match(/^\/api\/admin\/reservations\/([0-9a-f-]+)\/(mark-pending|confirm-payment|release|conflict)$/i);
  if (req.method === "POST" && actionMatch) {
    const [, reservationId, actionPath] = actionMatch;
    const body = await readJsonBody(req);
    const actionMap = {
      "mark-pending": "mark_pending",
      "confirm-payment": "confirm_payment",
      release: "release",
      conflict: "mark_conflict"
    };

    const result = await supabaseRpc("admin_update_reservation_status", {
      p_reservation_id: reservationId,
      p_action: actionMap[actionPath],
      p_actor: config.adminName,
      p_note: sanitizeNullableText(body.note)
    });

    const payload = normalizeRpcPayload(result);
    const statusCode = payload.ok ? 200 : 400;
    return sendJson(res, statusCode, payload);
  }

  return sendJson(res, 404, {
    ok: false,
    message: "Ruta API no encontrada."
  });
}

async function releaseExpiredReservations() {
  try {
    await supabaseRpc("release_expired_reservations");
  } catch (error) {
    console.warn("No fue posible ejecutar la liberación automática:", error);
  }
}

async function supabaseRpc(functionName, payload = {}) {
  return supabaseRequest(`/rest/v1/rpc/${functionName}`, {
    method: "POST",
    body: payload
  });
}

async function supabaseSelect(pathname) {
  return supabaseRequest(pathname, { method: "GET" });
}

async function supabaseRequest(pathname, options) {
  const response = await fetch(`${config.supabaseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail = typeof data === "object" && data ? data.message || data.details || data.hint : String(data || "");
    throw new Error(detail || "Error al consultar Supabase.");
  }

  return data;
}

async function serveStaticAsset(res, pathname) {
  const safePath = path
    .normalize(pathname)
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    return sendPlainText(res, 403, "Acceso denegado.");
  }

  return serveFile(res, filePath);
}

async function serveFile(res, filePath) {
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch (error) {
    sendPlainText(res, 404, "Archivo no encontrado.");
  }
}

function buildDashboardSummary(tickets, reservations) {
  const ticketStatusCounts = {
    available: 0,
    held: 0,
    reserved_pending_payment: 0,
    paid_confirmed: 0,
    conflict: 0
  };

  for (const ticket of tickets) {
    if (ticket.status in ticketStatusCounts) {
      ticketStatusCounts[ticket.status] += 1;
    }
  }

  const reservationStatusCounts = {
    held: 0,
    reserved_pending_payment: 0,
    paid_confirmed: 0,
    released: 0,
    expired: 0,
    conflict: 0
  };

  for (const reservation of reservations) {
    if (reservation.status in reservationStatusCounts) {
      reservationStatusCounts[reservation.status] += 1;
    }
  }

  return {
    tickets: ticketStatusCounts,
    reservations: reservationStatusCounts,
    totalSalesAmount: ticketStatusCounts.paid_confirmed * 10000
  };
}

function isAdminAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const signed = cookies[sessionCookieName];
  if (!signed) {
    return false;
  }

  const payload = verifySignedSession(signed);
  return Boolean(payload && payload.role === "admin" && payload.expiresAt > Date.now());
}

function createSignedSession(payload) {
  const raw = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", config.adminSessionSecret).update(raw).digest("base64url");
  return `${raw}.${signature}`;
}

function verifySignedSession(value) {
  const [raw, signature] = String(value).split(".");
  if (!raw || !signature) {
    return null;
  }

  const expected = createHmac("sha256", config.adminSessionSecret).update(raw).digest("base64url");
  if (!safeEqual(signature, expected)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.path) {
    parts.push(`Path=${options.path}`);
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function parseCookies(cookieHeader) {
  return cookieHeader
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const separatorIndex = item.indexOf("=");
      if (separatorIndex === -1) {
        return acc;
      }
      const key = item.slice(0, separatorIndex);
      const value = decodeURIComponent(item.slice(separatorIndex + 1));
      acc[key] = value;
      return acc;
    }, {});
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function normalizeRpcPayload(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload) && payload.length === 1 && typeof payload[0] === "object") {
    return payload[0];
  }
  return { ok: true, data: payload };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, jsonHeaders);
  res.end(JSON.stringify(payload));
}

function sendPlainText(res, statusCode, message) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(message);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sanitizeText(value) {
  return String(value || "").trim();
}

function sanitizeNullableText(value) {
  const normalized = sanitizeText(value);
  return normalized ? normalized : null;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}.`);
  }
  return value;
}

function loadEnvFile(envPath) {
  try {
    const raw = readFileSync(envPath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        return;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    });
  } catch {
    // El archivo .env es opcional.
  }
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
