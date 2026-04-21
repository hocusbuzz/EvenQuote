// Turn a call transcript/summary/analysis payload into a structured
// quote row. Gated behind OPENAI_API_KEY — if unset, we skip extraction
// but the call still completes cleanly (no quote row inserted).
//
// Phase 6.1: the universal quote shape (price range, availability,
// includes/excludes, notes, contact, onsite flag, confidence) is stable
// across every vertical — those are literal columns on the quotes table.
// But the *prompt* shifts per category: what "includes" typically means,
// what prices anchor to, whether onsite estimates are normal. That
// category-specific augmentation comes from service_categories.extraction_schema
// (JSONB), passed in here as `categoryContext`.
//
// If categoryContext is omitted, we use the moving defaults (backwards
// compat for anything still calling the old signature).

export type ExtractedQuote = {
  priceMin: number | null;
  priceMax: number | null;
  priceDescription: string | null;
  availability: string | null;
  includes: string[];
  excludes: string[];
  notes: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  requiresOnsiteEstimate: boolean;
  confidenceScore: number; // 0..1
};

export type CategoryContext = {
  /** Display name shown to the LLM, e.g. "house cleaning". */
  displayName: string;
  /** Contents of service_categories.extraction_schema JSONB. */
  extractionSchema?: {
    domain_notes?: string;
    includes_examples?: string[];
    excludes_examples?: string[];
    price_anchors?: string;
    onsite_estimate_common?: boolean;
  } | null;
};

export type ExtractInput = {
  transcript: string | null;
  summary: string | null;
  /**
   * Vapi's own post-call analysis, if the assistant was configured
   * with a structured-data schema. Preferred over transcript parsing
   * when present.
   */
  vapiAnalysis?: {
    structuredData?: unknown;
    successEvaluation?: string | null;
  };
  /**
   * Per-vertical prompt tuning. If omitted, we fall back to moving.
   */
  categoryContext?: CategoryContext;
};

export type ExtractResult =
  | { ok: true; quote: ExtractedQuote; source: 'vapi-structured' | 'openai' }
  | { ok: false; reason: string };

// Baked-in default so callers that don't pass a category still get
// sensible extraction behavior. Matches the moving seed in DB.
const DEFAULT_CATEGORY: CategoryContext = {
  displayName: 'moving',
  extractionSchema: {
    domain_notes:
      'Movers quote either a flat rate OR an hourly rate with estimated hours. Both are common.',
    includes_examples: ['# of movers', 'truck size', 'packing', 'basic liability'],
    excludes_examples: ['stairs fee', 'long-carry fee', 'fuel surcharge'],
    price_anchors: 'Local 1BR $400-900, local 2-3BR $900-2000.',
    onsite_estimate_common: false,
  },
};

/**
 * Preferred order:
 *   1. If Vapi's structured-data extraction already ran, trust it.
 *   2. Else if OPENAI_API_KEY is present, run a JSON-mode extraction.
 *   3. Else bail — the call still logs, but no quote row is created.
 */
export async function extractQuoteFromCall(input: ExtractInput): Promise<ExtractResult> {
  // 1. Vapi structured data wins when present.
  const fromVapi = coerceFromVapi(input.vapiAnalysis?.structuredData);
  if (fromVapi) {
    return { ok: true, quote: fromVapi, source: 'vapi-structured' };
  }

  // 2. OpenAI fallback.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'OPENAI_API_KEY not set; skipping extraction' };
  }

  const transcript = (input.transcript ?? '').trim();
  if (!transcript) {
    return { ok: false, reason: 'No transcript to extract from' };
  }

  const category = input.categoryContext ?? DEFAULT_CATEGORY;
  const prompt = buildExtractionPrompt(transcript, input.summary ?? '', category);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_EXTRACTION_MODEL ?? 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You extract structured ${category.displayName} quote data from call transcripts. Reply only with JSON matching the schema. Use null for anything not mentioned. Never invent prices.`,
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      return { ok: false, reason: `OpenAI ${res.status} ${await res.text()}` };
    }

    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return { ok: false, reason: 'OpenAI response missing content' };

    const parsed = JSON.parse(content) as unknown;
    const quote = coerceFromOpenAI(parsed);
    if (!quote) return { ok: false, reason: 'OpenAI response failed schema coercion' };
    return { ok: true, quote, source: 'openai' };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildExtractionPrompt(
  transcript: string,
  summary: string,
  category: CategoryContext
): string {
  const schema = category.extractionSchema ?? {};
  const includes = (schema.includes_examples ?? []).join(', ');
  const excludes = (schema.excludes_examples ?? []).join(', ');

  return `You are extracting a structured ${category.displayName} quote from a call transcript.

${schema.domain_notes ?? ''}

${schema.price_anchors ? `Typical price anchors: ${schema.price_anchors}` : ''}
${includes ? `"includes" field commonly captures: ${includes}` : ''}
${excludes ? `"excludes" field commonly captures: ${excludes}` : ''}
${
  schema.onsite_estimate_common
    ? 'Note: onsite estimates are COMMON in this category. If they say "I need to see it," set requiresOnsiteEstimate=true and leave prices null — do not force a number.'
    : 'Note: onsite estimates are uncommon in this category. Expect a phone quote.'
}

Transcript:
"""
${transcript.slice(0, 12000)}
"""

Summary (if available):
"""
${summary}
"""

Extract JSON with EXACTLY these keys. Use null when not stated.
{
  "priceMin": number|null,                // low end of price range in USD
  "priceMax": number|null,                // high end of price range in USD
  "priceDescription": string|null,        // e.g. "flat $1,200" or "$150/hr with 2hr min"
  "availability": string|null,            // what they said about the requested date/frequency
  "includes": string[],                   // things included in the price
  "excludes": string[],                   // things NOT included, or charged extra
  "notes": string|null,                   // anything else worth remembering
  "contactName": string|null,
  "contactPhone": string|null,
  "contactEmail": string|null,
  "requiresOnsiteEstimate": boolean,      // true if they won't quote without an in-person visit
  "confidenceScore": number               // your confidence 0..1 this quote is usable
}

Rules:
- Never invent prices. If not stated, priceMin/priceMax MUST be null.
- If onsite estimate is required, prices may be null and requiresOnsiteEstimate=true.
- confidenceScore: 0.9+ only if a concrete price range was given. 0.5-0.8 for verbal ballparks. <0.4 for onsite-only or refused.`;
}

function coerceFromVapi(data: unknown): ExtractedQuote | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  // Accept either the schema we prompt for above (camelCase) or
  // a snake_case variant that Vapi assistants sometimes produce.
  return coerceFromOpenAI({
    priceMin: d.priceMin ?? d.price_min ?? null,
    priceMax: d.priceMax ?? d.price_max ?? null,
    priceDescription: d.priceDescription ?? d.price_description ?? null,
    availability: d.availability ?? null,
    includes: d.includes ?? [],
    excludes: d.excludes ?? [],
    notes: d.notes ?? null,
    contactName: d.contactName ?? d.contact_name ?? null,
    contactPhone: d.contactPhone ?? d.contact_phone ?? null,
    contactEmail: d.contactEmail ?? d.contact_email ?? null,
    requiresOnsiteEstimate:
      d.requiresOnsiteEstimate ?? d.requires_onsite_estimate ?? false,
    confidenceScore: d.confidenceScore ?? d.confidence_score ?? 0.6,
  });
}

function coerceFromOpenAI(raw: unknown): ExtractedQuote | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const num = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s || null;
  };
  const arr = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v.map(String).filter(Boolean);
  };

  return {
    priceMin: num(r.priceMin),
    priceMax: num(r.priceMax),
    priceDescription: str(r.priceDescription),
    availability: str(r.availability),
    includes: arr(r.includes),
    excludes: arr(r.excludes),
    notes: str(r.notes),
    contactName: str(r.contactName),
    contactPhone: str(r.contactPhone),
    contactEmail: str(r.contactEmail),
    requiresOnsiteEstimate: Boolean(r.requiresOnsiteEstimate),
    confidenceScore: Math.max(0, Math.min(1, num(r.confidenceScore) ?? 0.5)),
  };
}
