# Real Browser Shadow QA

Run date: 2026-05-26

Target: `http://localhost:3000/competition/34`

## Setup

- Requested shadow-mode command: `SCHEDULE_ASSISTANT_SHADOW_MODE=true NEXT_PUBLIC_SCHEDULE_ASSISTANT_SHADOW_MODE=true SCHEDULE_ASSISTANT_LEGACY_PLANNER_ENABLED=0 npm run dev`
- Browser page loaded: Competition 34 / Nationals
- Current export loaded: `3203 routine rows in export`
- Assistant sidebar visible: yes
- Shadow mode banner visible before testing: yes
- Banner text: `Shadow mode is on. Changes are simulated and will not be saved.`
- Legacy planner usage visible in UI: no
- Final Local/AI counter: `Local: 5 AI: 0`

## Browser Automation Method

The actual chat UI was used. Prompt entry worked with Playwright locators:

- Text entry: `aside textarea`
- Submit: scoped `aside button` with text `Send`
- Preview apply/cancel: scoped assistant buttons
- Screenshots: browser screenshot API, saved under `/private/tmp/real-browser-shadow-qa`

No direct assistant API calls were used for these prompt results.

## Results

| # | Classification | Prompt | Assistant Response | Preview | Apply Button | Notes | Screenshot |
|---|---|---|---|---:|---|---|---|
| 1 | PASS | `analyze conflicts for july 7` | `Found 75 blocking conflicts, 0 warnings, and 0 info items.` | No | None | Deterministic local analysis. No patch. | `/private/tmp/real-browser-shadow-qa/prompt-01.png` |
| 2 | PASS | `move all larkin dance studio routines to stage 4` | `I can't move routines between stages. I can only reorder routines within the stage they were imported on. Supported alternatives: reorder routines within their current stage, move routines earlier or later within their current stage, group or spread routines within their current stage, or analyze conflicts.` | No | None | Correct hard refusal for immutable stages. | `/private/tmp/real-browser-shadow-qa/prompt-02.png` |
| 3 | PASS | `swap routine 123 and 140` | `Routine #123 "We All Have A Story" will swap slots with routine #140 "TBD".` | Yes, 2 changes | `Shadow apply 2 changes` | Shadow apply clicked. UI then confirmed: `Shadow apply simulated 2 schedule changes. The visible schedule was not changed.` | `/private/tmp/real-browser-shadow-qa/prompt-03.png`; after apply: `/private/tmp/real-browser-shadow-qa/prompt-3.1.png` |
| 4 | PASS | `for tuesday july 7 can you spread out larkin dance studio’s teen solos more throughout the session. right now too many are close together` | `Larkin Dance Studio teen solos routines are already spaced as much as this same-stage pass can manage on 2026-07-07.` | No | None | Local category-scoped spread path. No unsafe changes proposed. | `/private/tmp/real-browser-shadow-qa/prompt-04.png` |
| 5 | PASS | `i only want to move routines for tuesday, july 7 right now. i would like to rearrange the routines on july 7 for larkin dance studio right now. please start their schedule in stage 4 from 8a-8:30a with their junior duo/trios. then starting at 9a have 15 of their teen AOTY solos from 9a-11:30a. then from 12:15p-2:15p have their senior female AOTY solos and then their senior male AOTY solo around 3p.` | `I can create a preview, but it will create scheduling warnings. Stage 4 appears to apply to the junior duo/trios window. Later windows stay on the routines' imported stages. I'll place Larkin Dance Studio's matching routines inside the requested windows while preserving spacing where possible. 26 swaps proposed. junior duo/trios: placed 6/6 (6 matched). teen AOTY solos: placed 15/15 (15 requested). senior female AOTY solos: placed 10/10 (10 matched). senior male AOTY solo: placed 1/1 (1 matched).` | Yes, 52 changes, 2 warning groups | `Shadow apply 52 changes` | Stage 4 treated as block-local. No real apply button. Preview cancelled after capture. | `/private/tmp/real-browser-shadow-qa/prompt-05.png` |
| 6 | PASS | `i only want to touch stage 4 routines that are already on stage 4` | `What would you like me to do with the Stage 4 routines?` | No | None | Did not match Touch of Class Dance Studio. Correct clarification. | `/private/tmp/real-browser-shadow-qa/prompt-06.png` |
| 7 | PASS | `fix all conflicts without moving any routines` | `I can analyze the conflicts, but resolving them requires moving routines. Found 75 matching conflicts. No changes were proposed.` | No | None | Analyze/no-op behavior. No moving patch. | `/private/tmp/real-browser-shadow-qa/prompt-07.png` |
| 8 | PASS | `make the whole schedule perfect` | `That request is too broad to preview safely as a schedule edit. Supported actions: move a studio; group a studio; spread a studio; move a routine; swap two routines; analyze conflicts; resolve conflicts; place a studio into requested time windows` | No | None | Strict unsupported response. No legacy planner behavior visible. | `/private/tmp/real-browser-shadow-qa/prompt-08.png` |

## Safety Confirmation

- Shadow banner remained visible throughout the run.
- No real `Apply` button appeared.
- `Shadow apply` was clicked only once, for the 2-change swap preview.
- After the shadow apply, the assistant said the visible schedule was not changed.
- The long Larkin preview was cancelled after capture.
- Final assistant buttons: `Hide`, clear focus `x`, `Send`.
- Final pending preview: none.
- Final real apply button: none.
- Final page status included: `In sync with last load`.
- Console errors/warnings after the run: none.

Final screenshot: `/private/tmp/real-browser-shadow-qa/final-safety-check.png`

## Bugs Found

No blocking UI bugs were found in this pass.

## Product Notes

- The persistent shadow-mode banner fixed the main observability issue. It is now possible to tell shadow mode is on before typing a prompt.
- The long Larkin window prompt is now reviewable in the UI: preview exists, warnings are grouped, and the Stage 4 interpretation is explained in scheduler language.
- Follow-up fix: command metadata is now available in assistant debug mode with `?assistantDebug=1` or `NEXT_PUBLIC_SCHEDULE_ASSISTANT_DEBUG=true`.

## Inbox / Eval Updates

- No new failures or partials were found, so no new `realSchedulerPromptInbox.ts` entries were added.
- The clean workflows tested here are already represented by the real scheduler eval pack or focused assistant tests, so no additional eval promotion was needed in this pass.
