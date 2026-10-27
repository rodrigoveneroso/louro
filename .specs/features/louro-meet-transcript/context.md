# Louro Meet Transcript Improvements Context

**Gathered:** 2026-10-26
**Spec:** `.specs/features/louro-meet-transcript/spec.md`
**Status:** Ready for design

---

## Feature Boundary

Improve the live Google Meet transcript experience across the extension popup, Meet overlay, side panel, local backend, and exported transcript. The work covers transcript open/close behavior, in-panel notes, readable long annotations, stable speaker colors, an opt-in capture of rendered Meet chat, a stable Meet control, and follow-call capture initiated from the user's Meet join action when Chrome accepts that gesture.

---

## Implementation Decisions

### Chat capture and history

- Chat capture is optional and off by default.
- When enabled, include messages already rendered when capture starts and label those messages “já visível ao iniciar” at the beginning of the transcript; do not imply they were sent at capture time.
- Include later messages as Meet renders them during capture.
- Do not open the Meet chat pane automatically or try to retrieve messages Meet has not rendered.
- Persist chat content locally with the session and include it in both the live transcript and the local export.
- If the message author is unreadable, retain the message with a neutral unknown-author label.

### Starting and stopping capture

- Reuse the existing “Iniciar e parar junto com a chamada” preference as the opt-in for follow-call capture.
- When enabled, attempt capture from the user's “Participar agora” / “Join now” action, so the Chrome extension icon does not need to be clicked for each call.
- Do not treat “Solicitar para participar” / “Ask to join” as an immediate join; if no capture starts, use the existing visible manual-start reminder.
- If Chrome rejects the join action as a capture gesture, show the failure clearly and keep an in-Meet or toolbar manual start path.
- Do not attempt capture from a background call-state change without a user gesture.

### Transcript and annotations

- The popup's transcript control shows “Ver transcrição completa” while closed and “Fechar transcrição” while open.
- Remove the side panel's upper logo/status/session-id bar.
- Put a note composer and moment-mark control at the bottom of the side panel while capture is active.
- Convert note fields in the popup, Meet overlay, and side panel to multiline auto-growing controls. Keep the current 1000-character limit; show up to 8 lines and allow scrolling beyond that. Enter saves; Shift+Enter inserts a newline.
- Keep note feedback brief and near the composer.

### Meet control and speaker display

- Mount the Louro host outside Meet's React-managed control bar and position it relative to the Meet controls; keep state rendering separate from position updates.
- Assign consistent, distinct colors to named speakers in the live transcript. Reserve green for “Você”.
- Label the local speaker “Você” only when the Meet page exposes a reliable self marker; otherwise retain the displayed name or omit attribution.
- Use `sidePanel.close` and lifecycle events where available, without adding a minimum Chrome version. New close APIs require Chrome 141 or newer; older versions retain Chrome's native panel close behavior.

### Agent's Discretion

- The exact accessible palette, panel spacing, and placement offsets, provided they follow the decisions above.
- The local SQLite table and API/WebSocket shape used to persist and display chat entries.
- The exact DOM selectors and duplicate detection used for Meet-rendered chat, with fallbacks for unreadable message metadata.
- Internal event ordering so speech, notes, and chat display by capture-relative time.

---

## Specific References

- “Cores diferentes cada pessoa (como no WhatsApp)” and green for “Você”.
- The side panel should not repeat the “Louro ao vivo [session id]” bar.
- Chat history already visible at capture start should be included at the beginning with the explicit label “já visível ao iniciar”.
- The intended friction reduction is avoiding the extension icon click by using the normal Meet join action as the user gesture.

---

## Declined / Undiscussed Gray Areas → Assumptions

- Chat collection remains opt-in and off by default because it stores meeting text.
- The chat pane stays under the user's control; the extension will not open it.
- Annotation fields keep the current 1000-character bound and Enter-to-save behavior.
- A user gesture remains required by Chrome; no gesture-free or hidden capture is in scope.
- Speaker colors apply in the live transcript; exported Markdown remains plain text with speaker names.

## Deferred Ideas

- Gesture-free capture without clicking any Meet action is not available through Chrome's documented tab-capture flow.
- Retrieving non-rendered or older server-side Meet chat history is outside the extension's current access model.
