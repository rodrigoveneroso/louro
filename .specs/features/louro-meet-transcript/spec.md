# Louro Meet Transcript Improvements Specification

**Implementation status**: Native toolbar integration implemented; syntax and diff checks pass. Live verification is pending because the inspected Chrome tab currently has three Louro runtime instances, and Chrome's extension-management page is unavailable to browser automation.

## Problem Statement

The live transcript panel is difficult to use for notes, displays redundant session chrome, and does not distinguish speakers or include meeting chat. The Louro control in Meet can flicker because it is repeatedly inserted into Meet's React-managed toolbar. Automatic capture also still depends on opening the extension popup once for each Meet tab.

## Goals

- [x] Make the transcript panel a clear, toggleable view with note entry at its bottom.
- [x] Keep annotation text readable while typing, and show speakers with distinct colors.
- [x] Keep the Louro control stable during Meet toolbar updates.
- [x] Offer optional local capture of rendered chat messages, including the visible history at capture start.
- [x] Start capture from the user's natural Meet join action when automatic follow-call is enabled, without requiring a click on the Chrome extension icon.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Capture with no user action at all | Chrome requires a user gesture to start tab capture. |
| Reading chat content that Meet has not rendered | The extension reads the Meet page's visible UI; it does not query an official chat history API. |
| Automatically opening Meet's chat pane | This would change the user's meeting UI. |
| Support for meeting products other than Google Meet | The existing content scripts target Meet only. |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| How to time chat history already visible at capture start | Show the snapshot at the beginning of the transcript with the label “já visível ao iniciar”; do not claim an original message time | The exact original time may not be exposed by Meet's rendered message element | Yes |
| Chat collection preference | Add a local opt-in setting, off by default; do not open Meet chat automatically | The user asked for an option, and chat text can contain sensitive meeting content | Yes |
| Chat collection scope | Include messages rendered when capture starts and later messages as Meet renders them; do not request hidden history | The user selected visible history, and the extension has no official chat-history API | Yes |
| Automatic capture preference | Reuse the existing “Iniciar e parar junto com a chamada” setting; when on, attempt capture on the user's Meet join action | Preserves the existing opt-in and avoids requiring an extension-icon click per tab | Yes |
| Chrome capture policy | A completely gesture-free start is out of scope; if Meet's join click is not accepted as the gesture, show the existing manual-start reminder and allow a Louro control in Meet to retry | Chrome documents a user-gesture requirement for `tabCapture`; a Chrome Extensions DevRel response identifies a content-script click handler as a valid gesture source | Yes |
| Annotation input behavior | Use a multiline field that grows to 8 lines, then scrolls; Enter saves and Shift+Enter inserts a newline; keep the existing 1000-character limit | This makes longer notes readable while retaining current backend limits and Enter behavior | Yes |
| Speaker identity | Use a green “Você” label only when Meet explicitly exposes a reliable self marker; otherwise keep the available name or no speaker attribution | Avoids assigning another participant's voice to the local user | Yes |
| Speaker colors | Assign each speaker a stable, distinct color within the live transcript; reserve green for “Você” | Matches the requested WhatsApp-like scanability | Yes |
| Chrome side-panel API | Use the close/open state APIs when available; do not raise the extension's minimum Chrome version in this change | `sidePanel.close` and panel lifecycle events are only available in newer Chrome versions | Yes |

**Open questions:** none - all remaining choices are recorded above.

## User Stories

### P1: Toggle and use the transcript panel ⭐ MVP

**User Story**: As a meeting participant, I want to open and close the transcript from the extension and add notes from the transcript panel so that I can follow the meeting without redundant chrome.

**Why P1**: This is the primary transcript reading and annotation flow.

**Acceptance Criteria**:

1. WHEN the extension popup opens while the Louro transcript panel is open THEN the transcript toggle SHALL display “Fechar transcrição” (LMT-01).
2. WHEN the user clicks “Fechar transcrição” on a Chrome version that supports `sidePanel.close` THEN the system SHALL close the Louro transcript panel (LMT-02).
3. WHEN the extension popup opens while the transcript panel is closed THEN the transcript toggle SHALL display “Ver transcrição completa” (LMT-03).
4. WHILE the transcript panel is visible, the system SHALL omit the top bar that contains “Louro ao vivo” and the session identifier (LMT-04).
5. WHILE a capture is active, the transcript panel SHALL show a note composer at its bottom with controls to save a note and mark the current moment (LMT-05).
6. WHEN the user presses Enter in an annotation field containing non-whitespace text THEN the system SHALL save that note to the active session (LMT-06).
7. WHEN the user presses Shift+Enter in an annotation field THEN the system SHALL insert a line break without saving the note (LMT-07).

**Independent Test**: Open the transcript from the popup, reopen the popup, close the transcript, and save a multiline note from the panel.

### P1: Keep annotations readable ⭐ MVP

**User Story**: As a meeting participant, I want the annotation field to grow and wrap long text so that I can read what I am writing.

**Why P1**: A field that only shows the end of a long note makes annotation unreliable.

**Acceptance Criteria**:

1. WHILE annotation text is entered, the system SHALL wrap it and grow the field up to 8 visible lines (LMT-08).
2. IF annotation text exceeds 8 visible lines THEN the system SHALL keep the remaining text reachable by vertical scrolling (LMT-09).
3. The system SHALL retain the existing maximum annotation length of 1000 characters (LMT-10).

**Independent Test**: Type a long, multiline note in the popup, the Meet overlay, and the transcript panel; verify wrapped earlier text remains visible and overflow can be scrolled.

### P1: Keep the Meet control stable ⭐ MVP

**User Story**: As a meeting participant, I want the Louro control to remain stable beside Meet's controls so that it does not flicker or revert Meet's toolbar.

**Why P1**: The current flicker makes the control distracting and unreliable during a meeting.

**Acceptance Criteria**:

1. WHILE the call is active and the Louro overlay is enabled, Meet toolbar re-renders SHALL NOT repeatedly remove and reinsert the Louro control (LMT-11).
2. WHILE the call is active and the Louro overlay is enabled, the Louro control SHALL occupy its own layout slot inside Meet's native call-controls row and SHALL NOT cover or sit outside the row's controls (LMT-12).
3. WHEN the user disables the Louro overlay THEN the system SHALL remove the Louro control from the Meet page (LMT-13).

**Independent Test**: Keep the Louro overlay enabled in a live Meet call while Meet's toolbar changes state; verify the control does not blink, jump, or cause the toolbar to revert.

### P1: Identify speakers by color ⭐ MVP

**User Story**: As a transcript reader, I want each speaker to have a consistent color so that I can scan who said what.

**Why P1**: Speaker identity is currently visually uniform.

**Acceptance Criteria**:

1. WHEN a transcript segment has a speaker name THEN the system SHALL render the speaker with a stable speaker-specific color throughout that transcript (LMT-14).
2. WHEN Meet explicitly identifies the local participant THEN the system SHALL label that participant “Você” and render that label in green (LMT-15).
3. IF Meet does not expose a reliable local-participant marker THEN the system SHALL preserve the available speaker name or leave attribution empty rather than label a different participant “Você” (LMT-16).

**Independent Test**: View transcript segments from at least three participants, including the local participant when Meet exposes it, and compare labels and colors.

### P1: Include optional Meet chat messages ⭐ MVP

**User Story**: As a meeting participant, I want to include meeting chat messages in my transcript when I choose so that decisions shared in chat stay with the meeting record.

**Why P1**: Chat can contain important meeting context that speech transcription misses.

**Acceptance Criteria**:

1. WHERE chat inclusion is enabled, the system SHALL capture the chat messages rendered by Meet when the capture starts and the rendered messages that appear afterward (LMT-17).
2. WHERE chat inclusion is disabled, the system SHALL not store or export chat messages (LMT-18).
3. WHEN a message was already visible when capture started THEN the system SHALL show it at the beginning of the transcript with the label “já visível ao iniciar” (LMT-19).
4. WHEN a new chat message is rendered during capture THEN the system SHALL include its displayed author, text, and capture-relative time in the live transcript and exported transcript (LMT-20).
5. WHEN a visible message is observed repeatedly because Meet updates its DOM THEN the system SHALL include it only once (LMT-21).
6. The system SHALL keep chat messages in the local Louro database and local transcript export (LMT-22).
7. The system SHALL NOT open the Meet chat pane automatically (LMT-23).

**Independent Test**: Enable chat inclusion, start capture with visible chat history, send a new message, and verify the history label, author, message, and time appear once in both live and completed transcripts; repeat with the option disabled.

### P1: Start follow-call capture from Meet ⭐ MVP

**User Story**: As a meeting participant, I want follow-call recording to start from my normal Meet join action so that I do not need to open the Chrome extension popup for each meeting tab.

**Why P1**: The current auto-capture option only works after an extension-popup click has invoked capture for that tab.

**Acceptance Criteria**:

1. WHERE “Iniciar e parar junto com a chamada” is enabled, WHEN the user clicks Meet's join-now action THEN the system SHALL attempt to start tab capture from that user gesture (LMT-24).
2. WHERE follow-call is enabled, WHEN capture has started before Meet reports the call active THEN the system SHALL keep that capture associated with the same Meet tab and avoid starting a duplicate capture (LMT-25).
3. IF Chrome rejects the capture attempt THEN the system SHALL show a visible manual-start reminder and SHALL NOT claim that capture started (LMT-26).
4. IF follow-call is disabled THEN clicking a Meet join action SHALL NOT start capture (LMT-27).
5. The system SHALL NOT attempt to start tab capture without a user gesture (LMT-28).

**Independent Test**: Enable follow-call, join a Meet call without clicking the extension icon, and verify the recording state; repeat with follow-call disabled and with capture permission rejected.

## Edge Cases

- IF the chat pane is closed when capture starts THEN the system SHALL not open it automatically and SHALL begin collecting rendered chat messages if they later appear (LMT-29).
- IF Meet exposes a message without a readable author THEN the system SHALL preserve the message text with a neutral unknown-author label (LMT-30).
- IF the extension is already capturing another tab THEN a Meet join action SHALL not start a second capture (LMT-31).
- IF the Meet join action is a request to be admitted rather than an immediate join THEN the system SHALL not claim a recording is active before capture succeeds; a failed start SHALL use the normal manual-start reminder (LMT-32).
- IF the side-panel close API is unavailable THEN the system SHALL retain its existing native panel-close path and SHALL not throw an extension error (LMT-33).
- IF chat inclusion is disabled while capture is active THEN messages received after the setting changes SHALL not be stored (LMT-34).

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| LMT-01 | P1: Toggle and use transcript panel | P1 | Verified |
| LMT-02 | P1: Toggle and use transcript panel | P1 | Verified |
| LMT-03 | P1: Toggle and use transcript panel | P1 | Verified |
| LMT-04 | P1: Toggle and use transcript panel | P1 | Verified |
| LMT-05 | P1: Toggle and use transcript panel | P1 | Verified |
| LMT-06 | P1: Toggle and use transcript panel | P1 | Verified |
| LMT-07 | P1: Toggle and use transcript panel | P1 | Verified |
| LMT-08 | P1: Keep annotations readable | P1 | Verified |
| LMT-09 | P1: Keep annotations readable | P1 | Verified |
| LMT-10 | P1: Keep annotations readable | P1 | Verified |
| LMT-11 | P1: Keep the Meet control stable | P1 | Implementing |
| LMT-12 | P1: Keep the Meet control stable | P1 | Implementing |
| LMT-13 | P1: Keep the Meet control stable | P1 | Verified |
| LMT-14 | P1: Identify speakers by color | P1 | Verified |
| LMT-15 | P1: Identify speakers by color | P1 | Verified |
| LMT-16 | P1: Identify speakers by color | P1 | Verified |
| LMT-17 | P1: Include optional Meet chat messages | P1 | Verified |
| LMT-18 | P1: Include optional Meet chat messages | P1 | Verified |
| LMT-19 | P1: Include optional Meet chat messages | P1 | Verified |
| LMT-20 | P1: Include optional Meet chat messages | P1 | Verified |
| LMT-21 | P1: Include optional Meet chat messages | P1 | Verified |
| LMT-22 | P1: Include optional Meet chat messages | P1 | Verified |
| LMT-23 | P1: Include optional Meet chat messages | P1 | Verified |
| LMT-24 | P1: Start follow-call capture from Meet | P1 | Verified |
| LMT-25 | P1: Start follow-call capture from Meet | P1 | Verified |
| LMT-26 | P1: Start follow-call capture from Meet | P1 | Verified |
| LMT-27 | P1: Start follow-call capture from Meet | P1 | Verified |
| LMT-28 | P1: Start follow-call capture from Meet | P1 | Verified |
| LMT-29 | P1: Include optional Meet chat messages | P1 | Verified |
| LMT-30 | P1: Include optional Meet chat messages | P1 | Verified |
| LMT-31 | P1: Start follow-call capture from Meet | P1 | Verified |
| LMT-32 | P1: Start follow-call capture from Meet | P1 | Verified |
| LMT-33 | P1: Start follow-call capture from Meet | P1 | Verified |
| LMT-34 | P1: Include optional Meet chat messages | P1 | Verified |

**ID format:** `LMT-[NUMBER]`
**Status values:** Pending → In Design → In Tasks → Implementing → Verified
**Coverage:** 34 total, mapped to T1–T13 in `.specs/features/louro-meet-transcript/tasks.md`.

## Success Criteria

- [ ] Transcript open/close state, lower note composer, and removal of the top status bar work together.
- [ ] The Meet control no longer flickers during an active call with the overlay enabled.
- [ ] Long annotations wrap and remain editable in all three annotation entry points.
- [ ] Speaker labels use stable distinct colors, with green reserved for a reliably identified “Você”.
- [ ] Opt-in chat appears once in the live and exported transcript with a clear start-of-capture marker for visible history.
- [ ] Follow-call capture starts from Meet's join action when Chrome accepts that user gesture, with a clear fallback when it does not.

**Verification note**: These runtime success criteria still need a browser/Meet check. No tests or runtime interaction were run under the approved execution plan.
