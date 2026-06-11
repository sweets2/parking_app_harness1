/**
 * api/feedback.ts — F-28
 *
 * Vercel Edge Function: receives feedback POSTs from the client and
 * forwards them to the developer's inbox via the Resend email API.
 *
 * Environment variables (injected by Vercel at runtime via globalThis):
 *   RESEND_API_KEY  — Resend API key
 *   FEEDBACK_EMAIL  — recipient email address
 *
 * Default export is required by the Vercel platform (exempt from the
 * no-default-export constraint in CLAUDE.md for this file only).
 */

export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });

  let message = "";
  try {
    const body = (await req.json()) as { message?: unknown };
    message = typeof body.message === "string" ? body.message.trim() : "";
  } catch {
    message = "";
  }
  if (!message) {
    return new Response(JSON.stringify({ error: "message required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey =
    (globalThis as Record<string, string | undefined>)["RESEND_API_KEY"] ?? "";
  const toEmail =
    (globalThis as Record<string, string | undefined>)["FEEDBACK_EMAIL"] ?? "";
  if (!apiKey || !toEmail) {
    return new Response(JSON.stringify({ error: "server misconfigured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Hoboken Parking Feedback <onboarding@resend.dev>",
      to: toEmail,
      subject: "Hoboken Parking App Feedback",
      text: message,
    }),
  });

  if (!resendRes.ok) {
    return new Response(JSON.stringify({ error: "email delivery failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
