/** Server-only, read-only capability probe. Never creates a funding address or
 * submits a transaction. Advanced mode is mandatory and cannot fall back. */
import { verifyQuoteSignature, type OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";

export interface FundingPreview {
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  refundTo: string;
  recipientType?: "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
  slippageBps?: number;
}

type PreviewRequest = Record<string, string | number | boolean>;

export class ConfidentialQuoteError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | null;
  constructor(status: number, code: string, correlationId: string | null) {
    super(`Confidential quote unavailable (HTTP ${status}, ${code}); no public fallback was attempted`);
    this.status = status; this.code = code; this.correlationId = correlationId;
  }
}

/** Economic data is provider-signed. The SDK does not include confidentiality
 * in its signed projection: that echo is checked over HTTPS, not proven by the
 * signature. This function makes no claim that funding has settled privately. */
export function validateDryQuote(request: PreviewRequest, quote: OneClickQuoteResponse): OneClickQuoteResponse {
  if (request.dry !== true || request.confidentiality !== "advanced") throw new Error("only advanced dry previews are allowed");
  let signatureValid = false;
  try { signatureValid = verifyQuoteSignature(quote); } catch { /* malformed provider responses are refused */ }
  if (!signatureValid) throw new Error("Confidential quote signature is invalid");
  for (const [field, value] of Object.entries(request)) {
    const actual = (quote.quoteRequest as unknown as Record<string, unknown>)[field];
    // Equivalent ISO formatting is harmless; do not coerce amounts into floats.
    const matches = field === "deadline" && typeof actual === "string" && typeof value === "string"
      ? Number.isFinite(Date.parse(actual)) && Date.parse(actual) === Date.parse(value)
      : actual === value;
    if (!matches) throw new Error(`Quote does not match the requested ${field}`);
  }
  if (quote.quote.depositAddress || quote.quote.depositMemo || quote.quote.timeWhenInactive || quote.quote.deadline) {
    throw new Error("Dry preview unexpectedly returned executable funding metadata");
  }
  return quote;
}

export async function previewConfidentialFunding(
  input: FundingPreview,
  apiKey = process.env.NEAR_INTENTS_API_KEY,
  fetcher: typeof fetch = fetch,
): Promise<OneClickQuoteResponse> {
  if (!apiKey) throw new Error("NEAR_INTENTS_API_KEY is not configured");
  if (!/^[1-9][0-9]{0,38}$/.test(input.amount)) throw new Error("amount must be a positive base-unit integer");
  if (!input.recipient || !input.refundTo || !input.originAsset || !input.destinationAsset) throw new Error("assets and destinations are required");
  if (input.recipientType !== undefined && !["INTENTS", "CONFIDENTIAL_INTENTS", "DESTINATION_CHAIN"].includes(input.recipientType)) throw new Error("unsupported recipient type");
  const slippage = input.slippageBps ?? 50;
  if (!Number.isSafeInteger(slippage) || slippage < 0 || slippage > 100) throw new Error("slippage must be between zero and 100 basis points");
  const request: PreviewRequest = {
    dry: true, swapType: "EXACT_INPUT", confidentiality: "advanced",
    depositType: "ORIGIN_CHAIN", recipientType: input.recipientType ?? "DESTINATION_CHAIN", refundType: "ORIGIN_CHAIN",
    originAsset: input.originAsset, destinationAsset: input.destinationAsset,
    amount: input.amount, recipient: input.recipient, refundTo: input.refundTo,
    slippageTolerance: slippage, quoteWaitingTimeMs: 3000,
    deadline: new Date(Date.now() + 20 * 60_000).toISOString(),
  };
  const response = await fetcher("https://1click.chaindefuser.com/v0/quote", {
    method: "POST", headers: { "content-type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(request), signal: AbortSignal.timeout(25_000), redirect: "error",
  });
  if (!response.ok) {
    let body: { message?: unknown; correlationId?: unknown } = {};
    try { body = await response.json(); } catch { /* do not echo raw provider bodies */ }
    const code = typeof body.message === "string" && /Quoting for this pair is not available/i.test(body.message)
      ? "route_unavailable" : [401, 403].includes(response.status) ? "authorization_rejected" : response.status === 429 ? "rate_limited" : "provider_error";
    const id = typeof body.correlationId === "string" && /^[0-9a-f-]{36}$/i.test(body.correlationId) ? body.correlationId : null;
    throw new ConfidentialQuoteError(response.status, code, id);
  }
  return validateDryQuote(request, await response.json() as OneClickQuoteResponse);
}
