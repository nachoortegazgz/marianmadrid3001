/**
 * =============================================================================
 * FILE: backend/responseUtils.js
 * VERSION: v20.0.0-canonical-responses
 * RESPONSIBILITY: Centralized response standardization, AppError class,
 *                 and webMethod error handling helpers.
 * CONTENIDO:
 * 1. AppError: standard typed domain error.
 * 2. successResponse: standard success envelope { status: 'SUCCESS', data, meta, error: null }.
 * 3. errorResponse: standard error envelope { status: 'ERROR', data: null, meta, error: { code, message } }.
 * 4. _toPublicError: uniform error sanitizer for web modules.
 * 5. toWebMethodResult: safe execution wrapper for async domain actions.
 * 6. isSuccess: evaluates response success state.
 * 7. extractError: robust error message extractor from various shapes.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * HISTORIAL:
 * - v20.0.0-canonical-responses: Added AppError class, _toPublicError helper,
 *   and toWebMethodResult action wrapper to eliminate duplication across .web.js modules.
 * - v18.3.8-strict-fine: Header standardized during V2 compliance review.
 * =============================================================================
 */

import { _cloneDeep, _safeTrim } from "public/mmUtils";

const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Standard typed application error for backend operations.
 */
export class AppError extends Error {
    constructor(code = "INTERNAL_ERROR", message = "Error interno", meta = {}) {
        super(String(message || "Error interno"));
        this.name = "AppError";
        this.code = String(code || "INTERNAL_ERROR");
        this.meta = meta && typeof meta === "object" ? meta : { details: meta };
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AppError);
        }
    }
}

/**
 * Standardized success response envelope.
 * @param {*} data - Payload to return.
 * @param {Object} metaExtra - Additional metadata.
 * @returns {Object} Envelope with status 'SUCCESS'.
 */
export function successResponse(data = null, metaExtra = {}) {
    const extra = metaExtra && typeof metaExtra === "object" ? _cloneDeep(metaExtra) : {};
    return {
        status: "SUCCESS",
        meta: {
            timestamp: new Date().toISOString(),
            ...extra,
        },
        data,
        error: null,
    };
}

/**
 * Standardized error response envelope.
 * @param {string|Error|Object} code - Error code, Error instance, or error object.
 * @param {string} [message] - Error message (optional if code is Error/object).
 * @param {Object} metaExtra - Additional metadata.
 * @returns {Object} Envelope with status 'ERROR'.
 */
export function errorResponse(code = "INTERNAL_ERROR", message = "Error inesperado", metaExtra = {}) {
    let finalCode = code;
    let finalMsg = message;

    if (code instanceof Error) {
        finalMsg = code.message || String(code);
        finalCode = code.code || code.name || "UNKNOWN_ERROR";
    } else if (typeof code === "object" && code !== null && (message === undefined || message === null)) {
        finalMsg = code.message || code.error || code.reason || JSON.stringify(code);
        finalCode = code.code || "UNKNOWN_ERROR";
    } else if (typeof code === "string" && (message === undefined || message === null)) {
        finalMsg = code;
        finalCode = "UNKNOWN_ERROR";
    }

    const rawMsg = finalMsg instanceof Error ? finalMsg.message || String(finalMsg) : String(finalMsg || "Unknown error");
    const safeMsg = _safeTrim(rawMsg);
    const truncatedMsg = safeMsg.length > MAX_ERROR_MESSAGE_LENGTH ?
        safeMsg.slice(0, MAX_ERROR_MESSAGE_LENGTH) + "..." :
        safeMsg;

    const extra = metaExtra && typeof metaExtra === "object" ? _cloneDeep(metaExtra) : {};

    return {
        status: "ERROR",
        meta: {
            timestamp: new Date().toISOString(),
            ...extra,
        },
        data: null,
        error: {
            code: String(finalCode || "UNKNOWN_ERROR"),
            message: truncatedMsg || "Error no especificado",
        },
    };
}

/**
 * Sanitizes an error into a safe public shape without leaking internal metadata.
 * @param {*} err - Caught exception or error object.
 * @param {string} fallbackCode - Fallback error code.
 * @param {string} fallbackMessage - Fallback error message.
 * @returns {{ code: string, message: string }}
 */
export function _toPublicError(err, fallbackCode = "INTERNAL_ERROR", fallbackMessage = "Error interno") {
    const code = String(err?.code || fallbackCode);
    const rawMessage = err?.message || fallbackMessage;
    const message = _safeTrim(rawMessage).slice(0, MAX_ERROR_MESSAGE_LENGTH) || fallbackMessage;
    return { code, message };
}

/**
 * Higher-order helper to wrap an async backend function into a standard webMethod response.
 * @param {Function} actionFn - Async function returning data payload.
 * @returns {Function}
 */
export function toWebMethodResult(actionFn) {
    return async (...args) => {
        try {
            const result = await actionFn(...args);
            return successResponse(result);
        } catch (err) {
            const code = err?.code || err?.name || "OPERATION_FAILED";
            const message = err?.message || "No se pudo procesar la solicitud.";
            return errorResponse(code, message);
        }
    };
}

/**
 * Checks if a response indicates success.
 * @param {*} res - Response to evaluate.
 * @returns {boolean}
 */
export function isSuccess(res) {
    if (!res) return false;
    if (res === true) return true;

    const rawStatus = res?.status ?? res?.payload?.status ?? res?.data?.status;
    if (typeof rawStatus === "string") {
        const norm = rawStatus.trim().toUpperCase();
        if (norm === "SUCCESS" || norm === "OK") return true;
    }

    if (rawStatus === 200 || res?.success === true) return true;
    return false;
}

/**
 * Extracts a readable error message from any error structure.
 * @param {*} err - Error to process.
 * @param {number} maxLen - Maximum error message length.
 * @returns {string}
 */
export function extractError(err, maxLen = MAX_ERROR_MESSAGE_LENGTH) {
    if (!err) return "Unknown error";
    if (typeof err === "string") return _safeTrim(err);

    if (err instanceof Error) {
        const codePrefix = err.code ? `${err.code}: ` : "";
        const msg = `${codePrefix}${err.message || String(err)}`;
        return msg.length > maxLen ? msg.slice(0, maxLen) + "..." : msg;
    }

    let code = null;
    let msg = null;

    if (typeof err === "object" && err !== null) {
        code =
            err?.response?.data?.error?.code ||
            err?.error?.code ||
            err?.code ||
            err?.details?.code ||
            null;

        const candidates = [
            err?.response?.data?.error?.message,
            err?.response?.data?.message,
            typeof err?.response?.data?.error === "string" ? err?.response?.data?.error : null,
            err?.error?.message,
            typeof err?.error === "string" ? err?.error : null,
            err?.message,
            err?.details?.message,
            typeof err?.details === "string" ? err?.details : null,
            typeof err?.reason === "string" ? err?.reason : null,
            typeof err?.description === "string" ? err?.description : null,
        ];

        for (const candidate of candidates) {
            if (candidate && typeof candidate === "string" && candidate.trim().length > 0) {
                msg = candidate.trim();
                break;
            }
        }

        if (!msg || msg === "{}") {
            try {
                const jsonStr = JSON.stringify(err);
                msg = jsonStr && jsonStr !== "{}" ? jsonStr : String(err?.message || err?.name || err || "Unknown error");
            } catch (_) {
                msg = String(err?.message || err?.name || err || "Unknown error");
            }
        }
    } else {
        msg = String(err);
    }

    const cleanedMsg = _safeTrim(msg);
    const finalMsg = cleanedMsg.length > maxLen ? cleanedMsg.slice(0, maxLen) + "..." : cleanedMsg;
    return code ? `${code}: ${finalMsg}` : finalMsg;
}