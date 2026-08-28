/**
 * =============================================================================
 * MODULE: public/mmUtils.js
 * VERSION: v20.0.0-canonical-shared-kernel
 * RESPONSIBILITY: SSOT constants, timezones, validators, PII masking,
 * mathematical rounding, text sanitization, stable serialization,
 * and retry logic (PUBLIC SAFE).
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * NOTES:
 * - Do NOT ship secrets/PII identifiers (role IDs, member IDs, staff IDs) in public code.
 * - Keep public module limited to non-sensitive constants and pure utilities.
 * - Do NOT keep STAFF catalogs with IDs in public. Staff names/ids must be resolved in backend.
 * HISTORIAL:
 * - v20.0.0-canonical-shared-kernel: Centralizes _roundMoney, _cleanText, _stableSerialize,
 *   _sumAddons, _normalizeSlotShape, _readPositiveAmount, _readDate, and _addDaysYMD to eliminate duplications.
 * - v19.6.15-privacy-route-fix: Aligns the public consent route with the published legal page.
 * - v19.6.14-widget-handshake-window: Extends the nonce-free widget READY retry window for delayed iframe initialization.
 * - v19.6.12-final-debt-cleanup: Removes unconsumed browser limiter, masking helpers, validators, and response helpers with no consumers.
 * - v19.6.11-public-config-boundary: Moves backend-only IDs, collections, states, and runtime configuration to backend/internalConfig.js.
 * - v19.6.7-ready-only-context: Removes the unused pre-READY widget context fallback constant.
 * - v19.6.5-ssot-cleanup: Removes the unused slot tolerance constant from the public SSOT.
 * - v19.6.3-prioritized-reliability-refactor: Removes duplicated catalog and slot paths, restores Codegem fixes, and hardens persistence.
 * - v19.5.4-location-context-ssot: Separates official Time Slots V2 and Bookings Writer V2 location enums.
 * - v19.5.3-reliability-ssot: Adds fiscal pending state, bounded transaction polling, DST round-trip validation, and operational cache limits.
 * - v19.5.2-calendar-ux-ssot: Adds the enumerated privacy route used by the accessible Calendar 2 consent control.
 * - v19.5.1-audit-hardening-ssot: Centralizes verified operational, security, job, and external HTTP constants.
 * - v19.4.9-service-presentation-ssot: Adds public service image and location visual fallbacks.
 * - v19.4.8-runtime-jobs-ssot: Centralizes Wix Jobs timeout, retention, batch, and page limits.
 * - v19.4.6-native-addon-ssot: Adds the 99 validated active Wix Bookings native add-on IDs.
 * - v19.3.0-inventory-ssot: Added inventory ledger collections, states, and operational limits.
 * - v19.2.0-state-ssot-hardened: Added public booking rate limits, lock cleanup windows, and refund status.
 * - v19.0.2-v3-aligned: Header standardized during V2 compliance review.
 * =============================================================================
 */

export const VERSION = Object.freeze({
    CORE: "v20.0.0-canonical-shared-kernel",
    API_V2: true,
    COMPLIANCE_ES: "2026",
});

export const SDK_CONFIG = Object.freeze({
    TZ: "Europe/Madrid",
});

export const MONEY = Object.freeze({
    DISPLAY_CURRENCY: "EUR",
    DECIMAL_PLACES: 2,
});

/**
 * IMPORTANT:
 * Do not expose collaborator role IDs / member role IDs in public code.
 * Keep only labels here. IDs must be resolved in backend (or stored in Secrets/CMS).
 */
export const BOOKINGS_ADDON_CONFIG = Object.freeze({
    MAX_PER_BOOKING: 21,
});

/**
 * CitasF2 status fields (canonical):
 * - status
 * - statusPago
 */
export const MESSAGE_TYPES = Object.freeze({
    READY: "MM_READY",
    CONTEXT: "MM_CONTEXT",
    AVAIL: "MM_AVAIL",
    SELECT: "MM_SELECT",
    BOOK: "MM_BOOK",
    NAV: "MM_NAV",
});

export const URLS = Object.freeze({
    SERVICIOS: "/reserva-online",
    CALENDARIO_2: "/booking-calendar/calendario-2",
    DETALLE_SERVICIO: "/servicio-2",
    PRIVACY_POLICY: "/politica-privacidad-texto",
    TPV_PANEL: "/onlystaff",
});

export const UI = Object.freeze({
    HANDSHAKE_MAX_ATTEMPTS: 7,
    HANDSHAKE_BASE_BACKOFF_MS: 750,
    HANDSHAKE_TIMEOUT_MS: 120000,
    CONTEXT_TIMEOUT_MS: 120000,
    FRONTEND_API_TIMEOUT_MS: 30000,
    FRONTEND_RETRY_ATTEMPTS: 5,
    FRONTEND_RETRY_BASE_BACKOFF_MS: 500,
    TPV_POLLING_MS: 60 * 1000,
    MAX_VISIBLE_SLOTS: 100,
    SLOT_BUTTON_CLASS: "slot-btn",
    DEFAULT_SERVICE_IMAGE_URL: "https://static.wixstatic.com/media/ab7708_374e5f7adb2f47f3944f3355da129b80~mv2.jpg",
    SALON_LOCATION_LABEL: "C/ Maurice Ravel 35, Zaragoza",
});

export const STAFF_DEFAULT_NAME = "PROFESIONAL SEGUN HORARIO";

// -----------------------------------------------------------------------------
// Core utils
// -----------------------------------------------------------------------------
export function makeTraceId(prefix = "mm") {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}_${timestamp}_${random}`;
}

export function _safeTrim(v) {
    return v === null || v === undefined ? "" : String(v).trim();
}

export function _cleanText(value, maxLength = 240) {
    return String(value ?? "").trim().replace(/[\r\n\t]+/g, " ").slice(0, maxLength);
}

export function _roundMoney(value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
}

export function _stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(_stableSerialize).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${_stableSerialize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function _normalizeSlotShape(slot) {
    if (!slot || typeof slot !== "object") return null;
    if (slot.slot && typeof slot.slot === "object") return { ...slot.slot, ...slot };
    return slot;
}

export function _sumAddons(addons) {
    if (!Array.isArray(addons)) return 0;
    return addons.reduce((acc, a) => acc + Number(a?.precio || a?.price || 0), 0);
}

export function _readPositiveAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 ? _roundMoney(amount) : null;
}

export function _readDate(value) {
    const date = _safeTrim(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

export function _addDaysYMD(ymd, days) {
    const clean = _safeTrim(ymd);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return "";
    const parts = clean.split("-").map(Number);
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
    return dt.toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG.TZ });
}

export function _cloneDeep(value) {
    if (value == null || typeof value !== "object") return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map((entry) => _cloneDeep(entry));
    const output = {};
    Object.keys(value).forEach((key) => {
        output[key] = _cloneDeep(value[key]);
    });
    return output;
}

export function _safeEmail(email) {
    return String(email || "").trim().toLowerCase();
}

export function _safePhone(phone) {
    const raw = String(phone || "").trim();
    if (!raw) return "";
    const hasPlus = raw.startsWith("+");
    const digitsOnly = raw.replace(/[^0-9]/g, "");
    if (!digitsOnly) return "";
    return hasPlus ? `+${digitsOnly}` : digitsOnly;
}

export function _normalizeIdPart(v, maxLen = 80) {
    const s = String(v || "").trim();
    const safe = s.replace(/[^A-Za-z0-9_-]/g, "_");
    return safe.length > maxLen ? safe.slice(0, maxLen) : safe;
}

export function _looksLikeGuid(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        String(v || "").trim()
    );
}

export function _safeSlugOrId(raw) {
    let s = String(raw || "").trim();
    if (!s) return "";
    s = s.split("?")[0].split("#")[0].trim();
    if (s.startsWith("/")) s = s.substring(1);
    if (s.endsWith("/")) s = s.slice(0, -1);

    const parts = s.split("/").filter(Boolean);
    s = parts.length ? parts[parts.length - 1] : s;

    if (_looksLikeGuid(s)) return s.trim();

    s = s.trim().toLowerCase();
    s = s.replace(/\s+/g, "-");
    // ASCII strict: explicit Unicode escape range
    s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    s = s.replace(/[^a-z0-9-]/g, "");
    s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");
    return s;
}

export function _normalizeLocalIsoStr(rawStr) {
    if (!rawStr || rawStr instanceof Date) return "";
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(rawStr).trim());
    if (!match) return "";

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = match[4] === undefined ? 0 : Number(match[4]);
    const minute = match[5] === undefined ? 0 : Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day ||
        hour > 23 ||
        minute > 59 ||
        second > 59
    ) return "";

    return `${match[1]}-${match[2]}-${match[3]}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

/**
 * Convert a Europe/Madrid local ISO string (no timezone suffix) to a UTC Date.
 * Handles DST by computing the offset using Intl for the guessed instant.
 */
export function getUtcDateFromMadridLocal(localStr) {
    if (localStr instanceof Date) return isNaN(localStr.getTime()) ? null : localStr;
    if (!localStr) return null;

    const norm = _normalizeLocalIsoStr(localStr);
    const partsIso = norm.split("T");
    const datePart = partsIso[0] || "";
    const timePart = partsIso[1] || "00:00:00";

    const dateParts = datePart.split("-").map(Number);
    const timeParts = timePart.split(":").map(Number);

    const y = Number(dateParts[0]);
    const m = Number(dateParts[1]);
    const d = Number(dateParts[2]);
    const hh = Number(timeParts[0] || 0);
    const mm = Number(timeParts[1] || 0);
    const ss = Number(timeParts[2] || 0);

    if (!y || !m || !d) return null;

    // First guess: treat local as if it were UTC.
    const guessUtcMs = Date.UTC(y, m - 1, d, hh, mm, ss);
    const guessDate = new Date(guessUtcMs);

    const dtf = new Intl.DateTimeFormat("sv-SE", {
        timeZone: SDK_CONFIG.TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });

    const parts = dtf.formatToParts(guessDate);
    const get = (type) => {
        const found = parts.find((p) => p.type === type);
        return found ? found.value : null;
    };

    const asIfUtc = Date.UTC(
        Number(get("year")),
        Number(get("month")) - 1,
        Number(get("day")),
        Number(get("hour")),
        Number(get("minute")),
        Number(get("second"))
    );

    const offsetMs = asIfUtc - guessDate.getTime();
    const utcMs = guessUtcMs - offsetMs;

    const out = new Date(utcMs);
    if (isNaN(out.getTime())) return null;

    // Reject non-existent local wall-clock values during the Madrid DST spring jump.
    // A valid conversion must round-trip to the original local date and time.
    const roundTripParts = dtf.formatToParts(out);
    const roundTrip = (type) => {
        const found = roundTripParts.find((p) => p.type === type);
        return found ? Number(found.value) : NaN;
    };
    if (
        roundTrip("year") !== y ||
        roundTrip("month") !== m ||
        roundTrip("day") !== d ||
        roundTrip("hour") !== hh ||
        roundTrip("minute") !== mm ||
        roundTrip("second") !== ss
    ) {
        return null;
    }

    return out;
}

export function getMadridLocalStringNoZ(utcDate) {
    if (!utcDate || !(utcDate instanceof Date) || isNaN(utcDate.getTime())) return "";
    return utcDate.toLocaleString("sv-SE", { timeZone: SDK_CONFIG.TZ }).replace(" ", "T");
}

export function _toDateSafe(val) {
    if (!val) return null;
    if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
    if (typeof val === "object" && val !== null && val.$date) return _toDateSafe(val.$date);
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
}

export function withTimeout(promise, timeoutMs, label = "operation") {
    // The underlying Wix promise is not abortable. A timeout only stops waiting,
    // so mutation callers must not retry it unless their write is idempotent.
    const ms = Number.isFinite(timeoutMs) ? timeoutMs : SDK_CONFIG.TIMEOUTS.API_MS;
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function _extractStatusCode(err) {
    if (!err) return null;
    if (typeof err.statusCode === "number") return err.statusCode;
    if (typeof err.status === "number") return err.status;
    if (err.details && typeof err.details.statusCode === "number") return err.details.statusCode;
    return null;
}

export async function _executeWithRetry(fn, retries = 3, delay = 500, options = {}) {
    const retryUncertainOutcome = options?.retryUncertainOutcome === true;
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            const msg = String(error && error.message ? error.message : "").toUpperCase();
            const code = _extractStatusCode(error);
            const uncertainOutcome =
                msg.includes("TIMEOUT") ||
                msg.includes("ETIMEDOUT") ||
                msg.includes("ECONNRESET") ||
                msg.includes("502") ||
                msg.includes("503") ||
                msg.includes("504") ||
                code === 502 ||
                code === 503 ||
                code === 504;
            const retryable = msg.includes("429") || code === 429 || (retryUncertainOutcome && uncertainOutcome);

            if (!retryable) throw error;

            const waitMs = Math.random() * delay * Math.pow(2, i);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    }
    throw lastError;
}

// -----------------------------------------------------------------------------
// PII masking helpers (safe for logs/UI)
// -----------------------------------------------------------------------------
export function _maskEmail(email) {
    const raw = String(email || "").trim();
    if (!raw || !raw.includes("@")) return "***@***";
    const split = raw.split("@");
    const localRaw = split[0] || "";
    const domainRaw = split[1] || "";
    const local = String(localRaw);
    const domain = String(domainRaw);
    if (!domain) return "***@***";
    const keep = Math.min(2, local.length);
    const prefix = keep > 0 ? local.slice(0, keep) : "*";
    return `${prefix}***@${domain}`;
}

export function _maskIp(ip) {
    if (!ip || typeof ip !== "string") return "***";
    const trimmed = ip.trim();
    if (!trimmed) return "***";
    const parts = trimmed.split(".");
    if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) return `${parts[0]}.${parts[1]}.***.***`;
    if (trimmed.length > 6) return trimmed.slice(0, 6) + ":***";
    return "***";
}

// -----------------------------------------------------------------------------
// Hashing / IDs
// -----------------------------------------------------------------------------
export function _hashKey(input) {
    const str = String(input || "");
    let hash1 = 5381;
    let hash2 = 52711;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash1 = ((hash1 << 5) + hash1) ^ char;
        hash2 = ((hash2 << 5) + hash2) ^ char;
    }
    const combined = Math.abs(hash1 * 31 + hash2);
    return combined.toString(16).padStart(16, "0").slice(0, 16);
}

export function _generateUUID() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

// -----------------------------------------------------------------------------
// Validators
// -----------------------------------------------------------------------------
export function _isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

export function _normType(type) {
    if (!type) return "";
    return String(type).trim().toUpperCase();
}

export function _maskPhone(phone) {
    const raw = String(phone || "").trim();
    if (!raw) return "***";
    const clean = _safePhone(raw);
    if (clean.length <= 4) return "***";
    return clean.slice(0, 3) + "***" + clean.slice(-2);
}

export function _maskName(name) {
    const raw = String(name || "").trim();
    if (!raw) return "***";
    if (raw.length <= 2) return raw[0] + "*";
    return raw[0] + "***" + raw.slice(-1);
}