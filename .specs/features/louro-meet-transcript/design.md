# Louro Meet Transcript Improvements Design

**Spec**: `.specs/features/louro-meet-transcript/spec.md`
**Status**: Approved; implementation complete, runtime verification pending

---

## Architecture Overview

Keep the current audio, segment, and note flows. Add a local chat-capture path from Meet's rendered DOM to a dedicated SQLite table, then merge segments, notes, and chat into one ordered side-panel/export timeline. Separate the Meet overlay's visual host from Meet's React-owned toolbar and keep its state updates independent from its position updates.

```mermaid
sequenceDiagram
    participant User
    participant Meet as Meet content scripts
    participant SW as Extension service worker
    participant Offscreen
    participant API as Local FastAPI backend
    participant DB as SQLite
    participant Panel as Side panel

    User->>Meet: Clicks “Participar agora”
    Meet->>SW: meet_join_clicked (only if follow-call is enabled)
    SW->>SW: Request tab stream ID immediately; dedupe in-flight capture
    SW->>Offscreen: Start existing audio recorder
    Offscreen->>API: Open existing audio WebSocket
    SW->>Meet: Start chat observer for session (if opt-in)
    Meet->>SW: Send visible-start snapshot and later rendered messages
    SW->>API: POST chat-message batch
    API->>DB: Insert idempotently into chat_messages
    API-->>Panel: WebSocket chat/note/segment events
    Panel->>API: GET unified transcript history
    API->>DB: Read segments, notes, and chat_messages
    User->>Panel: Add note / mark moment
    Panel->>SW: add_note
    SW->>API: POST note
    API->>DB: Store note and broadcast it
    API->>DB: At stop, retain/export the merged timeline
```

The `meet_join_clicked` path is an attempt to use the click on Meet's immediate join action as the user gesture. Chrome still requires a user gesture for `tabCapture`; its API documentation does not guarantee that a gesture survives this content-script-to-service-worker message path. A Chrome Extensions DevRel response identifies a click handler in a content script as a valid gesture source, but also emphasizes calling capture synchronously. Therefore this path must call `getMediaStreamId` before any awaited work in the service-worker message handler, and a rejected attempt must keep the visible manual-start fallback. A truly gesture-free start is not supported. See [Chrome tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture), [Chrome screen-capture guide](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture), and the [Chromium Extensions DevRel response](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/WK1ZV-BJDxY).

---

## Code Reuse Analysis

### Existing Components to Leverage

| Component | Location | How to Use |
| --- | --- | --- |
| Offscreen audio recorder and stream setup | `extension/background.js`, `extension/offscreen.js` | Keep the existing `tabCapture` → offscreen → audio-WebSocket pipeline; allow it to accept a stream-ID promise obtained from the Meet join gesture. |
| Follow-call preference and call-state tracking | `extension/background.js`, `extension/meet-call.js`, `extension/popup.js` | Reuse `autoCapture`; stop starting on a polled `inCall=true` transition and use it only to track/stop. Attempt start on an explicit immediate-join click. |
| Meet DOM readers and participant log | `extension/meet-dom.js`, `extension/meet-speakers.js` | Extend the existing content-script helpers and manifest ordering for join labels, visible chat, and explicit self markers. Do not infer local identity from a participant name alone. |
| Overlay state and note service | `extension/meet-overlay.js`, `extension/overlay-state.js`, `extension/background.js` | Preserve current presentation states and `add_note`; move only the overlay host/positioning behavior and make the note control multiline. |
| Session store and API | `backend/store.py`, `backend/app.py`, `backend/models.py` | Add a chat model/table and chat endpoint; extend transcript history and current WebSocket event channel. Keep `segments` and `notes` tables intact. |
| Existing markdown exporter | `backend/exporter.py` | Preserve session metadata, speaker attribution, and note formatting while merging chat records into the transcript timeline. |
| Popup and side-panel state | `extension/popup.js`, `extension/sidepanel.js` | Reuse existing open/start/stop, note, history, and WebSocket flows; add panel-state tracking and a unified timeline renderer. |

### Integration Points

| System | Integration Method |
| --- | --- |
| Meet page → service worker | Runtime messages from content scripts, scoped to the sender's Meet tab. Chat collection runs only for an active capture and the opt-in setting. |
| Service worker → local API | Local HTTP POST for bounded batches of chat messages; existing extension host permission and backend origin checks apply. |
| Backend → side panel | Existing transcript WebSocket gains `chat` and `note` event types; existing `transcript` and `complete` event shapes remain supported. |
| Side-panel history | Existing transcript endpoint adds `chat_messages` and `notes` fields without removing its current segment fields. Connect first, buffer live events while loading the snapshot, and merge by stable item ID to avoid missing or duplicating events during the fetch. |
| SQLite → export | Add `chat_messages`; query it with existing segments and notes at session completion and in `export_all`. |

---

## Components

### Meet Join Gesture and Capture Coordinator

- **Purpose**: Start follow-call capture from a clear immediate-join gesture and prevent duplicate starts.
- **Location**: `extension/meet-call.js`, `extension/background.js`, `extension/popup.js`, `extension/_locales/pt_BR/messages.json`.
- **Interfaces**:
  - `meet_join_clicked` runtime message — sender tab identifies the Meet tab; sent only when the content script's cached `autoCapture` setting is enabled and the clicked control is a recognized “Participar agora” / “Join now” action.
  - `startCapture(tabId, { streamId })` — reuses the current offscreen/audio flow after acquiring the stream ID.
  - `call_state` — continues to record call state and stop an active capture after leaving; `inCall=true` alone no longer starts a capture.
- **Dependencies**: `chrome.tabCapture`, `chrome.storage`, current offscreen document.
- **Reuses**: `startCapture`, `onCallState`, `setReminder`, `showRecording`, and `autoCapture`.
- **Gesture constraint**: The service-worker message handler must initiate `chrome.tabCapture.getMediaStreamId({targetTabId})` immediately, before storage reads, tab queries, or other awaited work. Check active/in-flight capture immediately afterward; if Chrome rejects it, set the existing badge reminder and expose the manual Louro/popup start path. A click labeled “Solicitar para participar” / “Ask to join” is not an immediate-join trigger.

### Meet Chat Collector

- **Purpose**: Read only chat message content rendered in the current Meet page during an opted-in active capture.
- **Location**: New `extension/meet-chat.js`, loaded from `extension/manifest.json`; message handling in `extension/background.js`.
- **Interfaces**:
  - `chat_capture_start(sessionId)` — begin observing and snapshot message cards visibly rendered in an open Meet chat pane.
  - `chat_capture_stop(sessionId)` — stop observing when the session stops or the tab changes session.
  - `chat_messages` — bounded batch carrying `client_id`, `author`, `text`, `observed_at_ms`, and `historical` for each entry.
- **Dependencies**: Meet DOM, `chrome.storage`, `chrome.runtime`, active session ID.
- **Reuses**: Existing content-script isolation, manifest host match, background local-API helper pattern.
- **Behavior**: The opt-in setting `includeMeetChat` defaults to false. The collector observes only while a capture is active and the setting is on. It does not open the chat pane or query hidden/unrendered history. If the pane is closed at capture start, the collector waits for messages to render later. Turning the setting off stops collection immediately; turning it on mid-capture starts with later observations and does not relabel the newly visible DOM as history from capture start.
- **Duplicate handling**: Prefer a stable message identifier exposed by the rendered DOM; otherwise combine any visible original timestamp with normalized author/text and remember observed nodes for the session. Keep a session-scoped client ID so API retries are idempotent. Identical messages with no stable DOM ID or visible time remain an ambiguity; see Risks & Concerns.

### Chat API and SQLite Store

- **Purpose**: Validate, persist, deduplicate, retrieve, and broadcast chat messages without changing existing speech or note storage.
- **Location**: `backend/models.py`, `backend/store.py`, `backend/app.py`.
- **Interfaces**:
  - `POST /api/sessions/{session_id}/chat-messages` — accept a bounded array of messages for an active session; return inserted rows and ignore duplicate `(session_id, client_id)` keys.
  - `GET /api/sessions/{session_id}/transcript` — retain `segments`, `full_text`, and `segment_count`; add `chat_messages` and `notes` with IDs for timeline deduplication.
  - WebSocket events `{"type":"chat","messages":[...]}` and `{"type":"note","note":...}` — broadcast only persisted records.
  - `SessionStore.add_chat_messages`, `load_chat_messages`, and `load_timeline_notes` — use the existing connection lock; the notes read can expose row IDs without changing the `notes` schema or model.
- **Dependencies**: Existing session lifecycle, FastAPI security middleware, SQLite store lock, transcript subscribers.
- **Reuses**: `Session`, `Note`, `_MAX_NOTE`, `store.add_note`, `_broadcast_segments`, and the existing local API security checks.

### Unified Timeline and Annotation UI

- **Purpose**: Render speech, notes, and chat in capture-time order with useful author colors and a fixed bottom composer.
- **Location**: `extension/sidepanel.html`, `extension/sidepanel.js`, `extension/sidepanel.css`, `extension/popup.html`, `extension/popup.js`, `extension/popup.css`, `extension/meet-overlay.js`, and a small shared `extension/note-input.js` helper.
- **Interfaces**:
  - Timeline item: `{id, kind, at_sec, historical, author/speaker, text, start_sec?, end_sec?}`.
  - `note-input.js` binds auto-height/overflow behavior to popup, Meet overlay, and side-panel textareas; view-specific handlers retain Enter-to-save and Shift+Enter line breaks.
  - The popup requests and displays the current panel-open state; the service worker records it per window from Chrome lifecycle events when available plus side-panel page messages. Use `sidePanel.close({windowId})` when present; where unavailable, show a brief instruction to use Chrome's native panel-close control.
- **Dependencies**: Existing i18n, side-panel API, panel and background runtime messages.
- **Reuses**: Existing panel transcript, duration, segment count, note service, and `formatClock`.
- **Rendering rules**: Remove the side panel's top logo/status/session-ID header. Keep compact connection state and duration/count in the lower stats area. Place the note composer and mark action at the bottom of the panel while capture is active. History chat entries (`historical=true`) render first, preserving their DOM order and showing “já visível ao iniciar”; later messages use the capture-relative time. Named speakers receive a stable palette color; “Você” uses green only when an explicit Meet self marker is detected. A deterministic hash-to-palette mapping keeps a speaker's color stable across live updates and history.
- **Timeline order**: Historical chat sorts before other zero-time entries. Remaining entries sort by capture-relative time; ties use a deterministic type priority and stable per-record ID/order.

### Stable Meet Overlay Host

- **Purpose**: Keep the Louro control outside Meet's React-managed toolbar while visually aligning it beside the Meet controls.
- **Location**: `extension/meet-overlay.js`.
- **Interfaces**: Existing shadow-root button/panel and storage-driven overlay state remain unchanged; a positioning controller updates host coordinates independently.
- **Dependencies**: Meet leave-call control rectangle, resize/mutation observers, animation-frame scheduling.
- **Reuses**: Existing button states, shadow DOM, translation keys, note behavior, and floating fallback.
- **Behavior**: Mount the host under `document.documentElement` once; position it using the leave-call button's viewport rectangle. A `ResizeObserver` and a filtered/coalesced `MutationObserver` recalculate position as the toolbar moves. State rendering does not reparent the host and skips DOM writes when values did not change. The floating corner remains the fallback if the toolbar cannot be located.

---

## Data Models

### ChatMessage

```text
ChatMessage {
  id: integer              # SQLite row ID; stable timeline/history ID
  session_id: string
  client_id: string        # unique per session; makes retries idempotent
  author: string           # rendered author or neutral unknown-author label
  text: string             # rendered message text, stored as plain text
  at_sec: number           # capture-relative; 0 for the start snapshot
  historical: boolean      # true only for messages visible at capture start
}
```

SQLite adds `chat_messages` with `UNIQUE(session_id, client_id)` and an index on `(session_id, at_sec, id)`. The existing `segments` and `notes` table schemas remain as they are. Snapshot insertion order is retained by the row ID, since those entries intentionally share `at_sec = 0`.

### TimelineItem (API/UI projection)

```text
TimelineItem {
  id: string               # segment key, note row ID, or chat row ID
  kind: "segment" | "note" | "chat"
  at_sec: number
  historical?: boolean
  speaker?: string
  author?: string
  text: string
  start_sec?: number
  end_sec?: number
}
```

This is a read/render projection only. Speech segments and notes retain their existing persistence models.

---

## Error Handling Strategy

| Error Scenario | Handling | User Impact |
| --- | --- | --- |
| Chrome rejects capture on the Meet join gesture | Do not set recording state; set the manual-start badge/reminder and keep popup/Meet start controls available. | Clear indication that recording did not start. |
| Follow-call is disabled or the click is “Ask to join” | Do not request a stream ID. | Join proceeds normally without capture. |
| A capture is active or starting for another tab | Return the current “already capturing” state and avoid a second offscreen recorder. | Existing capture continues; no second session is claimed. |
| The chat endpoint is reached before the backend session exists | Retry a bounded number of times while the same capture remains active; drop with a compact local warning if the backend stays unavailable. | Speech capture continues; chat loss is not represented as saved. |
| Malformed or oversized chat payload | Reject the batch with HTTP 400; persist and broadcast no invalid rows. | Valid audio and prior messages remain. |
| Meet chat markup changes or author cannot be read | Scan visible message containers conservatively; preserve text with a neutral unknown-author label, and ignore nodes that cannot be safely identified as messages. | Some messages may be missed if Meet changes its UI. |
| Side-panel close API/event is unavailable | Feature-detect APIs; use panel page state messages; on unsupported close, show the native Chrome close affordance hint and avoid throwing. | Opening still works; closing may require Chrome's built-in control. |
| Note save fails | Keep current note feedback near the composer and retain the text for retry. | User can retry without retyping. |

---

## Risks & Concerns

| Concern | Location (file:line) | Impact | Mitigation |
| --- | --- | --- | --- |
| Overlay is moved into Meet's toolbar every render and render runs on a one-second interval. | `extension/meet-overlay.js:19-280` | Meet's React reconciliation can remove or reset the injected host, causing flicker and toolbar instability. | Keep the host under `document.documentElement`; make state rendering idempotent; position from observed geometry on resize/mutation only. |
| Follow-call currently attempts `tabCapture` from a polled call-state transition, while `startCapture` awaits storage/tab lookups before asking for a stream ID. | `extension/background.js:51-75`, `107-126`; `extension/meet-call.js:28-43` | No valid user gesture may remain when Chrome checks the call; automatic capture may be rejected. | Use the direct Meet join click as the only automatic start trigger and acquire the stream ID before asynchronous preparation. Keep the popup/manual route. Chrome's message-relay gesture propagation remains an implementation uncertainty and must not be presented as guaranteed. |
| Meet's chat DOM and self-participant labels are undocumented and can change. | `extension/meet-dom.js:41-58`; new `extension/meet-chat.js` | Chat parsing may miss messages; incorrect self detection could misattribute a speaker. | Use visible ARIA/text and structural fallbacks, avoid hidden-history APIs, and only show “Você” for explicit markers. Keep selectors isolated in one content script. |
| Chat duplicate identity may be ambiguous if a message has no stable DOM ID or visible original time. | New `extension/meet-chat.js`; `backend/store.py` | A rerender may duplicate a message, or a repeated identical message may be collapsed. | Prefer stable DOM IDs and visible timestamps, track message-node identities, and use a unique client ID plus SQLite uniqueness for retry safety. Record the remaining ambiguity in implementation notes. |
| Current retention drops any session with no speech even when it has met the minimum duration. | `backend/retention.py:29-40`; `backend/app.py:408-428` | A chat-only meeting could be deleted before it is exported, contradicting local chat persistence. | Treat chat as session content for the existing minimum-duration retention decision; preserve the 30-second minimum and the current setting that disables it at zero. |
| The side panel fetches history before opening its WebSocket. | `extension/sidepanel.js:93-120` | A segment/chat/note arriving during the history request can be missed; connecting first can create duplicates. | Connect and buffer live events first, load the snapshot, then merge using stable record IDs/segment keys. |
| `export_session` and `export_all` require speech segments today. | `backend/exporter.py:52-64`, `108-121` | Chat-only kept sessions would be absent from a markdown export. | Permit chat-only export and merge chat, notes, and speech by timestamp while preserving current metadata and attribution. |

---

## Tech Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Chat persistence | Add a dedicated `chat_messages` SQLite table. | User chose a separate table; it keeps existing speech segments and notes untouched and allows dedupe/indexing. |
| Chat capture default | Local opt-in, off by default. | Avoids storing meeting chat unless the user chooses it. |
| Visible history timestamp | Store start snapshot messages at `at_sec = 0` with `historical = true`; preserve DOM order and label them “já visível ao iniciar”. | Meet's rendered DOM may not expose original send times reliably. |
| Chat-only session retention | Count chat as session content when applying the existing minimum-duration retention rule. | Otherwise a retained chat transcript could be deleted solely because no speech was recognized. |
| Transcript rendering | One merged timeline for speech, chat, and notes in live and markdown output. | Lets the reader follow spoken and written meeting context in one capture-relative sequence. |
| Self label | Label “Você” only from an explicit local-participant marker. | Participant names alone do not reliably identify the local user. |
| Panel API compatibility | Feature-detect `sidePanel.close`, `onOpened`, and `onClosed`; do not raise the minimum Chrome version. | The APIs have different Chrome availability: `close` and `onOpened` start at Chrome 141; `onClosed` starts at Chrome 142. Keep a graceful native-close fallback. [Chrome sidePanel reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel). |
| Overlay position | Fixed host mounted under the document root; compute visual position from the Meet control geometry. | Meet's toolbar is React-managed and should not own the Louro node. |

---

## Implementation Boundaries

- No remote storage, chat API, or third-party backend is introduced; messages remain in the local Louro database and export directory.
- No automatic opening of Meet chat and no capture from messages not rendered in the current DOM.
- No start attempt from a background call-state change; only a user gesture can request tab capture.
- Existing transcript fields, speech storage, and notes storage remain backward-compatible.
- No project-wide Chrome minimum-version change.
