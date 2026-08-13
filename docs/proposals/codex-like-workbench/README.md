# Codex-like Workbench visual proposal

This proposal keeps the current VibeHub product model and changes only its
visual and interaction language. It uses Codex as inspiration for density,
quiet surfaces, compact controls, progressive detail, and typographic
discipline; it does not reproduce another product's brand skin.

## Proposed production direction

- Keep the causal Ticket graph as the primary full-bleed canvas. Do not add a
  default navigation or overview rail.
- Use a compact header, a floating overview button, and a right-side Inspector
  that becomes a bottom sheet at narrow widths.
- Give every operational state a restrained whole-card surface. Keep the state
  readable through an icon and uppercase label even without color.
- Render human attention as a separate top-right badge and side notch. It never
  overwrites the operational state or turns future human authority into a
  blocker.
- Keep hover and selection neutral. A selected Ticket retains its state surface
  and gains a dark outline; its complete upstream/downstream causal cone stays
  visible while unrelated graph content recedes.
- Preserve Execution, Contract, and Log as progressive Inspector lenses; exact
  Git source and Copy focused link remain compact utilities, not navigation.
- Use one small icon system: 16px, 1.6px stroke, rounded joins, no filled
  illustrations. Use system UI and system monospace fonts only.

## Review states

The standalone prototype uses current repository Ticket names and contains:

- a selected READY visual-proposal Ticket with its complete causal cone;
- a BLOCKED human-decision Ticket carrying an UPCOMING attention badge;
- READY Rooms and integration work, DONE/ARCHIVED foundations, a REFINE card,
  a DEVIATED card, a selected relation, exact-source utility, compact overview,
  and a populated Inspector;
- empty and narrow responsive states available through the prototype controls
  and responsive layout.

Review it at 1440×960, 1180×820, and 390×844. At 390px the graph remains the
background object, controls become 44px targets, and the Inspector becomes a
bottom sheet rather than replacing the canvas.

## Mechanical annotations

[`tokens.json`](tokens.json) is the concrete token contract.
[`state-matrix.json`](state-matrix.json) defines the two independent state
axes and their combined truth table. Automated validation checks the required
token families, the five operational states, four attention states, redundant
labels/icons, minimum text contrast, reduced motion, actual repository labels,
and the three review viewport contracts.

Production files under `skills/vibehub-ticket-review/assets/` are deliberately
unchanged by this proposal Ticket.
