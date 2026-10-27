# Louro Meet Transcript Improvements Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: activate it by name and follow its Execute flow and Critical Rules. Each completed task gets its own local Conventional Commit, with task and spec status updates included.

The current task instruction does not authorize adding or running tests. Do not add or run tests unless the user explicitly asks to test or verify this implementation. Use only the syntax and diff checks listed below. If the user later asks for tests, revise this plan's matrix and task fields first.

**Design**: `.specs/features/louro-meet-transcript/design.md`
**Status**: Approved; implementation in progress

---

## Test Coverage Matrix

> Generated from `README.md`, `pyproject.toml`, existing tests, and the feature spec. No AGENTS.md, CONTRIBUTING guide, testing guide, or project build/lint script was found. The repository has Python backend tests and Node extension tests, but the active instruction prohibits adding or running tests in this task; therefore the authorized test type is `none` for all tasks. Existing tests remain untouched.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Backend model/store/API/retention/export | none | No tests added or executed under the current instruction; existing pytest coverage remains unchanged | `tests/test_*.py` | Not authorized for this task |
| Extension content scripts/UI | none | No tests added or executed under the current instruction; existing Node coverage remains unchanged | `tests/extension/*.test.mjs` | Not authorized for this task |

Available project test commands, recorded but not authorized for this task: `.venv/bin/python -m pytest`, `npm test`, and `npm run verify` (real-browser checks).

## Gate Check Commands

> The project defines no build or lint command. Use syntax and diff checks only; do not run project tests.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | After a task that changes JavaScript | `node --check <changed-extension-file.js>` |
| Full | After a task that changes Python | `python3 -m py_compile <changed-backend-file.py>` |
| Build | At phase completion | `git diff --check` plus syntax checks for every changed JavaScript/Python file in that phase |

---

## Execution Plan

Phases run in sequence. Tasks within a phase are executed in listed order. Cross-phase dependencies point only to earlier phases.

### Phase 1: Backend persistence and transcript API

```
T1 -> T2
T1 -> T3
T2 -> T4
T3 -> T4
```

### Phase 2: Meet capture and extension bridge

```
T5 -> T6
T2 -> T7
T6 -> T7
T8
```

### Phase 3: Transcript and control UI

```
T9
T10
T9 -> T10
T11
T2 -> T12
T9 -> T12
T11 -> T12
T10 -> T13
```

---

## Task Breakdown

### T1: Add chat message model and SQLite persistence

**What**: Define the chat message record and add a dedicated `chat_messages` table with session-scoped idempotency, ordered history, and store methods.
**Where**: `backend/store.py`
**Supporting file**: `backend/models.py`
**Depends on**: None
**Reuses**: `SessionStore` locking, schema initialization, and `Note`/`Session` model patterns.
**Requirement**: LMT-17, LMT-18, LMT-19, LMT-21, LMT-22

**Tools**:

- MCP: NONE (local repository only)
- Skill: `tlc-spec-driven`

**Done when**:

- [x] `ChatMessage` carries the session ID, unique client ID, author, plain-text message, capture-relative time, and historical flag.
- [x] Existing databases gain the new table on open without altering or deleting `segments` or `notes`.
- [x] Store methods insert idempotently, preserve same-time snapshot order, load by session, and delete chat rows with their session.
- [x] `python3 -m py_compile backend/models.py backend/store.py` and the phase Build gate pass.

**Tests**: none (not authorized by the current instruction)
**Gate**: Full
**Commit**: `feat(store): persist meet chat messages`

### T2: Add chat ingestion and unified transcript API events

**What**: Extend the active-session API with bounded chat ingestion, chat/note WebSocket broadcasts, and a history response that includes chat and notes while preserving existing segment fields.
**Where**: `backend/app.py`
**Supporting file**: `backend/store.py` (ID-bearing note projection)
**Depends on**: T1
**Reuses**: Existing session validation, local API security, transcript subscriber list, `_broadcast_segments`, and `/api/sessions/{session_id}/notes`.
**Requirement**: LMT-05, LMT-17, LMT-20, LMT-21, LMT-22, LMT-30

**Tools**:

- MCP: NONE (local repository only)
- Skill: `tlc-spec-driven`

**Done when**:

- [x] The chat route rejects unknown sessions, malformed objects, and oversized batches/fields without persisting them.
- [x] Repeated `(session_id, client_id)` messages are returned/broadcast at most once.
- [x] Historical messages receive `at_sec = 0`; later messages receive capture-relative time from observation time.
- [x] Transcript history keeps `segments`, `full_text`, and `segment_count`, and adds ID-bearing `chat_messages` and `notes`.
- [x] Accepted chat and newly saved notes are broadcast as typed WebSocket events; existing transcript and complete events remain compatible.
- [x] `python3 -m py_compile backend/app.py` and the phase Build gate pass.

**Tests**: none (not authorized by the current instruction)
**Gate**: Full
**Commit**: `feat(api): stream chat and note timeline events`

### T3: Retain sessions that contain chat

**What**: Make the existing minimum-duration retention decision treat stored chat as session content while preserving the current duration threshold and zero-disables-filter behavior.
**Where**: `backend/retention.py`
**Depends on**: T1
**Reuses**: `worth_keeping`, `should_discard`, and the existing `LOURO_MIN_DURATION_SEC` configuration.
**Requirement**: LMT-22, LMT-31, LMT-34

**Tools**:

- MCP: NONE (local repository only)
- Skill: `tlc-spec-driven`

**Done when**:

- [x] The retention decision accepts chat presence without changing the default 30-second minimum.
- [x] Existing speech-only and zero-minimum behavior remains represented in the same retention path.
- [x] `python3 -m py_compile backend/retention.py` and the phase Build gate pass.

**Tests**: none (not authorized by the current instruction)
**Gate**: Full
**Commit**: `feat(retention): keep chat-only meeting sessions`

### T4: Include chat in session completion and markdown export

**What**: Pass stored chat through session finalization and write chat, notes, and speech into one capture-time-ordered markdown transcript, including chat-only retained sessions.
**Where**: `backend/exporter.py`
**Supporting file**: `backend/app.py`
**Depends on**: T2, T3
**Reuses**: Existing export metadata, `clean`, `attribute`, `_note_line`, and `export_all`.
**Requirement**: LMT-19, LMT-20, LMT-22

**Tools**:

- MCP: NONE (local repository only)
- Skill: `tlc-spec-driven`

**Done when**:

- [x] Export includes each message's author and text, uses the capture time for later messages, and uses “já visível ao iniciar” for the initial visible snapshot.
- [x] Export interleaves later chat with notes and speech by capture-relative time and retains current session metadata/speaker attribution.
- [x] A session with chat and no speech can be exported when it meets the existing retention rule.
- [x] Normal completion, refinement, and `export_all` pass their stored chat records to export/retention.
- [x] `python3 -m py_compile backend/app.py backend/exporter.py` and the phase Build gate pass.

**Tests**: none (not authorized by the current instruction)
**Gate**: Build
**Commit**: `feat(export): include meet chat in meeting transcripts`

### T5: Add the opt-in Meet chat preference

**What**: Add a default-off popup setting that persists whether rendered Meet chat may be captured.
**Where**: `extension/popup.js`
**Supporting files**: `extension/popup.html`, `extension/_locales/pt_BR/messages.json`
**Depends on**: None
**Reuses**: Existing `chrome.storage.local` preference controls for `autoCapture` and `overlayEnabled`.
**Requirement**: LMT-17, LMT-18, LMT-23

**Tools**:

- MCP: NONE (local repository only)
- Skill: `tlc-spec-driven`

**Done when**:

- [x] The setting defaults to off when no stored value exists and persists changes in `chrome.storage.local`.
- [x] The popup explains that only chat rendered by Meet is included and that the extension will not open the chat pane.
- [x] `node --check extension/popup.js` and the phase Build gate pass.

**Tests**: none (not authorized by the current instruction)
**Gate**: Quick
**Commit**: `feat(extension): add opt-in meet chat capture`

### T6: Collect rendered Meet chat messages

**What**: Add a Meet content script that snapshots visible message cards when capture begins and observes later rendered messages without opening the chat pane.
**Where**: `extension/meet-chat.js`
**Supporting file**: `extension/manifest.json`
**Depends on**: T5
**Reuses**: Existing Meet content-script isolation, `chrome.storage` lifecycle, and visible DOM reader conventions.
**Requirement**: LMT-17, LMT-18, LMT-19, LMT-20, LMT-21, LMT-23, LMT-29, LMT-30, LMT-34

**Tools**:

- MCP: NONE (local repository only)
- Skill: `tlc-spec-driven`

**Done when**:

- [x] Observation runs only while capture is active and chat inclusion is enabled.
- [x] A visible start snapshot is marked historical; later observations carry observation time and a stable client ID.
- [x] The script does not open Meet chat or read hidden/unrendered history; when chat is closed it waits for rendered messages.
- [x] Unknown authors use a neutral label, and repeated DOM observation is deduplicated using stable DOM metadata where available plus per-session node tracking.
- [x] Turning the setting off stops new messages; turning it on mid-capture does not relabel earlier content as start history.
- [x] `manifest.json` loads the collector in the correct content-script order.
- [x] `node --check extension/meet-chat.js` and the phase Build gate pass.

**Tests**: none (not authorized by the current instruction)
**Gate**: Quick
**Commit**: `feat(extension): capture rendered meet chat messages`

### T7: Forward chat messages from Meet to the local backend

**What**: Connect the Meet collector's start/stop and bounded message batches to the active Louro session and local chat endpoint.
**Where**: `extension/background.js`
**Supporting file**: `extension/meet-chat.js` (limit collection to the capture tab)
**Depends on**: T2, T6
**Reuses**: `postToBackend`, active-session storage, `chrome.tabs.sendMessage`, and existing capture lifecycle notifications.
**Requirement**: LMT-17, LMT-18, LMT-20, LMT-22, LMT-29, LMT-34

**Tools**:

- MCP: NONE (local repository only)
- Skill: `tlc-spec-driven`

**Done when**:

- [x] Chat observation starts only for the active Meet tab and session when the stored preference is enabled.
- [x] Chat observation stops when capture stops or the preference is disabled.
- [x] Batches are posted only to the existing loopback backend and retried in a bounded way when the backend has not initialized the active session yet.
- [x] Backend failure does not claim that unsaved chat was stored and does not stop the existing audio capture.
- [x] `node --check extension/background.js` and the phase Build gate pass.

**Tests**: none (not authorized by the current instruction)
**Gate**: Build
**Commit**: `feat(extension): forward captured chat to louro backend`

### T8: Attempt follow-call capture on Meet's immediate join click

**What**: Detect the user's immediate “Participar agora” / “Join now” action and attempt follow-call capture from that gesture, retaining a visible manual-start fallback.
**Where**: `extension/meet-call.js`
**Supporting files**: `extension/background.js`, `extension/_locales/pt_BR/messages.json`
**Depends on**: None
**Reuses**: Existing `autoCapture`, `startCapture`, active-session guard, recording badge, and manual popup start.
**Requirement**: LMT-24, LMT-25, LMT-26, LMT-27, LMT-28, LMT-31, LMT-32

**Tools**:

- MCP: NONE (local repository only)
- Skill: `tlc-spec-driven`

**Done when**:

- [x] Only the immediate-join action requests capture while follow-call is enabled; “Ask to join” does not.
- [x] The capture message includes its sender tab and is sent directly from the click handler.
- [x] The service worker invokes `chrome.tabCapture.getMediaStreamId` before awaiting storage, tab lookup, or other preparation.
- [x] Existing/in-flight capture prevents a duplicate session; a failed attempt does not set recording state and displays the manual-start reminder.
- [x] `call_state` transitions alone no longer initiate capture; they continue to stop a capture after the call ends.
- [x] `node --check extension/meet-call.js extension/background.js` and the phase Build gate pass.

**Tests**: none (not authorized by the current instruction)
**Gate**: Build
**Commit**: `fix(extension): start follow-call capture from meet join`

### T9: Add a shared auto-growing annotation field helper

**What**: Create a helper that wraps multiline note text, grows fields up to eight lines, and scrolls overflow while preserving the 1000-character limit.
**Where**: `extension/note-input.js`
**Depends on**: None
**Reuses**: Existing note fields' 1000-character maximum and Enter-to-save interaction.
**Requirement**: LMT-08, LMT-09, LMT-10

**Tools**:

- MCP: NONE (local repository only)
- Skill: `tlc-spec-driven`

**Done when**:

- [x] The helper binds to a textarea, wraps text, grows to at most eight visible lines, and enables vertical scrolling beyond that height.
- [x] The helper does not submit or mutate note content; each host keeps its existing save behavior.
- [x] `node --check extension/note-input.js` and the phase Build gate pass.

**Tests**: none (not authorized by the current instruction)
**Gate**: Quick
**Commit**: `feat(extension): add multiline note field helper`

### T10: Use the growing annotation field in the popup and Meet overlay

**What**: Replace the popup and Meet overlay single-line note inputs with helper-bound textareas that preserve Enter-save and Shift+Enter-newline behavior.
**Where**: `extension/popup.html`
**Supporting files**: `extension/popup.js`, `extension/popup.css`, `extension/meet-overlay.js`, `extension/manifest.json`
**Depends on**: T9
**Reuses**: T9 helper and existing `add_note` runtime API.
**Requirement**: LMT-08, LMT-09, LMT-10

**Tools**:

- MCP: NONE (local repository only)
- Skill: `tlc-spec-driven`

**Done when**:

- [x] The popup and overlay fields wrap long text and preserve earlier text while typing.
- [x] Both fields show up to eight lines and scroll overflow; each retains `maxlength=1000`.
- [x] Enter saves non-whitespace text; Shift+Enter inserts a newline without saving.
- [x] `node --check` succeeds for changed JavaScript and the phase Build gate passes.

**Tests**: none (not authorized by the current instruction)
**Gate**: Build
**Commit**: `feat(extension): make meeting notes multiline and readable`

### T11: Toggle and simplify the transcript side panel

**What**: Reflect whether the Louro panel is open, toggle its label between “Ver transcrição completa” and “Fechar transcrição”, and remove the redundant top logo/status/session-ID header.
**Where**: `extension/popup.js`
**Supporting files**: `extension/popup.html`, `extension/_locales/pt_BR/messages.json`, `extension/background.js`, `extension/sidepanel.js`, `extension/sidepanel.html`
**Depends on**: None
**Reuses**: Existing `chrome.sidePanel.open`, popup panel button, and Chrome's native side-panel close affordance.
**Requirement**: LMT-01, LMT-02, LMT-03, LMT-04, LMT-33

**Tools**:

- MCP: NONE (local repository only)
- Skill: `tlc-spec-driven`

**Done when**:

- [x] The closed/open labels match the panel state and clicking “Fechar transcrição” calls `chrome.sidePanel.close({windowId})` when available.
- [x] Open/close tracking feature-detects Chrome lifecycle APIs and uses the side-panel page-state fallback without raising errors.
- [x] On versions without a close API, the popup explains the native Chrome panel-close action.
- [x] The side panel no longer shows the upper “Louro ao vivo [session id]” bar; compact status/count/duration remain in the lower stats area.
- [x] `node --check` succeeds for changed JavaScript and the phase Build gate passes.

**Tests**: none (not authorized by the current instruction)
**Gate**: Build
**Commit**: `feat(extension): toggle and simplify transcript side panel`

### T12: Render a unified live timeline with speaker colors

**What**: Add the bottom note composer and merge speech, notes, and chat history/live events in the side panel, with stable speaker colors and green reserved for a reliably identified “Você”.
**Where**: `extension/sidepanel.js`
**Supporting files**: `extension/sidepanel.html`, `extension/sidepanel.css`, `extension/meet-dom.js`, `extension/meet-speakers.js`
**Depends on**: T2, T9, T11
**Reuses**: Existing segment renderer, transcript WebSocket, `formatClock`, speaker-event log, and note persistence.
**Requirement**: LMT-05, LMT-06, LMT-07, LMT-14, LMT-15, LMT-16, LMT-17, LMT-19, LMT-20, LMT-21, LMT-22

**Tools**:

- MCP: NONE (local repository only)
- Skill: `tlc-spec-driven`

**Done when**:

- [x] The panel displays history and live speech, notes, and chat in capture-time order; start-visible chat appears first with “já visível ao iniciar”.
- [x] The panel connects before loading history, buffers concurrent events, and deduplicates snapshot/live overlap by stable record key.
- [x] Each named speaker has a stable distinct palette color; “Você” is green only when Meet exposes an explicit local marker, otherwise the shown name or no attribution remains.
- [x] The note composer and mark control remain fixed below the scrolling transcript while capture is active and use T9 for auto-growing text.
- [x] Existing WebSocket transcript and completion events continue to render correctly.
- [x] `node --check` succeeds for changed JavaScript and the phase Build gate passes.

**Tests**: none (not authorized by the current instruction)
**Gate**: Build
**Commit**: `feat(extension): merge chat and color transcript speakers`

### T13: Keep the Meet overlay outside the React-owned toolbar

**What**: Mount the Louro overlay host under the document root and position it from Meet control geometry without repeated reparenting or one-second toolbar writes.
**Where**: `extension/meet-overlay.js`
**Depends on**: T10
**Reuses**: Existing shadow-root button, overlay state, fallback position, and note helper from T9.
**Requirement**: LMT-11, LMT-12, LMT-13

**Tools**:

- MCP: NONE (local repository only)
- Skill: `tlc-spec-driven`

**Done when**:

- [x] The host remains mounted under `document.documentElement` while enabled and is not inserted into Meet's React-managed control row.
- [x] Position updates follow the leave-call control using coalesced mutation/resize observation; state rendering skips unchanged DOM writes.
- [x] The control stays visible at the measured adjacent or floating fallback position and is removed when disabled.
- [x] `node --check extension/meet-overlay.js` and the phase Build gate pass.

**Tests**: none (not authorized by the current instruction)
**Gate**: Quick
**Commit**: `fix(extension): stabilize louro meet overlay placement`

---

## Phase Execution Map

```text
Phase 1 → Phase 2 → Phase 3

Phase 1: T1 -> T2
         T1 -> T3
         T2 -> T4
         T3 -> T4

Phase 2: T5 -> T6
         T2 -> T7
         T6 -> T7
         T8

Phase 3: T9 -> T10
         T11
         T2 -> T12
         T9 -> T12
         T11 -> T12
         T10 -> T13
```

The diagram abbreviates independent tasks within each phase. Task execution remains sequential as listed.

## Task Granularity Check

| Task | Deliverable | Status |
| --- | --- | --- |
| T1 | One persistence model/store component | ✅ Granular |
| T2 | One backend transcript API component | ✅ Granular |
| T3 | One retention decision | ✅ Granular |
| T4 | One finalization/export path | ✅ Granular |
| T5 | One popup preference | ✅ Granular |
| T6 | One Meet DOM collector | ✅ Granular |
| T7 | One extension-to-backend bridge | ✅ Granular |
| T8 | One user-gesture capture path | ✅ Granular |
| T9 | One shared annotation-field helper | ✅ Granular |
| T10 | One annotation behavior integrated across Louro fields | ✅ Cohesive cross-surface component |
| T11 | One transcript-panel lifecycle and chrome component | ✅ Cohesive popup/panel component |
| T12 | One unified transcript renderer | ✅ Cohesive panel component |
| T13 | One overlay placement controller | ✅ Granular |

## Diagram-Definition Cross-Check

| Task | Depends On | Diagram Shows | Status |
| --- | --- | --- | --- |
| T1 | None | No incoming edge | ✅ Match |
| T2 | T1 | T1 → T2 | ✅ Match |
| T3 | T1 | T1 → T3 | ✅ Match |
| T4 | T2, T3 | T2 -> T4; T3 -> T4 | ✅ Match |
| T5 | None | No incoming edge | ✅ Match |
| T6 | T5 | T5 -> T6 | ✅ Match |
| T7 | T2, T6 | T2 -> T7; T6 -> T7 | ✅ Match |
| T8 | None | No incoming edge | ✅ Match |
| T9 | None | No incoming edge | ✅ Match |
| T10 | T9 | T9 -> T10 | ✅ Match |
| T11 | None | No incoming edge | ✅ Match |
| T12 | T2, T9, T11 | T2 -> T12; T9 -> T12; T11 -> T12 | ✅ Match |
| T13 | T10 | T10 -> T13 | ✅ Match |

## Test Co-location Validation

| Task | Code Layer | Matrix Requires | Task Says | Status |
| --- | --- | --- | --- | --- |
| T1 | Backend model/store | none | none | ✅ Matches current instruction |
| T2 | Backend API | none | none | ✅ Matches current instruction |
| T3 | Backend retention | none | none | ✅ Matches current instruction |
| T4 | Backend export/lifecycle | none | none | ✅ Matches current instruction |
| T5 | Extension preference UI | none | none | ✅ Matches current instruction |
| T6 | Meet content script | none | none | ✅ Matches current instruction |
| T7 | Extension background bridge | none | none | ✅ Matches current instruction |
| T8 | Extension capture lifecycle | none | none | ✅ Matches current instruction |
| T9 | Extension UI helper | none | none | ✅ Matches current instruction |
| T10 | Extension annotation UI | none | none | ✅ Matches current instruction |
| T11 | Extension panel lifecycle/UI | none | none | ✅ Matches current instruction |
| T12 | Extension timeline rendering | none | none | ✅ Matches current instruction |
| T13 | Extension overlay controller | none | none | ✅ Matches current instruction |

**Gate note**: These are plan validations, not a claim that behavior has been verified. The test suite is not part of the authorized gates unless the user explicitly asks for tests or verification.
