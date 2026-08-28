/**
 * =============================================================================
 * MODULE: backend/marianAssistant.web.js
 * VERSION: v20.0.0-mariana-contextual-assistant
 * RESPONSIBILITY: Private management chat for Marian with non-destructive action
 *                 suggestions. It never executes fiscal or cash mutations.
 * STANDARDS: G10 ASCII Strict (0 non-ASCII characters).
 * =============================================================================
 */

import { webMethod, Permissions } from "wix-web-module";
import { getSecret } from "wix-secrets-backend";
import { makeTraceId, _safeTrim, withTimeout } from "public/mmUtils";
import { SDK_CONFIG } from "backend/internalConfig";
import { SECRETS } from "backend/mmSecrets";
import { requireMarianManager, rateLimiter } from "backend/security";
import { logger } from "backend/booking/bookingCore";

const log = logger;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_MODEL = "gpt-5-mini";
const API_TIMEOUT_MS = Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;
const MAX_HISTORY_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 2000;
const MAX_OUTPUT_TOKENS = 700;

const ALLOWED_ACTIONS = new Set([
    "REFRESH_CASHIER",
    "REFRESH_INVENTORY",
    "OPEN_CASH",
    "OPEN_FISCAL",
    "PREPARE_FISCAL_SUMMARY",
    "LOAD_FISCAL_BOOK",
    "DOWNLOAD_MANAGER_CSV",
]);

const ASSISTANT_INSTRUCTIONS = [
    "Eres la asistente privada de Marian Madrid Peluqueria y Estetica.",
    "Ayudas a Marian con gestion operativa, agenda, reservas simples y duales, caja, inventario, informes y preparacion de documentacion para gestoria.",
    "Responde siempre en espanol, con tono claro, practico y conciso.",
    "No afirmes haber realizado acciones ni tener acceso directo a sistemas. No inventes cifras, reservas, pagos ni estados.",
    "Puedes explicar procesos y recomendar revisiones. Para asuntos fiscales, laborales, legales, sanitarios o financieros, indica que requiere revision profesional antes de presentar, firmar o decidir.",
    "Nunca pidas, muestres ni reveles secretos, claves, datos de tarjeta o informacion personal innecesaria.",
    "Nunca ordenes crear una venta, conteo X, cierre Z, reembolso, cambio de agenda o envio externo. Esas operaciones requieren confirmacion separada de Marian en su formulario protegido.",
    "Puedes sugerir una accion no destructiva al final de tu respuesta usando exactamente una o varias etiquetas de esta lista: [[ACTION:REFRESH_CASHIER]], [[ACTION:REFRESH_INVENTORY]], [[ACTION:OPEN_CASH]], [[ACTION:OPEN_FISCAL]], [[ACTION:PREPARE_FISCAL_SUMMARY]], [[ACTION:LOAD_FISCAL_BOOK]], [[ACTION:DOWNLOAD_MANAGER_CSV]].",
    "Solo incluye una etiqueta cuando ayude directamente a la peticion. No uses ninguna etiqueta para acciones que creen o modifiquen registros.",
].join(" ");

function _toPublicError(error, fallbackCode = "ASSISTANT_ERROR") {
    return {
        code: String(error?.code || fallbackCode),
        message: String(error?.message || "No se pudo completar la consulta del asistente."),
    };
}

function _normalizeMessage(item) {
    const role = String(item?.role || "").toLowerCase();
    const content = _safeTrim(item?.content).slice(0, MAX_MESSAGE_CHARS);
    if (!content || !["user", "assistant"].includes(role)) return null;
    return { role, content };
}

function _extractOutputText(response) {
    if (typeof response?.output_text === "string" && response.output_text.trim()) {
        return response.output_text.trim();
    }

    const output = Array.isArray(response?.output) ? response.output : [];
    return output
        .filter((item) => item?.type === "message" && item?.role === "assistant")
        .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
        .filter((part) => part?.type === "output_text" && typeof part?.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
}

function _extractAllowedActions(text) {
    const actions = [];
    const expression = /\[\[ACTION:([A-Z_]+)\]\]/g;
    let match;

    while ((match = expression.exec(text)) !== null) {
        const action = match[1];
        if (ALLOWED_ACTIONS.has(action) && !actions.includes(action)) actions.push(action);
    }

    return {
        actions,
        cleanText: String(text || "").replace(expression, "").replace(/\n{3,}/g, "\n\n").trim(),
    };
}

async function _callAssistant(messages, _traceId) {
    const apiKey = await getSecret(SECRETS.MARIAN_ASSISTANT_OPENAI_KEY).catch(() => "");
    if (!apiKey) {
        const error = new Error("El asistente necesita configurar MARIAN_ASSISTANT_OPENAI_KEY en Wix Secrets Manager.");
        error.code = "AI_NOT_CONFIGURED";
        throw error;
    }

    const response = await withTimeout(
        fetch(OPENAI_RESPONSES_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                input: [
                    { role: "developer", content: ASSISTANT_INSTRUCTIONS },
                    ...messages,
                ],
                max_output_tokens: MAX_OUTPUT_TOKENS,
                store: false,
            }),
        }),
        API_TIMEOUT_MS,
        "marianAssistantResponses"
    );

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const error = new Error(String(payload?.error?.message || `AI request failed (${response.status})`));
        error.code = "AI_REQUEST_FAILED";
        throw error;
    }

    const text = _extractOutputText(payload);
    if (!text) {
        const error = new Error("El asistente no devolvio una respuesta util.");
        error.code = "AI_EMPTY_RESPONSE";
        throw error;
    }

    return _extractAllowedActions(text);
}

export const askMarianAssistant = webMethod(Permissions.SiteMember, async (payload = {}) => {
    const traceId = String(payload?.traceId || makeTraceId("marian-ai"));
    try {
        const limit = rateLimiter({ surface: "marianAssistant.ask", key: "marian" }, 8, 60000);
        if (!limit.allowed) {
            return {
                status: "ERROR",
                data: null,
                error: { code: "RATE_LIMITED", message: "Espera un minuto antes de continuar la conversacion." },
            };
        }

        await requireMarianManager(traceId);

        const message = _safeTrim(payload?.message).slice(0, MAX_MESSAGE_CHARS);
        if (!message) {
            return {
                status: "ERROR",
                data: null,
                error: { code: "INVALID_MESSAGE", message: "Escribe una consulta para el asistente." },
            };
        }

        const history = Array.isArray(payload?.history) ? payload.history : [];
        const normalizedHistory = history
            .map(_normalizeMessage)
            .filter(Boolean)
            .slice(-MAX_HISTORY_MESSAGES);

        const answer = await _callAssistant([
            ...normalizedHistory,
            { role: "user", content: message },
        ], traceId);

        return {
            status: "SUCCESS",
            data: {
                message: answer.cleanText,
                actions: answer.actions,
            },
            error: null,
        };
    } catch (error) {
        log.error("Marian assistant request failed", {
            traceId,
            code: error?.code,
            message: error?.message,
        });
        return { status: "ERROR", data: null, error: _toPublicError(error) };
    }
});
