# ChampHR restricted admin surfaces and theme icon

## 1. Visual theme and atmosphere
Keep the existing internal Timeline workspace. This is a scoped access-control and control simplification, not a rebrand.

## 2. Color palette and roles
Use existing ess-tokens.css only. Theme icon uses --ess-text on --ess-surface; hover uses --ess-surface-hover. Dark theme resolves these tokens to explicit light ink and dark ground.

## 3. Typography rules
Existing IBM Plex Sans controls and Newsreader page headings remain unchanged. No new text style.

## 4. Component stylings
One native round theme button between announcements and account. Moon in light, sun in dark. Dynamic action label and title. Visible focus ring uses --ess-primary. No duplicate theme control in account menu.

21st.dev candidates inspected: campsite Theme Toggle id 554 (three radio previews, React/next-themes, incompatible structure), ayushmxxn Theme Toggle id 1216 (binary sun/moon toggle). Kokonut query returned these candidates, no independent matching single-icon control. Adapt id 1216 to the existing Svelte control and ESS tokens under the same app's approved Svelte-native exception recorded on sibling t_1e1c989e. No React, next-themes or new dependencies. Source: https://21st.dev/@ayushmxxn/components/theme-toggle. Native button replaces demo div for keyboard semantics; one icon replaces the two-icon pill; existing persistence replaces demo state.

## 5. Layout principles
Keep existing topbar flow. Use 44px theme target instead of spec's 38px visual target to meet mobile accessibility. No sibling navigation or roster changes.

## 6. Depth and elevation
Reuse .round surface and shadow. No new motion or layers.

## 7. Do and do not
Keep essTheme and app.html pre-paint untouched. Do not remove employee policy reading. Ignore legacy forbidden grants without deleting records. Admin publishing still requires policies.publish. Design tweaks is super_admin-only.

## 8. Responsive behavior
Device class: pointer and touch web UI. Verify at 375, 768 and 1440. Icon must remain visible, no horizontal page scroll. Motion budget: no new animation, existing reduced-motion branch retained.

## 9. Agent prompt guide
Minimize diff to effective capability resolution, shared guards/cache, tab labels and theme control. Review sibling TopBar/admin-tabs patches at root integration. No auth model, route, database or page-internal changes.
