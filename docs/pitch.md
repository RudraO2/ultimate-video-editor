# Pitch: Ship Happens, Culture Coded | Sarvam (2026-10-31)

Track: multilingual AI, voice tech, regional languages, accessibility, and technology built around culture and communities.

## One line

**A voice-first video studio for people who speak but don't type English.** You talk to it in your own language; it cuts your footage, captions it in your script and releases it in other Indian languages in your own voice. It hears, thinks and speaks on Sarvam.

## The 3 minutes

**0:00–0:20, one person and the problem.**
"Meet a teacher in Indore (or a kirana owner, a local creator). She has something worth showing, a phone that records video, and Hinglish. Editing tools assume English menus, typing and hours of cutting. And when she's done, her video reaches people who speak Hindi, not the Tamil or Bengali speakers next door."

**0:20–1:50, the live demo (Easy mode, spoken in Hindi).**
1. Drop in a raw 1–2 minute Hinglish talking head recorded at the venue.
2. Press the mic and say: "इसे साफ़ करो, कैप्शन लगाओ, और तमिल में मेरी आवाज़ में बना दो" ("Clean this up, add captions, and make it in Tamil in my voice").
3. While it works, narrate what the judges see on the timeline:
   - it reads the footage once: every word with Saaras v4, where the voice is, the shots;
   - it cuts pauses, "matlab / accha / um", false starts and retakes, each cut with a reason (marks on the ruler);
   - it adds captions in Devanagari;
   - it makes a Tamil version spoken in her own cloned voice, with the captions and timing redone.
4. Play 10 seconds of the Hindi cut, then 10 seconds of the Tamil version.

**1:50–2:30, the numbers.**
- Time (rehearsal at the venue, 2026-10-31, the owner's 41.7 s Hinglish phone clip, one Hindi request, Sarvam's GLM thinking): the agent's whole run, cut, Devanagari captions and a Tamil version in the speaker's own voice, took **47 s** the first time (cut ready at 13 s: 41.7 s to 29.4 s; captions at 19 s; Tamil at 34 s) and **28 s** once Sarvam's answers were cached (cut 15 s, captions 17 s, Tamil 19 s). Run without the agent, the same tools take 2.5 s (cached); the rest is the agent thinking.
- Cost of that run: about **₹3.40**: hearing the clip ₹0.34 each time (once verbatim for cutting, once for captions), and ₹3.04 for the Tamil version (translation and the cloned voice, read twice to fit the picture).
- Cost: listening ₹0.49 a minute, voice ₹1–3 per 1,000 characters, cloning ₹2 per 1,000. A one-minute video in a second language costs a few rupees. For comparison, Sarvam's own Dubbing API is ₹40 per minute per language: our 16 s test cost ₹21.33 dubbed against ₹6.47 in the editor, which also translated the on-screen text the dub left in English (`docs/benchmarks/results.md` ▸ S1).
- All on Sarvam, in India: Saaras v4 hears (codemix for Hinglish, verbatim for cutting); the agent's model (GLM 5.3 Flash) runs on Sarvam's API; Bulbul v4 Flash and instant voice cloning speak; Sarvam Translate translates. Nothing leaves for a foreign model.

**2:30–3:00, why this and not a wrapper.**
- It's a real editor: every step is an undoable edit you can fix by hand, not a black-box render. People keep control.
- Agents work through the editor's own tools (MCP), not by writing video code: cheaper per edit, and anyone can open the same project in Advanced mode.
- Assets are the bottleneck for agent-made video, not rendering: it ships with sounds, stickers, characters that talk, and Indian scripts that draw correctly.
- Close: "Every Indian who can speak can now publish, in every Indian language, in their own voice."

## Likely judge questions

- **Why not just use Sarvam's Dubbing API?** We use it as our benchmark. The editor gives a cut, captions and translated on-screen text, lets a person fix any line, and costs less per minute; Dubbing is the right tool for a long finished film.
- **How good are the cuts?** Pauses come from a loudness gate set per file, so they are exact. Fillers and retakes come from the words, whose times are estimates (Saaras gives phrase times; we fit words to the voice). Generous mode is the default, and every cut is marked with its reason, so nothing is a surprise.
- **Consent for cloning?** Only the speaker's own voice, with their agreement. The tool says so, and the reference is 12 s of their own take.
- **Which languages?** Hindi, Bengali, Tamil, Telugu, Kannada, Malayalam, Marathi, Gujarati, Punjabi, Odia and Indian English for voice. Saaras v4 hears 22 Indian languages. Fillers are listed for 10 languages.
- **Offline or low bandwidth?** The editor runs locally; only speech and model calls go to Sarvam. Cached takes and transcripts cost nothing on reuse.
- **Who pays?** Creators and small businesses pay per video in rupees, at Sarvam's prices plus a margin. Schools and NGOs get bulk regional versions of the same lesson.
- **What did you build today vs before?** Say it plainly: the editor was built over the past weeks; the hackathon work is the Sarvam-first pipeline (Saaras v4, the agent on Sarvam, Bulbul v4 voices, voice cloning) and this demo.

## Run sheet (at the venue)

1. Start: PowerShell, `$env:SARVAM_API_KEY=[Environment]::GetEnvironmentVariable('SARVAM_API_KEY','User'); pnpm dev`. Check the chat footer reads **Sarvam (India)/GLM 5.3 Flash on Sarvam** (else pick it in the chat options).
2. Easy mode. Record the 1–2 minute Hinglish talking head on the phone; copy it to the laptop; drop it on the timeline.
3. Rehearse three times; time each run; keep the best export as the backup video (Ctrl+E). New project between runs (`project_new`, or restart). Rehearsed 2026-10-31 (ten runs, fixes on the way); the backup pair is in `~/Videos/UVE demo/` (`demo-hindi-captions.mp4`, `demo-tamil-own-voice.mp4`, 27 s each, about −14 LUFS). The mic itself was not tried in rehearsal (the request was typed): say it once by hand before going on stage.
4. Check Sarvam credit before the demo (Voice tab shows the spend; ₹100 free per verified account).
5. If the network fails: play the backup video and narrate the same story.
6. Before going on stage: one warm-up run (fills the caches so the live run is fast), then a new project.
