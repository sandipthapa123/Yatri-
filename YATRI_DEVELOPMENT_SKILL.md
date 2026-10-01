# Yatri development skill (index)

This file only points to where the rules live. It holds no rule of its own, so it cannot drift.

1. `CLAUDE.md`: the project rules and standing constraints.
2. `.claude/skills/single-source-of-truth/SKILL.md`: the SSOT rule and the list of what owns what.
3. `docs/ARCHITECTURE.md`: the owner table (one row per concept: where it is defined and who may write it).
4. `docs/SECURITY.md`, `docs/ACCESSIBILITY_TESTING.md`, `docs/OPERATIONS.md`: the controls, the manual accessibility checks and the runbook.
5. `docs/PHASE_<n>.md`: what each phase built, its decisions and what it honestly did not do.

Working rules, in short: one definition per state, type, rule, calculation, event and API; the backend is authoritative;
accessibility is mandatory (keyboard, screen reader, no colour-only meaning); location and personal data are sensitive;
never claim a feature complete unless it is built and tested, and say plainly what was not verified; every commit ends with
the Co-Authored-By trailer; push to the existing origin only.
