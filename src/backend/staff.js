/**
 * =============================================================================
 * MODULE: backend/staff.js
 * RESPONSIBILITY: Private staff identity resolution from the MAPA_STAFF CMS
 *                 collection. This adapter centralizes cache, normalization, and
 *                 lookups used by security, schedules, bookings, and time logs.
 * STANDARDS: G10 ASCII Strict. Never expose emails or member IDs to clients.
 * =============================================================================
 */

import wixData from "wix-data";
import {
    _safeEmail,
    _safeTrim,
    _looksLikeGuid,
    withTimeout,
} from "public/mmUtils";
import {
    COLLECTIONS,
    SDK_CONFIG,
} from "backend/internalConfig";

const STAFF_CACHE_TTL_MS = SDK_CONFIG.CACHE.STAFF_TTL_MS;
const STAFF_CACHE_MAX_ITEMS = 220;
const STAFF_COL = COLLECTIONS.MAPA_STAFF;
let staffCache = { loadedAt: 0, items: [] };

function _canonicalStaffDisplayName(rawName) {
    // nombreVisible is required and length-bounded by the MapaStaff CMS hook.
    // Do not hardcode staff identities: the private catalog is the source of truth.
    return _safeTrim(rawName) || "PROFESIONAL SEGUN HORARIO";
}

function _normalizeStaffRecord(raw) {
    if (!raw || typeof raw !== "object" || raw.activo === false) return null;

    const resourceId = _safeTrim(raw.resourceId);
    if (!_looksLikeGuid(resourceId)) return null;

    const email = _safeEmail(raw.email);
    const memberId = _safeTrim(raw.memberId);
    const scheduleId = _safeTrim(raw.scheduleId);
    const displayName = _canonicalStaffDisplayName(raw.nombreVisible || raw.displayName || raw.name);
    const role = _safeTrim(raw.rol || raw.role).toUpperCase();

    return Object.freeze({
        cmsId: _safeTrim(raw._id),
        resourceId,
        email,
        memberId,
        scheduleId,
        displayName,
        name: displayName,
        role,
    });
}

async function _loadStaffCatalog() {
    const now = Date.now();
    if (staffCache.loadedAt && now - staffCache.loadedAt < STAFF_CACHE_TTL_MS) {
        return staffCache.items;
    }

    const result = await withTimeout(
        wixData.query(STAFF_COL)
            .ne("activo", false)
            .ascending("nombreVisible")
            .limit(STAFF_CACHE_MAX_ITEMS)
            .find({ suppressAuth: true, consistentRead: true }),
        SDK_CONFIG.TIMEOUTS.CMS_MS,
        "loadStaffCatalog"
    );
    const items = (result?.items || []).map(_normalizeStaffRecord).filter(Boolean);
    staffCache = { loadedAt: now, items };
    return items;
}

export async function findStaff(identifier) {
    const raw = _safeTrim(identifier);
    if (!raw) return null;

    const email = _safeEmail(raw);
    const items = await _loadStaffCatalog();
    return items.find((staff) =>
        staff.cmsId === raw ||
        staff.resourceId === raw ||
        (staff.memberId && staff.memberId === raw) ||
        (staff.email && staff.email === email)
    ) || null;
}

export async function resolveStaffResourceIds(selection) {
    if (!Array.isArray(selection) || !selection.length) {
        throw new Error("STAFF_SELECTION_REQUIRED");
    }

    const resourceIds = new Set();
    for (const entry of selection) {
        const identifier = entry && typeof entry === "object"
            ? (entry._id || entry.resourceId || entry.id)
            : entry;
        const staff = await findStaff(identifier);
        if (!staff?.resourceId) throw new Error("STAFF_SELECTION_INVALID");
        resourceIds.add(staff.resourceId);
    }

    if (!resourceIds.size) throw new Error("STAFF_SELECTION_REQUIRED");
    return [...resourceIds];
}

export async function getAllStaff() {
    return [...await _loadStaffCatalog()];
}

export function clearStaffCache() {
    staffCache = { loadedAt: 0, items: [] };
}
