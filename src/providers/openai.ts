import OpenAI from 'openai';
import { config } from '../config.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const openai = () => {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not configured');
  return new OpenAI({ apiKey: config.openaiApiKey });
};
const candidateSchema = z.object({
  business_name: z.string(), phone: z.string().nullable(), product_url: z.string().nullable(),
  source_url: z.string(), evidence: z.string(), product_match: z.string(),
});
const researchSchema = z.object({
  product_summary: z.string(), product_attributes: z.array(z.string()),
  missing_questions: z.array(z.string()), sellers: z.array(candidateSchema),
});
const buyerIntakeSchema = z.object({
  kind: z.enum(['purchase_request', 'needs_product_details', 'general_chat']),
  product_request: z.string().nullable(),
  sellers: z.array(z.object({ business_name: z.string().nullable(), phone: z.string(), product_url: z.string().nullable() })).max(10),
  response: z.string().nullable(),
});
export type BuyerIntake = z.infer<typeof buyerIntakeSchema>;
export type Research = z.infer<typeof researchSchema>;

export async function understandBuyerMessage(message: string, history: string): Promise<BuyerIntake> {
  const client = openai();
  const instructions = await readFile(path.resolve('prompts/buyer-intake.md'), 'utf8');
  const result = await client.responses.create({
    model: config.openaiModel,
    max_output_tokens: 2000,
    input: `${instructions}\n\nRecent conversation:\n${history.slice(-10000)}\n\nNew buyer message:\n${message}`,
  });
  const text = result.output_text;
  if (!text) throw new Error('Buyer intake returned no structured content');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Buyer intake did not return valid JSON'); }
  return buyerIntakeSchema.parse(parsed);
}

export async function researchProduct(request: string, maxSellers: number): Promise<Research> {
  const client = openai();
  const result = await client.responses.create({
    model: config.openaiModel,
    tools: [{ type: 'web_search' }],
    max_output_tokens: 8000,
    input: `Research this buyer's product request for an Indian purchase. Identify the likely exact product and up to ${maxSellers} real sellers with public product pages and publicly attributed business phone numbers. Search the web. Never invent business names, numbers, links, product specifications, or evidence. Phone may be null unless the exact number is visible in a source and clearly belongs to the seller. Include one source URL and a short evidence excerpt per seller. Highlight ambiguity as a buyer question. Return JSON matching: {"product_summary":string,"product_attributes":string[],"missing_questions":string[],"sellers":[{"business_name":string,"phone":string|null,"product_url":string|null,"source_url":string,"evidence":string,"product_match":string}]}. Buyer request: ${request}`,
  });
  const text = result.output_text;
  if (!text) throw new Error('OpenAI research returned no structured content');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('OpenAI research did not return valid JSON'); }
  return researchSchema.parse(parsed);
}

export async function extractQuote(transcript: string, brief: string) {
  const client = openai();
  const response = await client.responses.create({
    model: config.openaiModel,
    max_output_tokens: 2000,
    input: `Extract only claims the seller actually confirmed in this call. Use null for unknown. Return JSON with business_name, product_match, quantity, unit_price, currency, gst, shipping, total, delivery, validity, callback_permission, and evidence. Money values are numbers in INR. Buyer brief: ${brief}\nTranscript:\n${transcript}`,
  });
  return response.output_text || '{}';
}
