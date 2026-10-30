# Story, hooks and pacing

Read this before planning anything a stranger will watch: an ad, a launch film, a reel, an explainer. Motion gets the first look; the story decides whether they stay. People usually arrive knowing what they want to show, not what to say. Working that out with them is part of the job, and it comes before the first layer.

## Cut first

For every line, shot and caption ask: does the video still work without it? If yes, it goes. If it is a claim nobody can check, or one the picture cannot show, it goes too. Ask again after the first cut is on the timeline: things that read well in a script often drag on screen.

## Before any layer: four answers

Get these from the user, or from what they gave you:

1. **The viewer.** Who is watching, and what are they feeling the moment the video starts? ("A founder who has re-exported the same promo six times.")
2. **The result.** The single thing they should feel, know or do when it ends.
3. **The true detail.** Something specific only this user has: a number, a moment, a mistake, their own phrasing. Viewers trust it because no one could have made it up. If the brief has none, ask for one. Never invent it.
4. **The turn.** The moment the video shows something the viewer did not expect. Without one you have a list, not a story.

When the user writes in a rush of ideas, look for their best sentence and build around it nearly word for word. It usually beats anything you would write.

## The beat sheet

Write one line per beat before you build: what is on screen, what is heard, what the viewer should feel, and how it hands over to the next beat. Join beats by cause ("but", "so"), not sequence ("and then"); a chain of "and then" is a slideshow. Give each beat a duration and an `atMs`: those numbers become the constants at the top of the scene's script (see "A scene per script" below).

## The shape

- **Hook, 0 to 3 s.** Picture, words on screen and sound all carry one idea. Frame 0 is already moving or already odd. Never open on a logo, a fade from black, or a greeting.
- **Promise, by about 5 s.** Say what they get by staying, specifically, and then deliver it.
- **Body.** Pay out something every few seconds: a fact, a reveal, a laugh, a rule they can use. Leave a question open and keep its object on screen until you answer it.
- **Turn.** Show the earlier beats in a new light. It is what makes people watch twice.
- **Close.** Answer the open question, end on an invitation rather than an order, and hold the last frame long enough to read (about 1 s more than feels needed). On a loop-friendly short, make the last frame lead back into the first.
- **Visible progress** (a counter, numbered steps, a bar filling) keeps people to the end. It counts as a hook.

## Hooks you can build here

| Hook | Why it holds | How to build it |
| --- | --- | --- |
| Broken rhythm | the eye catches a change in pace | a run of `slide-stagger` items, then one that stops dead on a `hold` key with an impact sound (`anchor: "end"`) |
| Odd first frame | something is already wrong | no fade-in: the first layer enters at `startMs: 0` with a fast `whip` or `punch`, so frame 0 is already mid-move |
| The drop | weight and gravity read instantly | the title falls and lands on its letters (`physics_body`, the word `passive`), a thud on contact |
| Open question | unfinished things nag | a sealed box or a blurred card (`blur` effect) parked in a corner, opened at the end |
| Scale | loss or size made visible | zoom out from one tile to a grid of hundreds, built by one `script_run` loop |
| Stillness | a stop is a change too | freeze everything for a beat, drop the bed (`volume` key to 0), hold longer than is comfortable |
| Before and after | contrast is instant value | a wipe between two states (`transition_add` `linear-wipe`, or a keyed mask); make the "before" honest |
| The mistake | errors demand fixing | a typo in the title, left for a full beat, then fixed: `timeline_split` the layer at that moment and `text_set` the second half, with a click on the cut |
| Countdown | an event at a known time | numbers each in a different look (`template_apply`), hard cuts on the beat, one sound family |
| Behind the scenes | process earns trust | turn the card over (`rotationY` 0 to 180) to show how it was made |
| Talking to the viewer | being looked at holds attention | a character that blinks and looks at camera (`character_bringToLife`), a line in the second person |
| Something becoming something | "what is it turning into?" | a path morph on `geometry` between same-command `d` strings |

## Plain words

Every hard word is a chance to leave. Write what a twelve-year-old would say ("so", not "therefore"), keep names of theories in your notes, never on screen, and let the picture own the first seconds: a few words at most.

Avoid phrases that read as machine-written: "in today's fast-paced world", "let's dive in", "game-changer", "unlock", "elevate", "seamless", "delve", "it's not just X, it's Y", stacks of three adjectives, and questions you answer yourself. Prefer short spoken sentences, contractions, a concrete noun in every line, one idea per breath, and one sharp contrast per video (the line people repeat). Every claim is true; if it cannot be checked, cut it.

## Words, captions and sound

- **The user's lines are theirs.** Never add or reword a sentence of their script; fix punctuation only and ask about anything else.
- **Voice.** One clip per line or scene, placed whole, never cut inside a word; when the user gives a voice file, its silences are the edit points. The voice is the loudest thing (see "The mix" in the skill).
- **Captions.** One to four words at a time (`caption_set` with word times), cleared during silences and reveals; never repeat words the designed type already shows. On vertical video keep them above the bottom fifth and clear of the right edge.
- **Sound.** One sound per thing that has weight, on its frame. A beat of silence before the biggest line. A bed that follows the acts (it can drop out for the honest moment) rather than one flat level under everything.

## The product moment

When the story sells something, the product arrives like any other beat: where the eye already is, at the size of the things around it, in the same motion language. No zoom punch onto a logo, no full-frame wordmark slammed in, no camera lunge. Either show the real mark with its name small beneath it for one beat, or let the product do one true thing on screen and name it once, in the user's words.

## A scene per script

Once the beat sheet is fixed, build each scene in one `script_run`: the beat sheet's numbers (times, sizes, colours, words) as constants at the top, then every layer, entrance, effect and sound of the scene in order, returning ids by name. Look with `view_frames` across the scene, fix with single tool calls or by editing the constants and running again (a saved script in replace mode rebuilds instead of stacking). Worked examples: `uve://skill/references/recipes.md`.

## Tests before "done"

1. **Sound off:** does each beat read in under a second from the picture alone?
2. **Picture off:** does the sound alone make you want the next beat?
3. **Any second:** jump to a random moment (`view_frames {times}` at a few random instants). Is something worth staying for on screen?
4. **Truth:** every sentence true, every number real, the user's lines intact.
5. **Cut once more:** read the script aloud and remove what you can.
