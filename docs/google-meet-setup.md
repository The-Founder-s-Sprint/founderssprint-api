# Google Meet Integration — Setup Guide

Follow these steps to connect The Founder's Sprint platform to Google Calendar + Meet. This enables the dashboard to create coaching sessions with auto-generated Google Meet links.

---

## Step 1: Set Up Google Workspace

You said you're doing this tomorrow. When you create the Workspace account under `founderssprint.co`:

1. Go to [admin.google.com](https://admin.google.com) and complete the Workspace setup
2. Create email accounts for the founding coaches:
   - `teddy@founderssprint.co` (admin)
   - `barry@founderssprint.co`
   - `moses@founderssprint.co`
   - `joseph@founderssprint.co`
   - `patrick@founderssprint.co`
3. Optionally create a shared calendar account: `sessions@founderssprint.co` — this will be the account that owns all coaching session calendar events. Using a dedicated account keeps coach personal calendars clean and gives the platform a single calendar to manage.

---

## Step 2: Create a Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Sign in with your `teddy@founderssprint.co` Workspace admin account
3. Click the project dropdown (top left, next to "Google Cloud") → **New Project**
4. Name it: `founders-sprint-platform`
5. Organisation: select your `founderssprint.co` org (it should appear automatically since you're on Workspace)
6. Click **Create**
7. Wait for the notification that the project is ready, then select it from the project dropdown

---

## Step 3: Enable the Google Calendar API

1. In the Google Cloud Console, go to **APIs & Services → Library** (left sidebar)
2. Search for "Google Calendar API"
3. Click on it → click **Enable**
4. Wait for it to activate (takes a few seconds)

---

## Step 4: Create a Service Account

A service account is a bot identity that the API uses to create calendar events on behalf of coaches. No human logs in — the server uses a key file.

1. Go to **APIs & Services → Credentials** (left sidebar)
2. Click **+ Create Credentials** → **Service Account**
3. Name: `fs-session-scheduler`
4. Description: "Creates Google Calendar events with Meet links for coaching sessions"
5. Click **Create and Continue**
6. Skip the "Grant this service account access" step (click **Continue**)
7. Skip "Grant users access" (click **Done**)
8. You'll see the service account in the credentials list. Click on its email (looks like `fs-session-scheduler@founders-sprint-platform.iam.gserviceaccount.com`)
9. Go to the **Keys** tab
10. Click **Add Key → Create New Key**
11. Select **JSON** → click **Create**
12. A `.json` file will download. **This is your credential file — keep it safe, never commit it to git.**

---

## Step 5: Enable Domain-Wide Delegation

This lets the service account create calendar events on behalf of any `@founderssprint.co` user (i.e., act as `sessions@founderssprint.co` to create events on coach calendars).

### In Google Cloud Console:

1. Go back to **APIs & Services → Credentials**
2. Click on your service account (`fs-session-scheduler`)
3. Under **Details**, find the **Unique ID** (a long number like `118234567890123456789`). Copy it.
4. Check the **"Show Advanced Settings"** section — enable **Domain-wide Delegation** if there's a checkbox. If not, proceed to the Admin Console step below.

### In Google Workspace Admin Console:

1. Go to [admin.google.com](https://admin.google.com)
2. Navigate to **Security → Access and data control → API controls**
3. Click **Manage Domain Wide Delegation** (at the bottom)
4. Click **Add new**
5. **Client ID**: paste the service account's Unique ID from step 5.3
6. **OAuth scopes**: paste this exact string (one line, comma-separated):

```
https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/calendar.events
```

7. Click **Authorize**

---

## Step 6: Add Credentials to Vercel

1. Open the downloaded JSON key file in a text editor
2. Go to [vercel.com](https://vercel.com) → your `founders-sprint-api` project → **Settings → Environment Variables**
3. Add these variables:

| Variable | Value | Notes |
|----------|-------|-------|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | The service account email (e.g., `fs-session-scheduler@founders-sprint-platform.iam.gserviceaccount.com`) | From the JSON file's `client_email` field |
| `GOOGLE_PRIVATE_KEY` | The private key from the JSON file | Copy the entire `private_key` value including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`. Vercel handles the newlines. |
| `GOOGLE_CALENDAR_DELEGATE` | `sessions@founderssprint.co` (or `teddy@founderssprint.co` if you skip the shared account) | The Workspace user the service account impersonates when creating events |

4. Make sure all three are set for **Production** environment
5. Redeploy the API (push any commit, or click Redeploy in Vercel)

---

## Step 7: Test

Once the API is deployed with credentials, test from the admin dashboard:

1. Log in at `learn.founderssprint.co/admin/dashboard`
2. Go to the **Sessions** tab (or section)
3. Select a coach, add a founder email, pick a date/time
4. Click "Schedule Session"
5. Verify:
   - The API returns a Google Meet link
   - A calendar event appears on the coach's Google Calendar
   - The founder receives a calendar invite at their email
   - The Meet link works (click it, should open Google Meet)

---

## Troubleshooting

**"Delegation denied" or "Not authorized"**
- The domain-wide delegation step wasn't completed, or the scopes don't match exactly. Re-check Step 5.

**"Calendar API has not been enabled"**
- Go back to Step 3 and enable the API in the correct project.

**"Invalid grant"**
- The `GOOGLE_PRIVATE_KEY` env var may have formatting issues. Make sure the entire key (including BEGIN/END markers) is pasted correctly.

**Events created but no Meet link**
- The `conferenceDataVersion` parameter must be set to `1` in the API call. The code handles this — if you see this issue, check that the googleapis package is up to date.

**Coach doesn't see the calendar event**
- Make sure the coach's `@founderssprint.co` email is listed as an attendee in the API call. The service account creates the event on the delegate calendar and invites the coach.
