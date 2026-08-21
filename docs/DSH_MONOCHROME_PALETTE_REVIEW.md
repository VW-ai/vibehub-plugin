# DSH monochrome palette review

Status: rough HTML color study. It does not modify the production DSH Bundle,
the accepted shell interaction prototype, or the future whole-application
visual-system contract.

The owner correction is the premise: explore a **black-and-white application**,
not five competing accent colors. Every option therefore uses the same Shell,
Chat, Task Graph, Task Workspace, content, spacing, card geometry and state
language. Only the declared color tokens change.

## Directions

### 1. True Black

- Intent: OLED black, hard white, minimum visible chrome.
- Strength: strongest focus and the most literal black/white identity.
- Risk: very high contrast can become severe during long Chat and execution
  sessions.
- Best use: canvas-heavy or distraction-free modes if it is not selected for
  the complete application.

### 2. Graphite — Agent recommendation

- Intent: neutral charcoal with an almost imperceptible cool cast.
- Strength: closest to the restraint of Codex while keeping dense hierarchy
  readable for long sessions.
- Risk: it is the safest option and may need brand personality from type,
  motion and icon craft rather than color.
- Best use: the default whole-application foundation.

### 3. Soft Black

- Intent: lifted black and softened white without gray-paper styling.
- Strength: comfortable, calm and forgiving across Chat, Settings and dense
  Task surfaces.
- Risk: can feel flat if elevation and borders are not disciplined.
- Best use: users who find True Black visually tiring.

### 4. Cool Mono

- Intent: blue-black neutrals, but no visible blue accent.
- Strength: precise and technical while still reading as monochrome.
- Risk: it may reproduce the blue-gray character the owner already rejected.
- Best use: a reference boundary, not the current recommendation.

### 5. Warm Mono

- Intent: brown-black neutrals and warm white without sepia, paper texture or
  editorial styling.
- Strength: more human and less sterile than cool graphite.
- Risk: too much warmth would turn the product toward the editorial direction
  the owner rejected.
- Best use: testing whether a barely warm neutral improves long-session feel.

## Controlled comparison

The full-size view switches Graph, native Chat and Task Workspace while
preserving all geometry. `Compare all` shows the same miniature Shell for all
five options. Keys `1`–`5` select a palette, `G`/`H`/`T` select Graph, Chat and
Task, and `C` toggles the overview. The page is loopback-only, accepts only
`GET` and `HEAD`, stores no browser state and has no repository write route.

Task state remains primarily textual and structural. Monochrome luminance,
line weight and selection surface provide secondary reinforcement; the study
does not create five state colors or rely on color alone.

## Decision boundary

The Agent recommendation is **Graphite** as the base because it balances the
owner's black/white preference with long-session comfort. This is not human
approval. An explicit owner preference may name one option, combine one exact
property from two options, or reject all five. That preference becomes Context
for refinement of `ticket-build-dsh-whole-application-visual-system`; it does
not by itself approve the future installed Profile or bypass the separate
whole-application visual review.
