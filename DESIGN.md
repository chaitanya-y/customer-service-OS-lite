# Customer Service OS Lite Design System

## Purpose

This document is the visual source of truth for the three browser applications:

- `surfaces/customer-widget`
- `surfaces/operations-console`
- `surfaces/admin-console`

Customer Service OS is a governed platform for building, releasing, operating,
and auditing customer-service agents. The interface must feel calm and human to a
customer, while giving operators and administrators high information density and
clear evidence. It must never look like an ungoverned chatbot demo.

## Design direction

**Direction:** quiet, editorial enterprise software.

**Memorable feeling:** “This is an AI platform I can trust with a real customer
and a real financial decision.”

The direction takes inspiration from Sierra's public product presence: clear
language, confident restraint, human-centered customer experience, and visible
trust. It does **not** copy Sierra's logo, wording, layouts, imagery, or brand
assets. Customer Service OS has its own name, visual tokens, and product voice.

### Principles

1. **Trust is visible.** Show status, source, policy, and human involvement in
   plain language. Do not hide consequential system state behind decorative UI.
2. **Calm before clever.** Use generous whitespace, strong hierarchy, and few
   competing accents. No gradient-heavy “AI” styling.
3. **Evidence is inspectable.** Citations, policy decisions, release versions,
   and audit timelines need readable, structured presentation.
4. **Density follows the role.** Customer screens stay simple; operations and
   administration screens become denser only where it helps decisions.
5. **Theme is a system.** Light and dark mode use semantic tokens, not a
   mechanical inversion of the same colors.

## Brand voice and UI copy

Use precise, calm language.

- Prefer: “Refund ready for your confirmation”, “A specialist is reviewing this
  request”, “Based on the current refund policy”.
- Avoid: “The AI decided”, “Magic”, “Instantly solved”, or unexplained internal
  states such as `PENDING_RECONCILIATION`.
- Translate internal workflow states into customer-safe explanations. Preserve
  raw state identifiers only in operator and admin diagnostic views.

## Theme strategy

The initial selection follows the operating-system preference. Every application
also provides a visible theme control with **Light**, **Dark**, and **System**.
Persist the user choice in their local profile/session. The selected theme must
apply before the app paints, avoiding a bright flash when a dark-mode user opens
the product.

Do not use pure black or pure white as the main canvas. Slightly warm neutrals
make long customer conversations and evidence review easier on the eye.

### Core semantic tokens

Implement tokens as CSS custom properties. Components consume semantic names such
as `--surface-canvas` and `--text-primary`; they never hard-code a palette value.

| Token | Light | Dark | Use |
|---|---:|---:|---|
| `--surface-canvas` | `#F7F6F3` | `#15131A` | application background |
| `--surface-raised` | `#FFFFFF` | `#211E27` | cards, panels, dialogs |
| `--surface-subtle` | `#EFEEE9` | `#2B2731` | selected/secondary areas |
| `--text-primary` | `#242126` | `#F4F1F6` | headings and key values |
| `--text-secondary` | `#665F69` | `#C7C0CA` | supporting text |
| `--border-subtle` | `#DDD8DE` | `#403A46` | dividers and control borders |
| `--accent-primary` | `#5A2A6E` | `#D5A8E6` | primary actions and focus |
| `--accent-strong` | `#421C54` | `#E8C8F1` | hover or emphasis |
| `--accent-soft` | `#F0E6F3` | `#3A2942` | selected row or quiet highlight |

`--accent-primary` is an aubergine, not generic “AI purple.” It is used sparingly:
one primary action per decision surface, links, focus rings, and selected state.

### Semantic status tokens

| Meaning | Light | Dark | Example |
|---|---:|---:|---|
| Success | `#176B4B` | `#71D6A8` | refund completed |
| Warning | `#8A5411` | `#F2C879` | awaiting confirmation |
| Danger | `#A72D35` | `#F19A9F` | request denied or failed |
| Info | `#245E92` | `#8BC8FF` | human review or system update |
| Neutral | `#5F5961` | `#C7C0CA` | draft or informational state |

A status always includes an icon and text. Color alone is never the signal.

## Typography

| Role | Font | Usage |
|---|---|---|
| Product and body | Instrument Sans | customer text, navigation, labels, headings |
| Evidence and data | IBM Plex Mono | identifiers, policy/release versions, amounts in audit views, timestamps |

Use variable-font files or a trusted font CDN during development, then self-host
in the deployed frontend. Numbers in financial amounts and tables must use
tabular figures.

| Level | Size / line-height | Usage |
|---|---|---|
| Display | `36 / 42px` | rare page introduction |
| H1 | `28 / 34px` | page title |
| H2 | `22 / 28px` | major section |
| H3 | `18 / 24px` | card or panel title |
| Body | `15 / 22px` | default reading text |
| Label | `13 / 18px` | controls, metadata |
| Mono metadata | `12 / 18px` | IDs and trace details |

## Layout and spacing

**Base unit:** 4px. **Density:** comfortable for customers, compact-comfortable
for operations and admin views.

```text
2xs  2px     xs   4px     sm   8px     md   16px
lg   24px    xl   32px    2xl  48px    3xl  64px
```

- Customer widget: one reading column, maximum 720px, with a stable composer at
  the bottom.
- Operations console: left navigation, queue column, and case workspace. Collapse
  to a single work area below 1024px.
- Admin console: 12-column desktop grid. Use wide tables and side panels rather
  than forcing complex configuration into modal dialogs.
- Border radius: `6px` controls, `10px` panels, `14px` dialogs. Avoid excessive
  pill-shaped containers; pills are reserved for compact status badges.

## Components and information hierarchy

Build reusable primitives in `@cso/ui` before creating app-specific styling.

Required primitives:

- `Button`, `IconButton`, `TextField`, `Select`, `Textarea`, `Checkbox`;
- `StatusBadge`, `EvidenceChip`, `PolicyDecisionBadge`, `ReleaseBadge`;
- `DataTable`, `EmptyState`, `ErrorState`, `LoadingState`;
- `Timeline`, `AuditEvent`, `Citation`, `ConfirmationCard`;
- `Panel`, `Sheet`, `Dialog`, `Toast`, `Tabs`.

Use a stable hierarchy for consequential actions:

```text
What is happening?
What does it mean for this person?
What evidence or policy supports it?
What action may they take now?
```

For example, a refund confirmation card shows the amount and destination first,
then the policy explanation and cited customer-safe source, then one explicit
“Confirm refund” action. It never exposes internal tool payloads or policy-engine
input hashes to a customer.

## Motion and interaction

**Motion:** minimal and functional.

- 100-160ms for hover and focus;
- 180-240ms for panels, optimistic status changes, and message appearance;
- respect `prefers-reduced-motion` by removing non-essential movement;
- never animate a consequential action as though it has completed before the
  workflow returns authoritative status.

Real-time updates should quietly update a timeline or status region, announce
important changes to assistive technology, and preserve the user's scroll and
form input.

## Accessibility and quality bar

- Meet WCAG 2.2 AA contrast in both themes.
- Every keyboard focus state uses a visible 2px accent outline.
- All decision states have text, icon, and accessible live-region messaging.
- Tables offer responsive detail views rather than horizontal overflow as the only
  mobile experience.
- Use plain-language customer copy. Do not disclose internal-only RAG material.
- Test light, dark, reduced-motion, keyboard-only, and narrow-screen states for
  every core journey.

## Application-specific character

| Surface | Character | Default density |
|---|---|---|
| Customer Widget | reassuring, conversational, plain-language | comfortable |
| Operations Console | decisive, evidence-forward, fast to scan | compact-comfortable |
| Admin Console | deliberate, release-oriented, auditable | compact-comfortable |

The three surfaces share the same visual language. They should not look like
three unrelated products, but the customer widget must not feel like an internal
administration dashboard.

## Implementation rules

1. Define tokens for both themes before building the first page.
2. Use semantic token names in every component. No palette hex values outside the
   token definitions.
3. Keep theme selection in the shared frontend foundation, not per-app CSS.
4. Use the same status vocabulary and release/policy/evidence badges across all
   three applications.
5. Any future visual deviation requires an update to this document.

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-21 | Establish light, dark, and system theme support | Customer and operator work happens across different environments and hours. |
| 2026-08-21 | Adopt quiet editorial enterprise direction | Trust, evidence, and high-stakes operations need clarity more than visual novelty. |
| 2026-08-21 | Use Sierra as an inspiration, not a design source to copy | The product should learn from its clarity and trust posture while keeping an original identity. |
