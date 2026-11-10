// Pinned Up — tool server for Vapi (Exa + Jev) and live crit-wall state.
// Run: EXA_API_KEY=... TYPESAFE_API_KEY=... npm start
// Expose with: npx ngrok http 3000  (or cloudflared)  → paste URL into Vapi as Server URL.

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const EXA_KEY = process.env.EXA_API_KEY;
const JEV_KEY = process.env.TYPESAFE_API_KEY;
const PORT = process.env.PORT || 3000;

// ---------- live state for the crit wall ----------
const state = {
  project: null,          // { title, url, architect, image, pressQuote }
  lines: [],              // { speaker, text, scores }
  meters: { pretension: 0, theoHits: 0, fairPoint: 0 },
  bingo: {},              // buzzword -> true
  verdict: null,
};
const BUZZWORDS = ["liminal", "porosity", "parametric", "contextual", "honest materials",
  "threshold", "dialogue", "interrogate", "membrane", "vernacular", "tectonic", "phenomenological"];

app.get("/state", (_req, res) => res.json(state));
app.post("/reset", (_req, res) => {
  state.project = null; state.lines = []; state.bingo = {}; state.verdict = null;
  state.meters = { pretension: 0, theoHits: 0, fairPoint: 0 };
  res.json({ ok: true });
});

// ---------- helpers: preview image + readable quote ----------
async function ogImage(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const html = await (await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0" } })).text();
    clearTimeout(t);
    const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);
    return m ? new URL(m[1], url).href : null;
  } catch { return null; }
}
function cleanQuote(raw) {
  const text = String(raw)
    .replace(/[#*_>|]+/g, " ")
    .replace(/\b(Firm|Type|STATUS|YEAR|SIZE|BUDGET|Project of the Day|Project Featured)\b[^.]*?(?=[A-Z][a-z]+ [a-z])/g, " ")
    .replace(/\s+/g, " ").trim();
  const sentences = (text.match(/[^.!?]+[.!?]/g) || [text]).map((s) => {
    // drop page-header junk glued to the front: start at the first real prose run (Capital + 5 lowercase words)
    const m = s.match(/[A-Z][a-z’']+(?:,? [a-z’'\-]+){5,}.*$/);
    return (m ? m[0] : s).trim();
  });
  const good = sentences.filter((s) => s.length > 50 && s.length < 260 && !/[›]|\bsqft\b|\$\d/.test(s));
  let out = "";
  for (const s of good) { if ((out + " " + s).length > 300) break; out = (out + " " + s).trim(); }
  out = out || (good[0] || sentences[0] || "").trim();
  return out.length > 320 ? out.slice(0, 317) + "…" : out;
}

// ---------- Exa: find a real project ----------
const projectCache = new Map(); // name -> { at, result, project }
async function getProject(name) {
  const key = (name || "").trim().toLowerCase();
  const hit = key && projectCache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) { state.project = hit.project; return hit.result; }
  const out = await fetchProject(name);
  if (key && !out.error) projectCache.set(key, { at: Date.now(), result: out, project: state.project });
  return out;
}
async function fetchProject(name) {
  const query = name
    ? `${name} building architecture`
    : "new architecture project completed this month by a famous architect";
  const r = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": EXA_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      query,
      type: "fast",
      numResults: 6,
      includeDomains: ["archdaily.com", "architizer.com", "dezeen.com", "designboom.com", "wikiarquitectura.com", "en.wikipedia.org"],
      contents: { text: { maxCharacters: 1200 }, highlights: { numSentences: 3, highlightsPerUrl: 2 } },
    }),
  });
  if (!r.ok) throw new Error(`Exa ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const results = data.results || [];
  if (!results.length) return { error: "No project found" };
  // Pick the result that is actually ABOUT the building (not an obituary / news item / list).
  const words = String(name || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !["the", "and", "building"].includes(w));
  const score = (x) => {
    const t = String(x.title || "").toLowerCase(), u = String(x.url || "").toLowerCase();
    let sc = 0;
    if (words.length && words.every((w) => t.includes(w))) sc += 4;
    else sc += words.filter((w) => t.includes(w)).length;
    if (/\b(dies|died|death|obituary|dead|passes away|interview|competition winner|shortlist|opinion)\b/.test(t)) sc -= 6;
    if (/archdaily\.com\/\d+\/|architizer\.com\/projects\/|wikiarquitectura|wikipedia/.test(u)) sc += 2;
    if (/ad classics/.test(t)) sc += 2;
    if (x.image) sc += 1;
    return sc;
  };
  const top = results.slice().sort((a, b) => score(b) - score(a))[0];
  const rawImage = top.image || (await ogImage(top.url));
  // Serve the photo through our own server so hotlink-protected sites (e.g. Dezeen) can't block it.
  const image = rawImage ? `/img?u=${encodeURIComponent(rawImage)}&r=${encodeURIComponent(top.url)}` : null;
  state.project = {
    title: top.title,
    url: top.url,
    image,
    pressQuote: cleanQuote(top.highlights?.[0] || top.text || ""),
  };
  // What the hosts get: real text only. They may quote ONLY from this.
  return {
    title: top.title,
    url: top.url,
    realTextYouMayQuote: (top.text || "").slice(0, 2000),
  };
}

// ---------- Jev: score one line of crit ----------
// NOTE: verify question shapes against https://docs.typesafe.ai (types: choice / noul / score).
async function scoreLine(text) {
  const r = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${JEV_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-latest",
      state: text,
      questions: {
        is_margaux: { type: "noul", instructions: "Is this line spoken by Margaux, the pretentious theory-jargon critic, rather than Theo, the sarcastic practical one?" },
        pretension: {
          type: "noul",
          instructions: "Is this line pretentious, jargon-heavy architecture-critic speak?",
        },
        theo_landed_hit: {
          type: "noul",
          instructions: "Is this a sharp, funny, deflating joke about the building?",
        },
        fair_point: {
          type: "noul",
          instructions: "Underneath the attitude, is this a genuinely fair design criticism?",
        },
      },
    }),
  });
  if (!r.ok) throw new Error(`Jev ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const a = data.answers || {};
  const num = (x) => (typeof x?.noul === "number" ? x.noul : typeof x?.value === "number" ? x.value : 0);
  const choice = (x) => x?.choice ?? x?.value ?? Object.entries(x?.probabilities || {}).sort((p, q) => q[1] - p[1])[0]?.[0];
  return {
    speaker: num(a.is_margaux) >= 0.5 ? "Margaux" : "Theo",
    pretension: num(a.pretension),
    hit: num(a.theo_landed_hit),
    fair: num(a.fair_point),
  };
}

function recordLine(text, scores) {
  state.lines.push({ speaker: scores.speaker, text, scores });
  state.meters.pretension = scores.pretension;
  state.meters.fairPoint = scores.fair;
  if (scores.hit > 0.7) state.meters.theoHits += 1;
  const lower = text.toLowerCase();
  for (const w of BUZZWORDS) if (lower.includes(w)) state.bingo[w] = true;
  const v = lower.match(/(see me after studio|revise and resubmit|\bpass\b)/);
  if (v) state.verdict = v[1].toUpperCase();
}

// ---------- image proxy (beats hotlink protection) ----------
app.get("/img", async (req, res) => {
  try {
    const u = new URL(String(req.query.u));
    if (!/^https?:$/.test(u.protocol)) return res.status(400).end();
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(u, { signal: ctrl.signal, headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      "accept": "image/avif,image/webp,image/*,*/*;q=0.8",
      "referer": String(req.query.r || u.origin + "/"),
    } });
    clearTimeout(t);
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !type.startsWith("image/")) return res.status(502).end();
    res.set("content-type", type); res.set("cache-control", "public, max-age=3600");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});

// ---------- Vapi server URL webhook ----------
app.post("/vapi", async (req, res) => {
  const msg = req.body?.message || {};
  try {
    // 1) Tool calls
    if (msg.type === "tool-calls") {
      const results = [];
      for (const tc of msg.toolCallList || []) {
        const name = tc.function?.name;
        let args = tc.function?.arguments || {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
        let result;
        if (name === "get_project") result = await getProject(args.name);
        else result = { error: `unknown tool ${name}` };
        results.push({ toolCallId: tc.id, result: JSON.stringify(result) });
      }
      return res.json({ results });
    }

    // 2) Live transcripts → Jev meters (enable "transcript" in assistant serverMessages)
    if (msg.type === "transcript" && msg.transcriptType === "final" && msg.role === "assistant") {
      const text = msg.transcript?.trim();
      if (text) scoreLine(text).then((s) => recordLine(text, s)).catch((e) => console.error(e.message));
    }
    return res.json({});
  } catch (e) {
    console.error(e);
    return res.status(200).json({ results: [], error: e.message });
  }
});

// Quick manual tests without Vapi:
//   curl -X POST localhost:3000/test/project -H 'content-type: application/json' -d '{"name":"The Vessel"}'
//   curl -X POST localhost:3000/test/score   -H 'content-type: application/json' -d '{"text":"It is a parking garage with ambitions."}'
app.post("/test/project", async (req, res) => {
  try { res.json(await getProject(req.body?.name)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/test/score", async (req, res) => {
  try { const s = await scoreLine(req.body.text); recordLine(req.body.text, s); res.json(s); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Pinned Up on http://localhost:${PORT}`));

// ---------- client config for the Vapi Web SDK ----------
app.get("/config", (_req, res) => res.json({
  publicKey: process.env.VAPI_PUBLIC_KEY || "",
  squadId: process.env.VAPI_SQUAD_ID || "",
}));

process.on("unhandledRejection", (e) => console.error("ERR:", e?.message || e));
