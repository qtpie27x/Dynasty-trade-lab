# Dynasty Trade Lab — iPhone / Vercel Version

This is a separate deployment-ready copy of Dynasty Trade Lab V1.
The original `dynasty-trade-lab-v1` folder is unchanged.

## What changed

The original V1 uses a persistent local Node server. This version moves the external-data proxy into Vercel serverless functions, so after deployment:

- You can open the site from Safari on your iPhone.
- Your computer does not need to stay on.
- Sleeper league data and FantasyCalc values still load live.
- You can add the site to your iPhone Home Screen.

## Deploy with Vercel (easiest)

1. Create a free GitHub account if you do not already have one.
2. Create a new GitHub repository, for example `dynasty-trade-lab`.
3. Upload the CONTENTS of this folder to that repository.
   `index.html`, `app.js`, `styles.css`, `vercel.json`, and the `api` folder
   should all be at the repository root.
4. Sign in to Vercel with GitHub.
5. Choose **Add New > Project** and import the GitHub repository.
6. Leave the framework preset as **Other** if Vercel does not select one.
7. Deploy. There are no environment variables required for V1.
8. Vercel will give you a public address such as:
   `https://your-project-name.vercel.app`

## Add to your iPhone Home Screen

1. Open the deployed URL in Safari.
2. Tap the Share button.
3. Choose **Add to Home Screen**.
4. Name it `Trade Lab` or anything you prefer.
5. Tap Add.

It will then launch from your Home Screen in a standalone app-like view.

## API endpoints

- `/api/league?id=LEAGUE_ID`
- `/api/league?id=LEAGUE_ID&resource=rosters`
- `/api/league?id=LEAGUE_ID&resource=users`
- `/api/league?id=LEAGUE_ID&resource=traded_picks`
- `/api/values?numQbs=2&numTeams=12&ppr=1`

## Data sources

- Sleeper public read-only API
- FantasyCalc current dynasty values API

No Sleeper password or API secret is stored by this V1.

## Important

This package is ready for deployment, but ChatGPT cannot create the Vercel account or choose a public domain on your behalf without access to an authorized hosting account. Once you deploy this folder, it becomes the iPhone-accessible version.
