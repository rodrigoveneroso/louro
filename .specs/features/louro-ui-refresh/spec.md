# Louro UI Refresh Specification

## Problem Statement

The popup, side panel, and Meet control use separate visual treatments, and the popup gives persistent settings the same prominence as capture actions. The refresh gives Louro a coherent forest-inspired identity and makes each surface fit its main task while preserving the existing capture behavior.

## Goals

- [ ] Give the popup, side panel, and Meet control a shared Louro color and component language.
- [ ] Make capture actions immediate in the popup and keep preferences discoverable but secondary.
- [ ] Make the side panel comfortable for following and reviewing a long live transcript.
- [ ] Keep the extension lightweight and preserve keyboard access, visible focus, and non-color state cues.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Changes to audio, chat, or transcript capture behavior | This work refreshes presentation and navigation only. |
| New search, filtering, export, or account features | These are separate product capabilities. |
| A new UI framework or component dependency | The existing extension uses native HTML, CSS, and JavaScript. |
| A separate light theme | The approved direction is dark-first; theme switching can be discussed later. |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Theme | Dark forest palette is the first and only theme in this change. | It matches the current dark Meet environment and the Louro artwork. | Yes |
| Popup preferences | Place capture, Meet overlay, and chat options inside a collapsed native disclosure. | The popup is a quick-action surface and closes when focus leaves it. | Yes |
| Transcript follow behavior | Preserve auto-follow only while the reader is near the bottom; show a return-to-live control when they scroll away. | This protects reading position while keeping live content reachable. | Yes |
| Mascot placement | Keep the small head mark in compact controls; use the full-body mark only in a larger empty state and existing large logo contexts. | Fine detail is more legible at larger sizes. | Yes |
| Capture and storage semantics | Preserve all current defaults, permissions, and data handling. | The request is a UI/UX refresh. | Yes |

**Open questions:** none for this implementation.

## User Stories

### P1: Quick capture controls

**User Story**: As a meeting participant, I want the popup to show the current capture state and the action that applies now so I can control Louro without scanning settings.

**Why P1**: Starting and stopping capture are the primary extension actions.

**Acceptance Criteria**:

1. WHEN the popup opens THEN it SHALL show the current capture state and duration when a capture is active.
2. WHEN capture is inactive THEN the popup SHALL show the start action as its primary action.
3. WHILE capture is active the popup SHALL show the stop action, moment marker, and note composer before preferences.
4. WHEN the popup opens THEN capture preferences SHALL appear in a collapsed, keyboard-operable disclosure.
5. The system SHALL preserve all existing preference values and capture actions.

**Independent Test**: Open the popup before and during a capture and inspect the primary actions, notes, and disclosure.

### P1: Live transcript workspace

**User Story**: As a meeting participant, I want the side panel to prioritize the meeting timeline and keep notes available so I can follow the conversation without losing my place.

**Why P1**: The side panel is the primary reading surface during a meeting.

**Acceptance Criteria**:

1. WHILE the side panel is open the system SHALL show Louro identity and connection or capture state in a compact header.
2. WHILE a capture is active the system SHALL keep the transcript timeline scrollable and the note composer fixed at the bottom.
3. IF the reader is away from the bottom when a new timeline item arrives THEN the system SHALL preserve the reader's position and show a return-to-live control.
4. WHEN the reader activates the return-to-live control THEN the system SHALL scroll to the latest item and hide that control.
5. WHEN the timeline contains speech, chat, or notes THEN the system SHALL distinguish each item type with a text label or equivalent non-color cue.

**Independent Test**: Open a live transcript, scroll upward, receive a new item, then activate the return-to-live control.

### P1: Louro visual identity and accessible states

**User Story**: As a Louro user, I want the extension surfaces to share a recognizable palette and clear state cues so I can understand the UI at a glance.

**Why P1**: A consistent identity makes the extension feel like one product across Chrome, the transcript panel, and Meet.

**Acceptance Criteria**:

1. The system SHALL use shared semantic tokens for dark surfaces, text, Louro green, annotation yellow, recording or error coral, and outlines across extension pages.
2. WHILE the Meet control is visible the system SHALL use the Louro palette while preserving the existing compact placement and capture-state behavior.
3. The system SHALL communicate capture and connection state with text or shape in addition to color.
4. The system SHALL provide visible keyboard focus and honor reduced-motion preferences for decorative transitions.

**Independent Test**: Inspect popup, side panel, and Meet control in idle, active, and keyboard-focused states.

## Edge Cases

- IF the panel is empty THEN the system SHALL show concise guidance with the larger Louro mascot.
- IF the reader scrolls back to the bottom before activating return-to-live THEN the system SHALL hide the return control.
- IF reduced motion is enabled THEN the system SHALL suppress decorative entry and pulse animations.

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| UX-01 | P1: Quick capture controls | Execute | Implemented |
| UX-02 | P1: Live transcript workspace | Execute | Implemented |
| UX-03 | P1: Louro visual identity and accessible states | Execute | Implemented |

**ID format:** `UX-NN`.

**Coverage:** 3 requirements, 3 mapped to implementation steps, 0 unmapped.

## Success Criteria

- [x] Capture actions remain visible before settings in the popup.
- [x] All three surfaces use the same semantic colors and typography rhythm.
- [x] A reader can leave the live edge and return without losing their scroll position.
- [x] No capture or persistence behavior changes.
