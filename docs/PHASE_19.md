# Phase 19: passenger experience and platform settings

Phase 19 adds one authoritative preferences model that the passenger and driver apps, the notification service and
the API all consume, plus the account tools around it (devices, recent destinations). It extends what already
existed (saved places, emergency contacts, sessions, the platform settings store and its admin screens, the
notification service, the theme hook) and adds nothing parallel to any of them.

## What was built

| Brief                         | Where it is                                                                                                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One preferences model         | `PREFERENCE_DEFS` in `@yatri/types` `preferences.ts`: every setting's key, group, words, allowed values, default and which roles it is for. The API validates against it, stores only what the person chose (`user_preferences`), the apps draw their settings screen from it |
| Appearance, accessibility     | theme, text size, larger buttons, reduced motion, "read ride updates aloud": consumed by the shared `useTheme` and shared components through one context (`@yatri/mobile-ui` `uiPreferences`)                                                                                 |
| Language                      | `language` with `LANGUAGES`: a language is listed but cannot be chosen until the apps have words for it (only English today). The default comes from the platform setting `DEFAULT_LANGUAGE`                                                                                  |
| Notification preferences      | one switch per optional category (`NOTIFICATION_CATEGORIES`); `notificationCategoryOf` is the one type-to-category mapping; `lib/notifications` `notify()` reads it through `shouldDeliver`. Safety and account categories cannot be switched off                             |
| Privacy settings              | "name shown to your driver" (full or first name only, applied by the ride summary the driver sees), "suggest recent destinations", and "clear my recent destinations"                                                                                                         |
| Safety preferences            | "ask before sending an emergency alert" (read by the shared SOS panel) and "remind me to share my trip". Trusted contacts stay in the emergency-contacts module and are linked, not copied                                                                                    |
| Default vehicle and payment   | `defaultVehicle` (checked by the server against the types on offer) is the first suggestion in the request screen; `defaultPayment` is cash, the only personal method. Neither changes a price or a rule                                                                      |
| Saved and recent locations    | saved places keep their module; `GET /users/me/recent-places` derives recent destinations from the person's own rides (nothing stored twice), and the location picker offers them                                                                                             |
| Account and device management | `GET /users/me/devices`, sign one device out, sign out every other device (audited as `SESSION_REVOKED` in the auth events); account deletion and data export stay in the compliance module and the export now includes the settings                                          |
| Platform settings service     | the existing store (`PLATFORM_SETTINGS`, `getSetting`, admin Settings screens, `SETTINGS_VIEW` / `SETTINGS_MANAGE`, versioned edits, audited). New group "Passenger experience": `DEFAULT_LANGUAGE`, `RECENT_PLACES_LIMIT`. Text settings can now list their allowed values   |

## One model, many devices

- **Where it lives.** One row per person, holding only the choices they made. A default that changes (the platform
  default language) reaches everyone who has not chosen, because defaults are never copied into the row.
- **Several devices.** Every device reads the same row. Each save quotes the version it was based on and is applied
  under a row lock, so of two devices saving from the same version one wins and the other is told to look again (409,
  with the current settings). Apps re-read when they return to the foreground; there is no push of settings to a
  device that stays open and idle.
- **The server does not trust a client.** A preference is never a business rule: fares, cancellation, matching,
  who may book and what is paid come from the server whatever a client sends, and a setting that is not in the table
  (or not for the person's role) is refused. A saved default vehicle changes only what is suggested first.

## What the server enforces, and what the apps read

Enforced by the server (`server: true` in the table): which notifications are pushed, how a passenger's name is shown to
a driver, whether recent destinations are offered, and that a preferred vehicle is one on offer. Read by the apps:
theme, text size, larger buttons, reduced motion, speaking updates, confirming the emergency alert, the trip-sharing
reminder and language. Text size and larger buttons apply to the shared components (buttons, cards, announcements,
facts) and the theme; some screens that set their own fixed sizes do not scale yet.

## Privacy

Preferences are the person's own. No administrator screen or route reads them (a test checks the admin user page).
A notification a person switched off is still recorded in their history, marked `suppressed`, and not pushed.
Recent destinations leave out rides someone else booked for the person. The settings are removed with the account's
personal data and are part of the personal-data export.

## Not done, honestly

- Only English exists, so "language" is a choice of one; Nepali is listed as not translated yet.
- There is no motion in the apps today, so "reduced motion" is stored and exposed (`useTheme().reducedMotion`) but nothing
  changes yet. It is ready for the first animation to read it.
- No quiet hours, no per-channel (push, SMS, e-mail) notification controls: only the pushed/not-pushed choice per category.
  There is no push provider yet (only the console one), so nothing real is pushed anyway.
- Settings reach other devices on the next foreground or reload, not live.
- Nothing here was tried on a device or with a screen reader; the checks are the automated tests, static accessibility
  checks, and the manual list (section R of `ACCESSIBILITY_TESTING.md`).
