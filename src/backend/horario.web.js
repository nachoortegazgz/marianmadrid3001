/**
 * =============================================================================
 * FILE: backend/horario.web.js
 * VERSION: v19.5.1-historical-hours-bounded
 * RESPONSIBILITY: Employee time tracking and labor registry (RD-Ley 8/2019):
 *                 clock-in, clock-out, break tracking, workload calculation.
 * REFACTORED (ITERATION 9 - FULL COMPLIANCE):
 *  - V3 Architecture (Incidencia 1): Extracted _registrarFichajeInternal private
 *                                    function to eliminate WebMethod-to-WebMethod RPC.
 *  - Vector A Members (Incidencia 2): wixMembersBackend wrapped in withTimeout to
 *                                     prevent cold-start hangs.
 *  - Real-time Virtual Shift (Incidencia 3): State machine includes ongoing active
 *                                            shifts calculated up to Date.now().
 *  - I-18: Mandatory staff validation against STAFF catalog and PII IP masking.
 *  - G10 Strict: Pure ASCII compliance (0 non-ASCII characters in errors/comments).
 *  - Canonical fields: Strictly uses tipoFichaje and resourceId.
 *  - DST-Safe Calculation: Epoch millisecond subtraction in state machine for 100% DST-safe hours.
 *  - Bounded Pagination: Bounded paginated query in _getHistorialFichajesInternal (up to 10 pages).
 * - v19.5.1-historical-hours-bounded: Limits virtual open-shift projection to ranges that include the current Madrid day and uses SSOT timeouts.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * =============================================================================
 */

import { webMethod, Permissions } from "wix-web-module";
import wixData from 'wix-data';
import { currentMember } from 'wix-members-backend';
import {
    STAFF_DEFAULT_NAME,
    makeTraceId,
    _safeTrim,
    _maskIp,
    getMadridLocalStringNoZ,
    withTimeout,
} from "public/mmUtils";
import {
    COLLECTIONS,
    TIPO_FICHAJE,
    SDK_CONFIG,
} from "backend/internalConfig";
import { logger, BookingError, ERROR_CODES, normalizeError } from 'backend/booking/bookingCore';
import { findStaff, getAllStaff } from 'backend/staff';
import { isAdmin, rateLimiter } from 'backend/security';

const log = logger;
const REGISTRO_COL = COLLECTIONS.REGISTRO_HORARIO;
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.WEBHOOK_MS) || 30000;

function _rateLimitOrThrow(surface, key, traceId) {
    const rl = rateLimiter({ surface, key });
    if (!rl.allowed) {
        const e = new Error('Demasiadas peticiones. Por favor, reintenta en unos segundos.');
        e.code = 'RATE_LIMITED';
        e.meta = { retryAfter: rl.retryAfter, surface, traceId };
        throw e;
    }
}

async function _resolveResourceName(resourceId) {
    if (!resourceId) return STAFF_DEFAULT_NAME;
    const found = await findStaff(resourceId);
    return found?.displayName || found?.name || STAFF_DEFAULT_NAME;
}

async function _validateResourceId(resourceId, traceId) {
    const cleanId = _safeTrim(resourceId);
    if (!cleanId) {
        throw new BookingError(ERROR_CODES.INVALID_EMPLOYEE, 'El identificador de personal es obligatorio.', { traceId });
    }
    const staffMatch = await findStaff(cleanId);
    if (!staffMatch?.resourceId) {
        throw new BookingError(ERROR_CODES.INVALID_EMPLOYEE, 'El identificador de personal no esta autorizado.', { traceId });
    }
    return staffMatch.resourceId;
}

async function _validateMemberAndResource(resourceId, traceId) {
    // VECTOR A: Watchdog en Members API para prevenir cold-start hangs (Incidencia 2)
    const member = await withTimeout(
        currentMember.getMember({ fieldsets: ['FULL'] }),
        API_TIMEOUT_MS,
        'getMemberForClockValidation'
    ).catch(() => null);

    if (!member) {
        throw new BookingError(ERROR_CODES.AUTH_REQUIRED, 'Inicio de sesion requerido.', { traceId });
    }

    // ADMIN BYPASS: Administrators can access/adjust clock data for any employee.
    // The actor is derived from the authenticated member, never from payload data.
    if (await isAdmin(traceId)) {
        return {
            registradoPor: "ADMIN",
            registradoPorMemberId: _safeTrim(member._id) || null,
        };
    }

    const memberEmail = _safeTrim(member.loginEmail || member.email);
    const memberId = member._id;

    const staffFromEmail = await findStaff(memberEmail);
    const staffFromId = await findStaff(memberId);
    const staff = staffFromEmail || staffFromId;

    if (!staff || !staff.resourceId) {
        throw new BookingError(ERROR_CODES.ACCESS_DENIED, 'No hay un perfil de personal vinculado a su cuenta.', { traceId });
    }

    const targetStaff = await findStaff(resourceId);
    const targetGuid = targetStaff?.resourceId || resourceId;

    if (staff.resourceId !== targetGuid) {
        throw new BookingError(ERROR_CODES.ACCESS_DENIED, 'Solo puede acceder a sus propios datos de fichaje.', { traceId });
    }
    return {
        registradoPor: "SELF",
        registradoPorMemberId: _safeTrim(memberId) || null,
    };
}

async function _getEstadoJornadaInternal(resourceId, traceId) {
    const cleanId = await _validateResourceId(resourceId, traceId);

    // VECTOR A: Watchdog en NoSQL query
    const res = await withTimeout(
        wixData
        .query(REGISTRO_COL)
        .eq('resourceId', cleanId)
        .descending('fechaHora')
        .limit(1)
        .find({ suppressAuth: true }),
        API_TIMEOUT_MS,
        'getEstadoJornadaInternal'
    );

    const lastRecord = res.items?.[0] || null;
    if (!lastRecord) {
        return { estadoActual: 'INACTIVO', enJornada: false, enPausa: false, ultimoFichaje: null };
    }

    const tipo = String(lastRecord.tipoFichaje || '').toUpperCase();

    let estadoActual = 'INACTIVO';
    let enJornada = false;
    let enPausa = false;

    if (tipo === TIPO_FICHAJE.ENTRADA || tipo === TIPO_FICHAJE.PAUSA_FIN) {
        estadoActual = 'TRABAJANDO';
        enJornada = true;
        enPausa = false;
    } else if (tipo === TIPO_FICHAJE.PAUSA_INICIO) {
        estadoActual = 'EN_PAUSA';
        enJornada = true;
        enPausa = true;
    } else if (tipo === TIPO_FICHAJE.SALIDA) {
        estadoActual = 'INACTIVO';
        enJornada = false;
        enPausa = false;
    } else if (tipo === TIPO_FICHAJE.AJUSTE) {
        estadoActual = 'AJUSTADO';
        enJornada = false;
        enPausa = false;
    }

    return {
        estadoActual,
        enJornada,
        enPausa,
        ultimoFichaje: {
            _id: lastRecord._id,
            tipoFichaje: lastRecord.tipoFichaje,
            fechaHora: lastRecord.fechaHora || lastRecord._createdDate,
            hora: lastRecord.hora,
            diaKey: lastRecord.diaKey
        }
    };
}

async function _getHistorialFichajesInternal(resourceId, startDateYMD, endDateYMD, traceId) {
    const cleanId = await _validateResourceId(resourceId, traceId);

    let query = wixData.query(REGISTRO_COL).eq('resourceId', cleanId).ascending('fechaHora');
    if (startDateYMD) query = query.ge('diaKey', _safeTrim(startDateYMD));
    if (endDateYMD) query = query.le('diaKey', _safeTrim(endDateYMD));

    let allItems = [];
    query = query.limit(1000);

    // VECTOR A: Watchdog en NoSQL query
    let res = await withTimeout(
        query.find({ suppressAuth: true }),
        API_TIMEOUT_MS,
        'queryHistorialFichajesInternal_p1'
    );
    allItems = allItems.concat(res?.items || []);

    let page = 2;
    const maxPages = 10;

    // BOUNDED PAGINATION LOOP TO PREVENT TRUNCATION ON LARGE DATE RANGES (MAX 10 PAGES / 10,000 RECORDS)
    while (res && res.hasNext() && page <= maxPages) {
        res = await withTimeout(
            res.next(),
            API_TIMEOUT_MS,
            `queryHistorialFichajesInternal_p${page}`
        );
        allItems = allItems.concat(res?.items || []);
        page++;
    }

    return allItems;
}

/**
 * Internal core function for clock registration (Incidencia 1).
 * Eliminates WebMethod-to-WebMethod internal RPC call overhead.
 */
async function _registrarFichajeInternal(payload, traceId) {
    const resourceId = await _validateResourceId(payload.resourceId, traceId);
    _rateLimitOrThrow('horario.registrarFichaje', resourceId, traceId);
    const actor = await _validateMemberAndResource(resourceId, traceId);

    const tipo = String(payload.tipoFichaje || payload.tipo || '').trim().toUpperCase();
    const validTypes = Object.values(TIPO_FICHAJE);
    if (!validTypes.includes(tipo)) {
        throw new BookingError(ERROR_CODES.INVALID_CLOCK_TYPE, `Tipo de fichaje invalido: "${tipo}".`, { traceId });
    }

    const estadoJornada = await _getEstadoJornadaInternal(resourceId, traceId);

    if (tipo === TIPO_FICHAJE.ENTRADA && estadoJornada.enJornada) {
        throw new BookingError(ERROR_CODES.INVALID_CLOCK_TYPE, 'El profesional ya tiene un turno activo.', { traceId });
    } else if (tipo === TIPO_FICHAJE.SALIDA && !estadoJornada.enJornada) {
        throw new BookingError(ERROR_CODES.INVALID_CLOCK_TYPE, 'No hay un turno activo para cerrar.', { traceId });
    } else if (tipo === TIPO_FICHAJE.PAUSA_INICIO && (!estadoJornada.enJornada || estadoJornada.enPausa)) {
        throw new BookingError(ERROR_CODES.INVALID_CLOCK_TYPE, 'No se puede iniciar una pausa sin un turno activo.', { traceId });
    } else if (tipo === TIPO_FICHAJE.PAUSA_FIN && !estadoJornada.enPausa) {
        throw new BookingError(ERROR_CODES.INVALID_CLOCK_TYPE, 'No se puede finalizar una pausa que no se ha iniciado.', { traceId });
    }

    const ahora = new Date();
    const madridStr = getMadridLocalStringNoZ(ahora);
    const diaKey = madridStr.slice(0, 10);
    const mesKey = madridStr.slice(0, 7);
    const hora = madridStr.slice(11, 19);

    const resourceName = await _resolveResourceName(resourceId);

    // IMMUTABLE INSERT: Modifications/deletions forbidden at DB level via data.js hooks
    const record = {
        resourceId,
        resourceName,
        tipoFichaje: tipo,
        diaKey,
        mesKey,
        hora,
        fechaHora: ahora,
        ipDispositivo: _maskIp(payload.ipDispositivo || 'CONTAINER_SYSTEM'),
        motivoAjuste: _safeTrim(payload.motivoAjuste) || null,
        registradoPor: actor.registradoPor,
        registradoPorMemberId: actor.registradoPorMemberId
    };

    // VECTOR A: Watchdog en NoSQL insert
    const inserted = await withTimeout(
        wixData.insert(REGISTRO_COL, record, { suppressAuth: true }),
        API_TIMEOUT_MS,
        'insertFichaje'
    );

    return {
        status: 'SUCCESS',
        data: {
            _id: inserted._id,
            resourceId: inserted.resourceId,
            resourceName: inserted.resourceName,
            tipoFichaje: inserted.tipoFichaje,
            fechaHora: inserted.fechaHora || ahora,
            diaKey: inserted.diaKey,
            hora: inserted.hora
        },
        error: null
    };
}

// =============================================================================
// PUBLIC WEB METHODS (V3 FACADES)
// =============================================================================

export const getMyStaffContext = webMethod(Permissions.SiteMember, async (options = {}) => {
    const traceId = options.traceId || makeTraceId('staff-context');
    try {
        const member = await withTimeout(
            currentMember.getMember({ fieldsets: ['FULL'] }),
            API_TIMEOUT_MS,
            'getMemberForStaffContext'
        );
        const memberEmail = _safeTrim(member?.loginEmail || member?.email);
        const staff = await findStaff(memberEmail) || await findStaff(member?._id);
        if (!staff) {
            throw new BookingError(ERROR_CODES.ACCESS_DENIED, 'No hay un perfil de personal vinculado a su cuenta.', { traceId });
        }
        return {
            status: 'SUCCESS',
            data: { resourceId: staff.resourceId, displayName: staff.displayName, role: staff.role || null },
            error: null
        };
    } catch (error) {
        const normalized = normalizeError(error);
        return { status: 'ERROR', data: null, error: { code: normalized.code, message: normalized.message } };
    }
});

export const getStaffOptionsForAdmin = webMethod(Permissions.Admin, async (options = {}) => {
    const traceId = options.traceId || makeTraceId('staff-options');
    try {
        const staff = await getAllStaff();
        return { status: 'SUCCESS', data: staff.map((entry) => ({ id: entry.resourceId, name: entry.displayName })), error: null };
    } catch (error) {
        const normalized = normalizeError(error);
        log.error('Failed to load staff options', { error: normalized.message, traceId });
        return { status: 'ERROR', data: null, error: { code: normalized.code, message: normalized.message } };
    }
});

export const registrarFichaje = webMethod(Permissions.SiteMember, async (arg1, arg2, arg3 = {}) => {
    let payload = {};
    if (typeof arg1 === 'object' && arg1 !== null) {
        payload = arg1;
    } else {
        payload = { resourceId: arg1, tipoFichaje: arg2, ...arg3 };
    }

    const traceId = payload.traceId || makeTraceId('fichaje');

    try {
        return await _registrarFichajeInternal(payload, traceId);
    } catch (error) {
        const normalized = normalizeError(error);
        log.error('Failed to register clock', { error: normalized.message, traceId });
        return { status: 'ERROR', data: null, error: { code: normalized.code, message: normalized.message } };
    }
});

export const getEstadoJornada = webMethod(Permissions.SiteMember, async (resourceId, options = {}) => {
    const traceId = options.traceId || makeTraceId('estado-jornada');
    try {
        const cleanId = await _validateResourceId(resourceId, traceId);
        await _validateMemberAndResource(cleanId, traceId);

        const estado = await _getEstadoJornadaInternal(cleanId, traceId);
        return { status: 'SUCCESS', data: estado, error: null };
    } catch (error) {
        const normalized = normalizeError(error);
        return { status: 'ERROR', data: null, error: { code: normalized.code, message: normalized.message } };
    }
});

export const getHistorialFichajes = webMethod(
    Permissions.SiteMember,
    async (resourceId, startDateYMD, endDateYMD, options = {}) => {
        const traceId = options.traceId || makeTraceId('historial-fichajes');
        try {
            const cleanId = await _validateResourceId(resourceId, traceId);
            await _validateMemberAndResource(cleanId, traceId);

            const items = await _getHistorialFichajesInternal(cleanId, startDateYMD, endDateYMD, traceId);
            return { status: 'SUCCESS', data: items, error: null };
        } catch (error) {
            const normalized = normalizeError(error);
            return { status: 'ERROR', data: null, error: { code: normalized.code, message: normalized.message } };
        }
    }
);

export const calcularHorasTrabajadas = webMethod(
    Permissions.SiteMember,
    async (resourceId, startDateYMD, endDateYMD, options = {}) => {
        const traceId = options.traceId || makeTraceId('calc-horas');

        try {
            const cleanId = await _validateResourceId(resourceId, traceId);
            await _validateMemberAndResource(cleanId, traceId);

            const items = await _getHistorialFichajesInternal(cleanId, startDateYMD, endDateYMD, traceId);

            let totalWorkedMs = 0;
            let totalBreakMs = 0;

            let currentShiftStart = null;
            let currentBreakStart = null;
            let currentShiftBreakMs = 0;

            // STATE MACHINE CALCULATION: Resilient to out-of-order or orphan clock records (DST-Safe)
            for (const item of items) {
                const rawDate = item.fechaHora || item._createdDate;
                const time = rawDate ? new Date(rawDate).getTime() : NaN;
                if (isNaN(time)) continue;

                const tipo = String(item.tipoFichaje || '').toUpperCase();

                if (tipo === TIPO_FICHAJE.ENTRADA) {
                    if (currentShiftStart !== null) {
                        log.warn('Sequence warning: ENTRADA received while shift active, overwriting shift start', { traceId });
                    }
                    currentShiftStart = time;
                    currentBreakStart = null;
                    currentShiftBreakMs = 0;
                } else if (tipo === TIPO_FICHAJE.PAUSA_INICIO) {
                    if (currentShiftStart === null) {
                        log.warn('Sequence anomaly: PAUSA_INICIO without active shift, skipping', { traceId });
                        continue;
                    }
                    if (currentBreakStart !== null) {
                        log.warn('Sequence anomaly: PAUSA_INICIO while already on break, skipping', { traceId });
                        continue;
                    }
                    currentBreakStart = time;
                } else if (tipo === TIPO_FICHAJE.PAUSA_FIN) {
                    if (currentShiftStart === null || currentBreakStart === null) {
                        log.warn('Sequence anomaly: PAUSA_FIN without active break, skipping', { traceId });
                        continue;
                    }
                    const breakDuration = time - currentBreakStart;
                    if (breakDuration > 0) {
                        currentShiftBreakMs += breakDuration;
                    }
                    currentBreakStart = null;
                } else if (tipo === TIPO_FICHAJE.SALIDA) {
                    if (currentShiftStart === null) {
                        log.warn('Sequence anomaly: SALIDA without active shift, skipping', { traceId });
                        continue;
                    }
                    if (currentBreakStart !== null) {
                        const breakDuration = time - currentBreakStart;
                        if (breakDuration > 0) currentShiftBreakMs += breakDuration;
                        currentBreakStart = null;
                    }

                    const grossShiftMs = time - currentShiftStart;
                    if (grossShiftMs > currentShiftBreakMs) {
                        totalWorkedMs += (grossShiftMs - currentShiftBreakMs);
                        totalBreakMs += currentShiftBreakMs;
                    }

                    currentShiftStart = null;
                    currentBreakStart = null;
                    currentShiftBreakMs = 0;
                }
            }

            // Project an open shift only when the requested interval includes the current Madrid day.
            const todayYMD = getMadridLocalStringNoZ(new Date()).slice(0, 10);
            const rangeIncludesToday = !endDateYMD || _safeTrim(endDateYMD) >= todayYMD;
            const hasOpenShiftOutsideRequestedRange = currentShiftStart !== null && !rangeIncludesToday;
            if (currentShiftStart !== null && rangeIncludesToday) {
                const nowMs = Date.now();
                if (currentBreakStart !== null) {
                    const breakDuration = nowMs - currentBreakStart;
                    if (breakDuration > 0) currentShiftBreakMs += breakDuration;
                }
                const grossShiftMs = nowMs - currentShiftStart;
                if (grossShiftMs > currentShiftBreakMs) {
                    totalWorkedMs += (grossShiftMs - currentShiftBreakMs);
                    totalBreakMs += currentShiftBreakMs;
                }
            }

            const workedHoursDecimal = Math.round((totalWorkedMs / (1000 * 60 * 60)) * 100) / 100;
            const breakHoursDecimal = Math.round((totalBreakMs / (1000 * 60 * 60)) * 100) / 100;

            const hoursInt = Math.floor(workedHoursDecimal);
            const minutesInt = Math.round((workedHoursDecimal - hoursInt) * 60);

            return {
                status: 'SUCCESS',
                data: {
                    resourceId: cleanId,
                    periodo: { desde: startDateYMD, hasta: endDateYMD },
                    horasTrabajadasDecimal: workedHoursDecimal,
                    horasPausaDecimal: breakHoursDecimal,
                    tiempoFormateado: `${hoursInt}h ${minutesInt}m`,
                    totalFichajesProcesados: items.length,
                    turnoAbiertoFueraDeRango: hasOpenShiftOutsideRequestedRange
                },
                error: null
            };
        } catch (error) {
            const normalized = normalizeError(error);
            return { status: 'ERROR', data: null, error: { code: normalized.code, message: normalized.message } };
        }
    }
);

export const registrarAjusteHorario = webMethod(Permissions.Admin, async (payload = {}) => {
    const traceId = payload.traceId || makeTraceId('ajuste-horario');
    try {
        if (!payload.motivoAjuste) {
            throw new BookingError(ERROR_CODES.INVALID_PAYLOAD, 'El campo motivoAjuste es obligatorio para ajustes manuales.', { traceId });
        }
        // INCIDENCIA 1: CALL INTERNAL PRIVATE FUNCTION (Bypass WebMethod RPC)
        return await _registrarFichajeInternal({
            ...payload,
            tipoFichaje: TIPO_FICHAJE.AJUSTE,
            registradoPor: 'ADMIN'
        }, traceId);
    } catch (error) {
        const normalized = normalizeError(error);
        return { status: 'ERROR', data: null, error: { code: normalized.code, message: normalized.message } };
    }
});
