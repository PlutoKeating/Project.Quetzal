---
name: quetzalcoatl-design
description: Use this skill to design or build anything in the Quetzalcoatl brand, "五彩斑斓的黑" (iridescent black) — a pitch-black, strictly monochrome interface lit only by a fixed ice/amber optical horizon and 1px specular lines. Contains the tokens, component CSS, optical-response script, diagram grammar and a live specimen page, all extracted from the shipped UltraCode website.
user-invocable: true
---

Read `README.md` in this folder first, then `AGENTS.md` for the hard rules. Open `guidelines/components.md` before building UI and `guidelines/diagrams.md` before drawing any diagram. `Showcase.html` is the live reference: when unsure how something should look, match it.

For production code, import `styles.css` (or copy `tokens/`, `components/components.css` and `scripts/optics.js` into the project) and use the `--qz-*` tokens and `.qz-*` classes as they are. Do not restate the values by hand and do not invent new colours. The six `--qz-spectrum-*` colours belong to the `.qz-wordmark` name treatment only.

For throwaway mocks, slides or prototypes, write static HTML that links `styles.css`, with `.qz-optical-horizon` and `.qz-grain` as the first two children of `<body>`.

If invoked without further guidance, ask what is being built and who it is for, then act as the brand's designer and deliver HTML or production code as the situation needs.
