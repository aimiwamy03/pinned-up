# pinned up. — the crit nobody asked for

An AI late-night podcast where two sarcastic voice hosts live-crit any building you type in.

Type a building ("The Vessel", "London Eye", "Forbidden City"), hit **Pin it up**, and:

- **Exa** finds the real project page and press text, and the building's photo fills the stage
- **Margaux** (pretentious ex-Yale crit juror) and **Theo** (burned-out ex-intern) argue about it on a live **Vapi** voice call
- **Deepgram** handles the voices (Flux TTS) and transcription (Flux STT)
- **TypeSafe Jev** scores every line in real time: pretension, "fair point (secretly)", and whether Theo landed a hit
- Buzzword bingo lights up, and the show ends with a verdict stamp: **PASS**, **REVISE AND RESUBMIT**, or **SEE ME AFTER STUDIO**

Built in one night at the Side Quest Hotline Vapi hackathon (Build Club × Vapi, San Francisco, Nov 2026).

## How it works

```
 browser (public/index.html)                 server.js (Express)
 ─────────────────────────────               ─────────────────────────────────────
 type building ──► POST /test/project ─────► Exa search → pick the real project page
                                             (skips obituaries/news), clean a quote,
 stage shows photo ◄── GET /state ◄───────── proxy the photo via /img (beats hotlinking)

 Vapi Web SDK: start squad call (mic muted)
   page = silent "producer":                 Vapi webhook  POST /vapi
   • cues Margaux to open with the           ◄── transcripts ──► Jev scores each line
     real press text                         ◄── tool calls  ──► get_project (Exa)
   • waits for real silence, cues a
     silent handoff, then cues the
     next host (no one gets cut off)
   • 6 handoffs → verdict → hang up
 captions = hosts' written words,
 paced to the voice
```

**Turn-taking:** the hosts never hand off on their own. The page listens for speech start/stop, waits ~1.2 s of real silence, sends a hidden "hand off now, say nothing" cue, and as soon as the mic changes hands cues the next host. Tune `MAX_TURNS` and `QUIET_MS` at the top of the show controller in `public/index.html`.

## Run it

Requires Node 20.6+.

```bash
npm install
cp .env.example .env      # fill in your keys
npm run dev               # or: EXA_API_KEY=... TYPESAFE_API_KEY=... VAPI_PUBLIC_KEY=... VAPI_SQUAD_ID=... npm start
```

Vapi needs to reach your server, so expose port 3000:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Open the `https://….trycloudflare.com` URL in Chrome (the mic permission prompt is required by the SDK, but the mic stays muted).

## Vapi setup

1. **Tool** `get_project` (Function). Parameter `name` (string, optional). Server URL: `https://<your-tunnel>/vapi`.
2. **Assistant "Margaux"**: Deepgram Flux transcriber, Deepgram Flux voice (e.g. Maeve, speed 0.95), GPT-4.1. First message mode: *assistant waits for user*, with an empty first message. Server URL `https://<your-tunnel>/vapi`, server messages include `transcript`; client messages include `transcript`, `model-output`, `tool-calls`, `assistant.started`. Stop speaking plan: 2 words. Silence timeout 600 s. Attach `get_project`.
3. **Assistant "Theo"**: duplicate Margaux, Flux voice (e.g. Rufus, speed 1.1), first message empty.
4. **Squad "Pinned Up"**: Margaux as start node, Theo added, each with a `handoff_to_assistant` tool connected to the other (both directions).
5. Put the squad ID in `VAPI_SQUAD_ID` and your **public** key in `VAPI_PUBLIC_KEY`.

### Host prompts (short version)

- **Margaux:** lush theory jargon ("interrogates", "porosity", "a dialogue with the site"), devastated by everything. Follows silent producer cues, never reads them aloud, only hands off when cued, never re-introduces the show, gives the verdict when cued.
- **Theo:** deadpan, translates jargon into cost, maintenance and "so… a door". One sharp jab per turn, then stops. Same cue and handoff rules.
- **Both:** critique the building, never the person; only quote real press text; PG-13.

## API notes

- **Jev** request shape is in `scoreLine()` (`POST https://api.typesafe.ai/v1/systemone`, yes/no "noul" questions). Check docs.typesafe.ai if TypeSafe changes it.
- **Exa** search is restricted to architecture sources (ArchDaily, Architizer, Dezeen, Designboom, WikiArquitectura, Wikipedia) in `fetchProject()`.

## Files

| File | What it does |
|---|---|
| `server.js` | Express server: Exa lookup + result ranking, image proxy, Jev scoring, Vapi webhook, live state |
| `public/index.html` | The late-night stage UI and the show controller (Vapi Web SDK) |
| `.env.example` | The four settings you need |
