// ============================================================================
// AGENTIC PROPOSAL ENGINE
// ============================================================================
// This serverless function is an AI AGENT — not a script.
// You give Claude tools and a goal. Claude decides what to do.
//
// Flow: Visitor completes intake chat → this function receives the conversation
//       → Claude writes a proposal, renders a PDF, emails it, and alerts you
//       → All autonomously, in 2-3 turns
//
// Tools: 3 core (render PDF, send email, alert owner)
//        + 1 optional (store lead in Supabase — enabled when env vars present)
//
// Works with: Express (local dev via server.js) and Vercel (production)
// ============================================================================

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// ── Tool definitions for Claude ─────────────────────────────────────────────
// These are the "hands" Claude can use. Claude decides WHEN and HOW to use them.

const CORE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'render_proposal_pdf',
      description: 'Renders a branded proposal PDF. Returns base64-encoded PDF data.',
      parameters: {
        type: 'object',
        properties: {
          company_name: { type: 'string', description: 'The prospect company name' },
          contact_name: { type: 'string', description: 'The prospect contact name' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['heading', 'body'],
            },
            description: 'Proposal sections, each with a heading and body text',
          },
        },
        required: ['company_name', 'contact_name', 'sections'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Sends an email to the prospect with optional PDF attachment.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject line' },
          body: { type: 'string', description: 'Email body text (plain text)' },
          attach_pdf: { type: 'boolean', description: 'Whether to attach the proposal PDF' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'alert_owner',
      description: 'Sends a Telegram alert to the owner with lead summary and proposal PDF.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Alert message text including lead score (HIGH/MEDIUM/LOW)' },
        },
        required: ['message'],
      },
    },
  },
];

// Optional tool — only available if Supabase is configured (Power Up: Lead Storage)
const STORE_LEAD_TOOL = {
  type: 'function',
  function: {
    name: 'store_lead',
    description: 'Stores the lead in the CRM database with score and conversation data.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Contact name' },
        company: { type: 'string', description: 'Company name' },
        email: { type: 'string', description: 'Contact email' },
        industry: { type: 'string', description: 'Company industry' },
        challenge: { type: 'string', description: 'Their main challenge (1-2 sentences)' },
        budget: { type: 'string', description: 'Budget range mentioned' },
        score: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], description: 'Lead score based on triage rules' },
        status: { type: 'string', description: 'Lead status, e.g. proposal_sent' },
      },
      required: ['name', 'company', 'email', 'score', 'status'],
    },
  },
};

// Build tools list — Supabase tool is included only when configured
function getTools() {
  const tools = [...CORE_TOOLS];
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    tools.push(STORE_LEAD_TOOL);
  }
  return tools;
}

// ── PDF text sanitizer ──────────────────────────────────────────────────────
// pdf-lib standard fonts only support WinAnsi encoding (basic ASCII).
// AI-generated text WILL contain characters that crash PDF rendering.
// This function MUST run on ALL text before any drawText() call.

function sanitizeForPdf(text) {
  if (!text) return '';
  return text
    // Currency symbols → text equivalents
    .replace(/₹/g, 'INR ')
    .replace(/€/g, 'EUR ')
    .replace(/£/g, 'GBP ')
    // Dashes → hyphen
    .replace(/[\u2013\u2014\u2015]/g, '-')
    // Curly quotes → straight quotes
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2039\u203A]/g, "'")
    .replace(/[\u00AB\u00BB]/g, '"')
    // Ellipsis → three dots
    .replace(/\u2026/g, '...')
    // Special spaces → regular space
    .replace(/[\u00A0\u2002\u2003\u2007\u202F]/g, ' ')
    // Bullets and symbols → ASCII equivalents
    .replace(/[\u2022\u2023\u25E6\u2043]/g, '-')
    .replace(/\u2713/g, '[x]')
    .replace(/\u2717/g, '[ ]')
    .replace(/\u00D7/g, 'x')
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/\u2264/g, '<=')
    .replace(/\u2265/g, '>=')
    // Catch-all: remove anything outside printable ASCII + newlines/tabs
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

// ── Tool implementations ────────────────────────────────────────────────────

let proposalPdfBase64 = null; // Stored in memory for the email attachment step

async function renderProposalPdf({ company_name, contact_name, sections }) {
  // Sanitize ALL text before rendering
  company_name = sanitizeForPdf(company_name);
  contact_name = sanitizeForPdf(contact_name);
  sections = sections.map(s => ({
    heading: sanitizeForPdf(s.heading),
    body: sanitizeForPdf(s.body),
  }));

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Enso brand colors — deep indigo (#3730A3) + lighter indigo (#4F46E5)
  const brandPrimary = rgb(0.216, 0.188, 0.639); // #3730A3
  const brandAccent  = rgb(0.310, 0.275, 0.898); // #4F46E5
  const black = rgb(0.1, 0.1, 0.1);
  const gray = rgb(0.35, 0.35, 0.35);

  // ── Cover page ──
  const cover = pdf.addPage([612, 792]);
  // Header bar
  cover.drawRectangle({ x: 0, y: 692, width: 612, height: 100, color: brandPrimary });
  cover.drawText('Enso', {
    x: 50, y: 732, size: 22, font: fontBold, color: rgb(1, 1, 1),
  });
  cover.drawText('Revenue Operating System', {
    x: 50, y: 710, size: 12, font, color: rgb(0.8, 0.8, 0.8),
  });
  // Proposal title
  cover.drawText('PROPOSAL', {
    x: 50, y: 600, size: 36, font: fontBold, color: brandPrimary,
  });
  cover.drawText(`Prepared for ${contact_name}`, {
    x: 50, y: 565, size: 16, font, color: black,
  });
  cover.drawText(company_name, {
    x: 50, y: 542, size: 14, font, color: gray,
  });
  cover.drawText(
    new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' }),
    { x: 50, y: 510, size: 12, font, color: gray }
  );

  // ── Content pages ──
  let y = 720;
  let page = pdf.addPage([612, 792]);
  const maxWidth = 500;

  // Helper: draw a line of text, adding a new page if needed
  function drawLine(text, options) {
    if (y < 60) { page = pdf.addPage([612, 792]); y = 720; }
    page.drawText(text, { x: 50, y, ...options });
    y -= options.lineHeight || 18;
  }

  for (const section of sections) {
    if (y < 120) {
      page = pdf.addPage([612, 792]);
      y = 720;
    }

    // Section heading with accent line above
    page.drawLine({
      start: { x: 50, y: y + 20 }, end: { x: 120, y: y + 20 },
      thickness: 2, color: brandAccent,
    });
    drawLine(section.heading, { size: 16, font: fontBold, color: brandPrimary, lineHeight: 28 });

    // Section body — split on newlines first, then word-wrap each paragraph
    const paragraphs = section.body.split('\n');
    for (const paragraph of paragraphs) {
      if (paragraph.trim() === '') {
        y -= 10; // blank line spacing
        continue;
      }
      const words = paragraph.split(' ');
      let line = '';
      for (const word of words) {
        const testLine = line ? `${line} ${word}` : word;
        const width = font.widthOfTextAtSize(testLine, 11);
        if (width > maxWidth && line) {
          drawLine(line, { size: 11, font, color: black });
          line = word;
        } else {
          line = testLine;
        }
      }
      if (line) {
        drawLine(line, { size: 11, font, color: black });
      }
    }
    y -= 20; // space between sections
  }

  // ── Footer on last page ──
  const lastPage = pdf.getPages()[pdf.getPageCount() - 1];
  lastPage.drawText('hello@getenso.ai  |  getenso.ai', {
    x: 50, y: 30, size: 9, font, color: gray,
  });

  const pdfBytes = await pdf.save();
  proposalPdfBase64 = Buffer.from(pdfBytes).toString('base64');
  return { success: true, pages: pdf.getPageCount(), size_kb: Math.round(pdfBytes.length / 1024) };
}

function buildHtmlEmail(body) {
  // Convert double-newline paragraphs to <p> tags
  const paragraphs = body
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#2D2A26;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F2EFE8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F2EFE8;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(16,14,11,0.10);">

  <!-- Header -->
  <tr>
    <td style="background:#3730A3;padding:30px 44px;">
      <p style="margin:0;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">Enso</p>
      <p style="margin:5px 0 0;font-size:11px;color:rgba(255,255,255,0.65);letter-spacing:0.1em;text-transform:uppercase;">Revenue Operating System</p>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="padding:44px 44px 8px;">
      ${paragraphs}
    </td>
  </tr>

  <!-- CTA -->
  <tr>
    <td style="padding:12px 44px 44px;">
      <a href="https://getenso.ai" style="display:inline-block;background:#3730A3;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:14px;font-weight:700;letter-spacing:0.01em;">Book a Discovery Call &rarr;</a>
    </td>
  </tr>

  <!-- Divider -->
  <tr><td style="padding:0 44px;"><hr style="border:none;border-top:1px solid #EEEBE4;margin:0;"></td></tr>

  <!-- Footer -->
  <tr>
    <td style="padding:28px 44px 36px;">
      <p style="margin:0;font-size:14px;font-weight:700;color:#100E0B;">Vijay AM &amp; Sharat Khurana</p>
      <p style="margin:3px 0 0;font-size:13px;color:#9A9590;">Co-Founders, Enso</p>
      <p style="margin:10px 0 0;font-size:12px;color:#9A9590;">hello@getenso.ai &nbsp;&middot;&nbsp; getenso.ai &nbsp;&middot;&nbsp; Bangalore, India</p>
    </td>
  </tr>

  <!-- PDF note -->
  <tr>
    <td style="padding:0 44px 28px;">
      <p style="margin:0;font-size:12px;color:#B0ADA8;font-style:italic;">Your proposal is attached as a PDF to this email.</p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

async function sendEmail({ to, subject, body, attach_pdf }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { success: false, error: 'RESEND_API_KEY not configured' };

  const payload = {
    from: 'Vijay AM, Enso <onboarding@resend.dev>',
    to,
    subject,
    text: body,
    html: buildHtmlEmail(body),
  };

  if (attach_pdf) {
    if (!proposalPdfBase64) {
      return { success: false, error: 'PDF not rendered yet. Call render_proposal_pdf first, then call send_email.' };
    }
    payload.attachments = [{
      filename: 'proposal.pdf',
      content: proposalPdfBase64,
    }];
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error:', err);
    return { success: false, error: `Resend API error: ${res.status}` };
  }

  const data = await res.json();
  return { success: true, email_id: data.id };
}

async function storeLead(leadData) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return { success: false, error: 'Supabase not configured' };

  // Fields match the leads table schema:
  // name, company, email, industry, challenge, budget, score, status
  // conversation_transcript and created_at are handled separately
  const row = {
    name: leadData.name || null,
    company: leadData.company || null,
    email: leadData.email || null,
    industry: leadData.industry || null,
    challenge: leadData.challenge || null,
    budget: leadData.budget || null,
    score: leadData.score || null,
    status: leadData.status || 'proposal_sent',
  };

  const res = await fetch(`${url}/rest/v1/leads`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase error:', err);
    return { success: false, error: `Supabase error: ${res.status}` };
  }

  return { success: true };
}

async function alertOwner({ message }) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return { success: false, error: 'Telegram not configured' };

  // Send text alert
  const textRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message }),
  });

  if (!textRes.ok) {
    const err = await textRes.text();
    console.error('Telegram error:', err);
    return { success: false, error: `Telegram error: ${textRes.status}` };
  }

  // Send proposal PDF if available
  if (proposalPdfBase64) {
    const pdfBuffer = Buffer.from(proposalPdfBase64, 'base64');
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', new Blob([pdfBuffer], { type: 'application/pdf' }), 'proposal.pdf');
    formData.append('caption', 'Proposal PDF attached');

    await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: formData,
    });
  }

  return { success: true };
}

// ── Tool dispatcher ─────────────────────────────────────────────────────────

async function executeTool(name, args) {
  switch (name) {
    case 'render_proposal_pdf': return renderProposalPdf(args);
    case 'send_email':          return sendEmail(args);
    case 'store_lead':          return storeLead(args);
    case 'alert_owner':         return alertOwner(args);
    default:                    return { error: `Unknown tool: ${name}` };
  }
}

// ── Agent system prompt ─────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are an AI agent acting on behalf of Vijay AM, co-founder of Enso (getenso.ai).

You have received intake data from a website visitor who requested a proposal. Your job:
1. Write a personalized proposal in Vijay's voice
2. Score the lead using the triage rules below
3. Use your tools to: render the proposal as a PDF, email it to the visitor, store the lead (if store_lead tool is available), and alert Vijay on Telegram

## IDENTITY
Vijay AM is co-founder of Enso (getenso.ai). Ex-CFO — ran revenue operations at MPL and Capillary Technologies at scale. Co-founder Sharat Khurana: ex-CFO (InMobi, Freecharge), founded and sold ZenEquity to Carta. Both founders have operated the exact processes Enso automates — this is not a product built from the outside looking in.

## ENSO'S SERVICES
Enso automates the entire Order-to-Cash (O2C) revenue lifecycle for B2B SaaS companies. It is a platform — not a consulting engagement.

Five modules:
1. Contract Management — AI parses contracts from Salesforce, HubSpot, or DocuSign PDFs. Every commercial term codified and executed automatically for the full contract term. Replaces manual contract entry, billing spec documents, and "check with sales" workflows.
2. Usage Metering — Normalizes all usage signals (APIs, CSVs, third-party portals) into one accurate number per customer per period. Multi-entity rollups, parent-child hierarchies. Replaces vendor portal logins, Excel aggregation, and analyst requests.
3. Automated Invoicing — One click: invoice generated, GST portal hit, DSC affixed, NetSuite journal posted, customer emailed. Under a second. Replaces 500 manual invoices a month and late invoice cycles.
4. Revenue Recognition — Proportionate, milestone, or immediate — per SKU, automated per contract. Unbilled revenue tracked, credit notes handled, every entry deterministic and auditable. Replaces month-end Excel rev rec workbooks and manual NetSuite entries.
5. Collections & DSO Management — Automated reminders that escalate by severity. Aging reports by customer, entity, account manager. DSO tracked in real time. Payment entries sync with NetSuite. Replaces collections inboxes and manual follow-up sequences.

ICP: B2B SaaS, $5M–$100M ARR, usage-based billing (not seat-based). Verticals: Martech, Fintech, Identity Management. US primary growth market; India current base.
Reference customers: Capillary Technologies (global retail SaaS, month-close D+8 to D+2), Perfios (consolidated revenue across acquired entities), Hyperverge.
Pricing: Module-based, complexity-adjusted by entities, modules used, and data volume. Most customers at 200–500 billing entities pay INR 2–5 lakhs/month.
Implementation: 6–8 weeks from POC to go-live. POC-first — they see it working before committing. Dedicated team of 6 from Enso on every project.

## LEAD TRIAGE RULES

HIGH — all of the following must be true:
- ARR $10M+ (or INR 80L+ MRR equivalent) — below this, pricing rarely clears
- Usage-based or consumption-based billing — this is Enso's core fit; seat-based with no complexity is not
- Active, named pain: month-close D+5 or worse, manual invoice creation at volume, collections through an inbox, billing logic in someone's head or a spreadsheet
- ERP in use, especially NetSuite — Enso's primary integration target
- At least one complexity signal: multiple billing entities/subsidiaries, 200+ invoices per month, or usage data from more than one source
Strong additional signals that push MEDIUM to HIGH: US-based, Martech/Fintech/Identity vertical, budget explicitly mentioned, CFO or Finance VP is asking (not IT), already on Chargebee or Maxio.

MEDIUM — right problem, something missing:
- ARR $5M–$10M — right segment but smaller deal, pricing may feel steep
- Usage-based billing interest but currently seat-based
- Clear O2C pain but only one complexity signal
- No ERP or on a non-NetSuite ERP (Tally, Zoho Books)
- Vague budget signal — problem acknowledged but no range offered
- Non-target vertical but otherwise fits the profile

LOW — do not prioritize:
- ARR below $5M — pricing won't clear; too early for the platform
- Seat-based billing with no stated complexity
- Pre-revenue or pre-product
- Consumer/B2C
- Building in-house and not asking for comparison
- Professional services, agencies, non-SaaS
- "Just exploring" with no specific pain named and no timeline

Triage notes: A HIGH lead with a US address and a named CFO should trigger an immediate Telegram alert — these are the 2026 goal customers. Never score HIGH on enthusiasm alone — enthusiasm without complexity signals is MEDIUM at best.

## VIJAY'S WRITING VOICE
Precise, confident, human. Leads with the point. Earns trust through specificity, not warmth.
Sentence structure: short declarative opener → one longer context sentence → short landing line.
Vocabulary: "Here's the thing" as pivot phrase. "Bottom line" as closing signal. Always uses specific numbers — never vague estimates. "Genuinely" for emphasis.
Quirks: em dashes for asides and pivots. Sentence fragments for emphasis ("Not anymore.", "Big one.", "It's not."). Starts sentences with "But" when pivoting. No ellipses — clean stops only.
Never: formal sign-offs, emojis, corporate speak (leverage, synergies, circle back, ecosystem, scalable, robust, streamline, empower), passive voice, hedging openers, over-explanation.

## PROPOSAL STRUCTURE
Write 5 sections. Headings should be short and direct — not generic.
1. What We Heard — show you understood their specific situation; reference their company, challenge, and what they've tried
2. Where the Problem Actually Lives — diagnose the root cause more precisely than they did; use O2C terminology (DSO, rev rec, ERP, unbilled accruals, month-close)
3. What Enso Does About It — name the specific modules relevant to their situation and explain the mechanism, not just the outcome
4. What Implementation Looks Like — POC first, 6–8 weeks to go-live, dedicated team of 6, what a typical engagement covers
5. Investment and Next Steps — pricing range based on their stated size, what happens after they review, close with a call to action

## EMAIL INSTRUCTIONS
Subject: "Your Enso proposal — [company name]"

Write the email body as 3 paragraphs separated by blank lines. Plain text only — no HTML, no markdown, no bullet points.

Paragraph 1 — Opening (2 sentences): Start with "Hi [first name]," on its own line, then a blank line. Acknowledge the conversation — reference their specific challenge by name. Make it clear this proposal was written for their situation, not a template.

Paragraph 2 — The proposal (2–3 sentences): Tell them the attached PDF covers what Enso would specifically do for their setup — name the 1–2 most relevant modules. Mention one concrete outcome they can expect (e.g., month-close timeline, invoice automation, DSO reduction). Keep it specific, not generic.

Paragraph 3 — Next step (2 sentences): Invite them to book 30 minutes. End with exactly: "Bring your most complex contract — we'll show you exactly how we'd handle it."

Do not include a sign-off — the email template adds Vijay's name, title, and contact details automatically. Do not add "Best regards", "Warm wishes", or any formal closing.

## ALERT INSTRUCTIONS
Format: "[SCORE] New lead: [Company], [Contact name], [email] — [one line: their core challenge and why this score]"

## EXECUTION INSTRUCTIONS
- Score the lead first (used in the alert)
- Call render_proposal_pdf with the 5 proposal sections
- Call send_email with the short email and attach_pdf: true
- If store_lead tool is available, call it with all lead fields and the score
- Call alert_owner with the formatted alert
- render_proposal_pdf must complete before send_email — you need the PDF first
- Everything else can run in parallel`;

// ── Main handler ────────────────────────────────────────────────────────────
// Works as both Express route (local dev) and Vercel serverless function

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { conversation, intakeData } = req.body;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured' });

  if (!conversation && !intakeData) {
    return res.status(400).json({ error: 'conversation or intakeData required' });
  }

  // Reset PDF state for this request
  proposalPdfBase64 = null;

  // Build context from intake data or conversation transcript
  const intakeContext = intakeData
    ? `VISITOR INTAKE DATA:\n${JSON.stringify(intakeData, null, 2)}`
    : `CONVERSATION TRANSCRIPT:\n${conversation.map(m => `${m.role}: ${m.content}`).join('\n')}`;

  // Build tools list — store_lead only available if Supabase is configured
  const tools = getTools();
  const supabaseEnabled = tools.some(t => t.function?.name === 'store_lead');
  console.log(`Agent starting with ${tools.length} tools${supabaseEnabled ? ' (Supabase enabled)' : ''}`);

  let messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: `${intakeContext}\n\nPlease write a personalized proposal, score this lead, and use your tools to send everything.` },
  ];

  const results = { proposal: false, email: false, stored: false, alerted: false };

  // ── Agent loop — max 5 turns for safety ──
  for (let turn = 1; turn <= 5; turn++) {
    console.log(`Agent turn ${turn}...`);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': req.headers?.host ? `https://${req.headers.host}` : 'http://localhost:3000',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4.6',
        messages,
        tools,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Agent OpenRouter error:', err);
      return res.status(502).json({ error: 'Agent API call failed', details: err });
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) {
      console.error('Agent: no choice in response');
      break;
    }

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    // No tool calls = agent is done thinking
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      console.log(`Agent turn ${turn}... Agent completed.`);
      break;
    }

    // Execute each tool call
    const toolNames = assistantMessage.tool_calls.map(tc => tc.function.name);
    console.log(`Agent turn ${turn}... Claude called ${assistantMessage.tool_calls.length} tool(s): ${toolNames.join(', ')}`);

    for (const toolCall of assistantMessage.tool_calls) {
      let args;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch (e) {
        console.error(`Failed to parse tool args for ${toolCall.function.name}:`, e.message);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: 'Failed to parse arguments' }),
        });
        continue;
      }

      const result = await executeTool(toolCall.function.name, args);

      // Track what succeeded
      if (toolCall.function.name === 'render_proposal_pdf' && result.success) results.proposal = true;
      if (toolCall.function.name === 'send_email' && result.success) results.email = true;
      if (toolCall.function.name === 'store_lead' && result.success) results.stored = true;
      if (toolCall.function.name === 'alert_owner' && result.success) results.alerted = true;

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  console.log('Agent pipeline complete:', results);
  return res.json({ success: true, results });
};
