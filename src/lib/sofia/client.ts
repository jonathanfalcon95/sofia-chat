import { normalizePhoneDigits } from "@/lib/conversations/phone-digits";
import {
  parseSofiaPauseFlags,
  sofiaApiBaseForAccountName,
} from "@/lib/sofia/routing";

export {
  parseSofiaPauseFlags,
  sofiaApiBaseForAccountName,
  whitelistContactName,
} from "@/lib/sofia/routing";

const DEFAULT_SMARTSALES = "https://smartsalesagent-api-prod.azurewebsites.net";

export type SofiaCommandAction = "stop" | "start" | "stop-all" | "start-all";

export type SofiaCommandResult = {
  success: boolean;
  action?: string;
  message?: string;
  paused?: boolean;
  linePaused?: boolean;
  chatPaused?: boolean;
  chatKey?: string;
};

export class SofiaRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SofiaRequestError";
    this.status = status;
  }
}

export async function callSofiaCommand(input: {
  accountName: string | null;
  action: SofiaCommandAction;
  guidCompany: string;
  botPhone: string;
  customerPhone?: string;
}): Promise<SofiaCommandResult> {
  const botPhone = normalizePhoneDigits(input.botPhone);
  const customerPhone = input.customerPhone
    ? normalizePhoneDigits(input.customerPhone)
    : "";
  if (!input.guidCompany.trim() || !botPhone) {
    throw new SofiaRequestError("Faltan guidCompany o botPhone", 400);
  }
  if (
    (input.action === "stop" || input.action === "start") &&
    !customerPhone
  ) {
    throw new SofiaRequestError("Falta el teléfono del cliente", 400);
  }

  const body: Record<string, string> = {
    guidCompany: input.guidCompany.trim(),
    botPhone,
  };
  if (customerPhone) body.customerPhone = customerPhone;

  return sofiaRequest({
    accountName: input.accountName,
    path: `/api/sofia/${input.action}`,
    method: "POST",
    body,
  });
}

export async function callSofiaStatus(input: {
  accountName: string | null;
  guidCompany: string;
  botPhone: string;
  customerPhone?: string;
}): Promise<SofiaCommandResult> {
  const botPhone = normalizePhoneDigits(input.botPhone);
  const params = new URLSearchParams({
    guidCompany: input.guidCompany.trim(),
    botPhone,
  });
  const customerPhone = input.customerPhone
    ? normalizePhoneDigits(input.customerPhone)
    : "";
  if (customerPhone) params.set("customerPhone", customerPhone);
  return sofiaRequest({
    accountName: input.accountName,
    path: `/api/sofia/status?${params.toString()}`,
    method: "GET",
  });
}

export async function callSmartSalesWhitelist(input: {
  guidCompany: string;
  phoneNumber: string;
  nameContact: string;
}): Promise<{ success: boolean; message?: string }> {
  const base = trimBase(
    process.env.SMARTSALES_API_BASE_URL,
    DEFAULT_SMARTSALES,
  );
  const token = process.env.SMARTSALES_API_TOKEN?.trim();
  if (!token) {
    throw new SofiaRequestError(
      "SMARTSALES_API_TOKEN no está configurada",
      500,
    );
  }
  const phoneNumber = normalizePhoneDigits(input.phoneNumber);
  if (!input.guidCompany.trim() || !phoneNumber) {
    throw new SofiaRequestError("Faltan datos para la lista blanca", 400);
  }

  let response: Response;
  try {
    response = await fetch(`${base}/WhiteList/Create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        guidCompany: input.guidCompany.trim(),
        nameContact: input.nameContact,
        phoneNumber,
      }),
      cache: "no-store",
    });
  } catch {
    throw new SofiaRequestError("No se pudo contactar SmartSales", 502);
  }

  const data = await readJson(response);
  if (!response.ok) {
    throw new SofiaRequestError(
      upstreamMessage(data, "No se pudo agregar a la lista blanca"),
      response.status,
    );
  }
  return {
    success: true,
    message:
      typeof data.message === "string"
        ? data.message
        : "Número agregado a la lista blanca",
  };
}

async function sofiaRequest(input: {
  accountName: string | null;
  path: string;
  method: "GET" | "POST";
  body?: Record<string, string>;
}): Promise<SofiaCommandResult> {
  const key = process.env.SOFIA_API_SECRET_KEY?.trim();
  if (!key) {
    throw new SofiaRequestError("SOFIA_API_SECRET_KEY no está configurada", 500);
  }
  const base = sofiaApiBaseForAccountName(input.accountName);
  let response: Response;
  try {
    response = await fetch(`${base}${input.path}`, {
      method: input.method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new SofiaRequestError("No se pudo contactar la API de Sofia", 502);
  }

  const data = await readJson(response);
  if (!response.ok || data.success === false) {
    throw new SofiaRequestError(
      upstreamMessage(data, "La API de Sofia rechazó la solicitud"),
      response.ok ? 400 : response.status,
    );
  }

  const flags = parseSofiaPauseFlags(data, typeof data.action === "string" ? data.action : undefined);
  return {
    success: true,
    action: typeof data.action === "string" ? data.action : undefined,
    message: typeof data.message === "string" ? data.message : undefined,
    paused: readBool(data.paused) ?? undefined,
    linePaused: flags.linePaused ?? undefined,
    chatPaused: flags.chatPaused ?? undefined,
    chatKey: typeof data.chatKey === "string" ? data.chatKey : undefined,
  };
}

function trimBase(value: string | undefined, fallback: string) {
  return (value?.trim() || fallback).replace(/\/$/, "");
}

function readBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const data = (await response.json()) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  } catch {
    /* empty or non-json body */
  }
  return {};
}

function upstreamMessage(data: Record<string, unknown>, fallback: string) {
  if (typeof data.message === "string" && data.message.trim()) return data.message;
  if (typeof data.error === "string" && data.error.trim()) return data.error;
  return fallback;
}
