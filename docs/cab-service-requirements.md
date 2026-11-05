# Company Cab Service: Requirements Intake

**Status:** waiting for answers. Nothing has been built yet.
**Opened:** 6 Nov 2026

Champions has 6–8 company cabs, and only female employees may use them. We plan to add a cab module to ESS so that:

1. employees book their login (coming) and logout (leaving) cabs in advance from the portal,
2. routes and timings are optimised so the cabs are used as fully as possible, and
3. drivers get a simple app for their trip sheet, OTP boarding, live location and SOS.

Before we can design it, we need the facts below from Admin, HR and Transport.

## How to fill this in

- Write your answer under each **Answer:** line. A rough answer is fine. "Don't know" is also fine; it tells us what to chase.
- If a sheet or document holds the answer (cab list, roster, trip sheets), attach it in the same folder or link it, and note the file name.
- Commit your edits to this branch, or send them to the dev team.

---

## A. Office and legal

**A1. Office address(es).** Is there one office the cabs serve, or more? Give the full address and, if possible, a Google Maps pin link.

> Answer:

**A2. State.** Which state is each office in? Women-safety rules for night transport differ by state; see Appendix A.

> Answer:

**A3. Night shifts.** Do women work or travel between roughly 8pm and 6am? Do we already have their written consent on file? National law has required that consent since Nov 2025.

> Answer:

**A4. Security guards or escorts.** Do any cabs carry a guard today? On which trips or hours? Are female guards available?

> Answer:

**A5. Current transport policy.** Is there a written transport or night-shift policy? Please attach it.

> Answer:

## B. Fleet and drivers

**B1. Cab list.** Fill one row per cab.

| # | Registration no. | Make / model | Seats (excluding driver) | Owned or vendor? | Fixed driver (name) | GPS / CCTV fitted? |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |
| 6 | | | | | | |
| 7 | | | | | | |
| 8 | | | | | | |

**B2. Driver duty hours.** What are each driver's hours? What are the maximum hours a day, and the required breaks? Do drivers change between day and night?

> Answer:

**B3. Driver phones.** Does every driver have an Android smartphone with mobile data? Who pays for the data? Are they comfortable using apps?

> Answer:

**B4. Driver language.** Which language should the driver app use (English, Hindi, Kannada, Telugu, Marathi, other)?

> Answer:

**B5. Driver verification.** Have all drivers had police verification and background checks? Who holds the records?

> Answer:

**B6. Costs.** Roughly what does each cab cost per km, or per month (fuel, driver, vendor rate)? We use this to show savings from better routing.

> Answer:

## C. Riders and shifts

**C1. Who may use the cabs.** Is it all female employees, or only some (night shift, certain teams, a distance limit)? Note: most ESS profiles have no gender recorded, so we plan to have HR mark who is eligible with a separate "cab eligible" flag. Is that OK?

> Answer:

**C2. Riders per day.** Roughly how many employees use the cabs on a typical day? How many at peak?

> Answer:

**C3. Shift timings.** List every login and logout time in use, and roughly how many cab users there are at each.

| Shift name | Login time | Logout time | Cab users (approx.) |
|---|---|---|---|
| | | | |
| | | | |
| | | | |

**C4. Current process.** How are cabs arranged today (WhatsApp, Excel, a transport person)? Please share any existing trip sheets or rosters, even a month of them; we can use them to test the routing.

> Answer:

**C5. Home locations.** ESS stores each employee's address only as free text. Can employees drop a map pin for their home once, with HR or Transport checking it? Who is allowed to see employees' home locations?

> Answer:

**C6. Service area.** Is there a maximum distance from the office we serve, or areas we do not serve?

> Answer:

## D. Booking rules

**D1. Booking cut-off.** How far in advance must a cab be booked? Common practice elsewhere is the night before for morning (login) trips and 2–4 hours ahead for evening (logout) trips.

> Answer:

**D2. Recurring bookings.** Should employees be able to set a standing weekly booking (e.g. Mon–Fri, 9:00 in and 18:00 out) and only change the exceptions?

> Answer:

**D3. Cancellation.** How late can a booking be cancelled without counting as a no-show?

> Answer:

**D4. No-show policy.** What happens when someone books but doesn't turn up? The industry example is a warning at 3 no-shows and booking rights paused at 5 within 30 days, with a manager able to restore them.

> Answer:

**D5. Last-minute (ad-hoc) requests.** Can someone ask for a cab with less than the cut-off notice (late stay, emergency)? Who approves it?

> Answer:

**D6. Maximum ride time.** What is the longest acceptable time any one rider spends in the cab (e.g. 60 or 75 minutes)?

> Answer:

**D7. Waiting time.** How long does a cab wait at a pickup before marking a no-show (e.g. 3–5 min)?

> Answer:

**D8. Timing flexibility.** May the system suggest a slightly different time to share a cab that's already going (e.g. "leave at 18:45 instead of 19:00")? Up to how many minutes?

> Answer:

## E. Safety

**E1. Night drops.** Must the driver wait until the employee is inside her home? Should she confirm in the app that she's safe ("safe reach")?

> Answer:

**E2. SOS.** If an employee or driver presses SOS, who gets alerted (names and phone numbers, available 24x7)?

> Answer:

**E3. Phone privacy.** Should drivers and employees see each other's real phone numbers, or should calls be masked?

> Answer:

**E4. Alerts.** Which alerts do you want: route deviation, unscheduled stop, speeding, GPS off?

> Answer:

## F. Operations and access

**F1. Transport admin.** Who runs the cabs day to day (approves exceptions, edits routes, watches SOS)? We will add a "Transport admin" role in ESS for them.

> Answer:

**F2. Reports.** Which reports matter (seat fill %, empty km, on-time %, cost per trip, no-shows by person)? Who should receive them, and how often?

> Answer:

## G. Technical (dev team / IT)

**G1. Maps.** Do we use a paid maps API key (Ola Maps or Google Maps) with a monthly budget? Or should we self-host free OpenStreetMap routing (OSRM) on our own server, which has no live traffic?

> Answer:

**G2. Hosting.** ESS runs on Railway. The repo also has Cloudflare Workers branches (`feat/cloudflare-migration`, `feat/cloudflare-workers-native`, `wip/workers-rewrite`). The routing engine (VROOM) and OSRM need a container, so which platform should the cab module target?

> Answer:

**G3. Driver app.** For live GPS, choose one:
- **Option 1, fastest:** drivers install the free Traccar Client app for tracking, and use an ESS web page for everything else.
- **Option 2:** a small ESS Android app with background GPS. It would be sideloaded or installed through device management, not published on the Play Store.

> Answer:

**G4. Code delivery.** Should the cab module be built on a branch and submitted as a PR to `developer00777/ESS`?

> Answer:

---

## Appendix A: Women-safety rules by state (research, Nov 2026, needs checking)

Most of these come from secondary sources, so confirm with legal or HR for our state.

| State | Night window | Main conditions |
|---|---|---|
| National (OSH Code s.43, in force 21 Nov 2025) | before 6am / after 7pm | Woman's consent; each state adds its own conditions |
| Haryana / Gurugram (May 2025) | 8pm–6am | Guard in every vehicle (including a female guard), trained driver, CCTV, GPS |
| Delhi (Oct 2025) | night | Written consent, safe transport, CCTV kept 1 month, female security staff |
| Maharashtra | 9:30pm–7am | Consent, secure transport, guards, at least 3 women per shift |
| Telangana | 8:30pm–6am | Consent, guards, driver background screening |
| Tamil Nadu | 8pm–6am | Consent, transport, safety conditions (establishments with 10+ staff) |
| Karnataka | — | The 2007 conditions required a guard when a woman is first pickup or last drop. A 2026 amendment reportedly removes these conditions; this rests on one source and needs verifying |
| Uttar Pradesh | 7pm–6am (factories) | Transport with guards and CCTV |

Because every rider is a woman, the common rule "a woman is never first pickup or last drop" can never be met. Wherever a guard is required, every night trip needs one, and the guard takes a seat (a 4-seat sedan carries 3 employees).

## Appendix B: Inspiration and proposed approach (draft)

**What others do:**
- **MoveInSync:** roster booking, auto-routing, OTP/QR boarding, a three-step safe-reach check, tampering and deviation alerts. Its no-show engine (warn and pause booking rights, missed login cancels the logout trip, manager restores) is the model for D4.
- **Safetrax:** the routing engine itself refuses unsafe routes, such as a night trip without an escort.
- **Routematic and Uber Shuttle:** build fresh routes daily from bookings.
- **TripShot:** a booking counts only once the rider has boarded; drivers do a vehicle checklist in the app.

**Proposed approach (to be confirmed once the answers above are in):**
- **Routing:** VROOM (open source, run in Docker), which plans routes with seats, time windows, a cap on ride time and "needs a guard". A cab can do several runs per shift wave.
- **Travel times:** from OSRM or a maps API, stored and reused per H3 hexagon (Uber's hexagonal grid, about 200 m cells) and per hour of the week, to keep map costs low.
- **H3 also gives:** reports that show an area rather than a home address, demand heatmaps by area and time slot, and an "arrived" check.
- **Using what ESS already knows:**
  - approved leave cancels that day's cab automatically,
  - suggested standing bookings learnt from biometric punch times,
  - no-shows checked against attendance (a punch-in shows she came another way),
  - safe-reach and alerts sent with ESS's existing web-push notifications.
- **Drivers:** they already exist in ESS as staff without a login. We would add phone-OTP sign-in and a single trip-sheet screen: start and end trip, OTP boarding, safe drop, SOS.
- **Phases:**
  1. Booking and manual dispatch.
  2. Automatic routing and time suggestions.
  3. Live tracking, safe-reach and alerts.
  4. Reports.
