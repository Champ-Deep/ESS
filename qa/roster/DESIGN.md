# ChampHR roster navigation contract

## 1. Visual theme and atmosphere
Preserve PRODUCT.md and the current ESS workspace. This card changes information architecture, not the product's theme. Parent spec forbids visual restyling and database or route changes.

## 2. Color palette and roles
Use existing --ess-text for the chip and avatar initials, --ess-text-secondary for overflow count, --ess-surface for count ground and --ess-canvas for face outlines. Keep both inherited palettes. No new color values.

## 3. Typography rules
Keep the current application typography. Team chip label is 13px; overflow count is 11px and weight 600. Profile reuses ess-h2, plain and ess-btn classes.

## 4. Component stylings
Reuse Avatar, the existing sidebar, and existing ESS card/button classes per the approved component-reuse ruling on t_d92e8a16. Up to four sm avatars overlap by 8px. Additional people are +N. Link accessible name includes the total. Profile link and Home chip have a minimum 44px height. Existing shared focus-visible styling remains in force.

## 5. Layout principles
Home owns the team chip beside Apply leave. Profile owns a Reports to card above the existing aside content. Team owns the directory and schedules. No second roster or new query is introduced.

## 6. Depth and elevation
Keep the current ESS surface system. Face outlines use a 2px canvas-colored ring. No additional page shadows or effects.

## 7. Do and do not
Follow spec items 4, 6, 11 and 12. Remove top-bar roster entry points and obsolete props/CSS. Keep server gates and embedded admin labels. Do not change sibling Display, theme, disclosure or admin-navigation work.

## 8. Responsive behavior
Device class: pointer surface with touch-phone support. Hide Home's chip below 960px as specified. The rail and gated Profile link remain available. Verify 375, 768, 960 and 1440. No new animation; inherited reduced-motion behavior remains. No WebGL or motion budget is required.

## 9. Agent prompt guide
Keep /dashboard, /profile, /team and ?view=weekoff intact. Preserve canTeam and existing teamPeek loading. No redirects are needed because no routes move. The existing embedded /admin/people surface is deliberately retained by the spec.
