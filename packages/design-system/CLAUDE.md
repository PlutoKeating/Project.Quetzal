# Quetzalcoatl — hard rules

These are not preferences. A design that breaks one of them is not Quetzalcoatl.

1. **The page is `#000000`.** Never a dark grey, never a gradient ground, never a light mode.
2. **96% of every screen has zero saturation.** The only two hues are Ice `#BAE6FD` and Tungsten Amber `#E5A03D`. No green, red, blue or purple, including for success and error states. The single exception is the spectrum wordmark (`.qz-wordmark`): the brand or owner name, in the nav bar and at most once in a display headline per page. Its six `--qz-spectrum-*` colours are never used for anything else.
3. **Colour is meaning.** Ice = verified, active, automatic, done. Amber = a human speaking, needs a human, drift, manual. Never use either as decoration, and never as the only signal.
4. **Light is fixed and faint.** One viewport-fixed optical horizon per page; ice alpha at most 0.14, amber at most 0.11. Specular lines are always 1px. Only a 6px LED or the active tick may glow.
5. **Hairlines, not boxes.** No cards, no bordered tiles, no filled panels. Group with 1px low-alpha white lines and whitespace; use `.qz-rail` where cards would go.
6. **No bold.** Display and heading weight is 500. Weight 600 is for the wordmark and numbered pins only. Never load 700 or above.
7. **The only solid is white.** One white primary button per view. Buttons are never pill-shaped, never coloured, never shadowed.
8. **One shadow, three blurs.** The popover shadow is the only shadow. Backdrop blur is allowed on the nav bar and the showcase stage, nowhere else.
9. **Only opacity and colour change.** 120–180ms. Nothing slides, scales, bounces or animates in. Honour `prefers-reduced-motion` by staying fully lit and still.
10. **Legibility first.** Body contrast at least 4.5:1, a visible focus ring on every control, generous leading. When atmosphere and readability conflict, readability wins.
11. **Use the tokens.** Take values from `tokens/` and classes from `components/components.css`. If something needed is missing, add it to the system and document it rather than hard-coding it in a product.
